use super::*;
use std::fs::{File, OpenOptions};
use std::io::Write;

// The authenticated header binds the key bundle to this vault and exact KDF settings.
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct EnvelopeHeader {
    format: u32,
    vault_id: String,
    generation: u64,
    kdf: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VaultMeta {
    header: EnvelopeHeader,
    nonce: String,
    wrapped_keys: String,
}

pub(super) fn random_keys() -> KeySet {
    let mut keys = KeySet {
        db: Zeroizing::new([0; 32]),
        field: Zeroizing::new([0; 32]),
        identity: Zeroizing::new([0; 32]),
    };
    OsRng.fill_bytes(&mut *keys.db);
    OsRng.fill_bytes(&mut *keys.field);
    OsRng.fill_bytes(&mut *keys.identity);
    keys
}

pub(super) fn validate_new_password(password: &str) -> ApiResult<()> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err(bad_request(
            "主密码至少需要 12 个字符，且不能超过 1024 个 UTF-8 字节",
        ));
    }
    Ok(())
}

fn wrapping_key(password: &str, header: &EnvelopeHeader) -> ApiResult<Zeroizing<[u8; 32]>> {
    if header.format != 1
        || header.kdf != "argon2id"
        || header.memory_kib != 65536
        || header.iterations != 3
        || header.parallelism != 1
        || header.generation == 0
        || Uuid::parse_str(&header.vault_id).is_err()
    {
        return Err(bad_request(
            "不支持该密钥封装格式或密钥派生参数",
        ));
    }
    let salt = hex::decode(&header.salt).map_err(|_| bad_request("密钥封装的盐值无效"))?;
    if salt.len() != 16 || password.len() > 1024 {
        return Err(bad_request("密码长度或密钥封装的盐值无效"));
    }
    let params = argon2::Params::new(
        header.memory_kib,
        header.iterations,
        header.parallelism,
        Some(32),
    )
    .map_err(internal)?;
    let mut root = Zeroizing::new([0; 32]);
    Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut *root)
        .map_err(internal)?;
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(&salt), &*root)
        .expand(b"securevault/key-wrapping/v1", &mut *key)
        .map_err(internal)?;
    Ok(key)
}

pub(super) fn wrap_keys(
    password: &str,
    keys: &KeySet,
    previous: Option<&VaultMeta>,
) -> ApiResult<VaultMeta> {
    validate_new_password(password)?;
    let mut salt = [0; 16];
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let header = EnvelopeHeader {
        format: 1,
        vault_id: previous
            .map(|m| m.header.vault_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        generation: previous
            .map(|m| m.header.generation.checked_add(1))
            .unwrap_or(Some(1))
            .ok_or_else(|| bad_request("密钥封装版本号已达到上限"))?,
        kdf: "argon2id".into(),
        memory_kib: 65536,
        iterations: 3,
        parallelism: 1,
        salt: hex::encode(salt),
    };
    let key = wrapping_key(password, &header)?;
    let mut bundle = Zeroizing::new([0; 96]);
    bundle[..32].copy_from_slice(&*keys.db);
    bundle[32..64].copy_from_slice(&*keys.field);
    bundle[64..].copy_from_slice(&*keys.identity);
    let aad = serde_json::to_vec(&header).map_err(internal)?;
    let ciphertext = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*key))
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &*bundle,
                aad: &aad,
            },
        )
        .map_err(internal)?;
    Ok(VaultMeta {
        header,
        nonce: hex::encode(nonce),
        wrapped_keys: hex::encode(ciphertext),
    })
}

pub(super) fn unwrap_keys(password: &str, meta: &VaultMeta) -> ApiResult<KeySet> {
    let nonce = hex::decode(&meta.nonce).map_err(|_| bad_request("密钥封装的随机数无效"))?;
    let ciphertext =
        hex::decode(&meta.wrapped_keys).map_err(|_| bad_request("密钥封装的密文无效"))?;
    if nonce.len() != 12 || ciphertext.len() != 112 {
        return Err(bad_request("密钥封装长度无效"));
    }
    let key = wrapping_key(password, &meta.header)?;
    let aad = serde_json::to_vec(&meta.header).map_err(internal)?;
    let bundle = Zeroizing::new(
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*key))
            .decrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                ApiError(
                    StatusCode::UNAUTHORIZED,
                    "主密码错误或密钥封装已损坏".into(),
                )
            })?,
    );
    if bundle.len() != 96 {
        return Err(bad_request("数据密钥包无效"));
    }
    let mut keys = KeySet {
        db: Zeroizing::new([0; 32]),
        field: Zeroizing::new([0; 32]),
        identity: Zeroizing::new([0; 32]),
    };
    keys.db.copy_from_slice(&bundle[..32]);
    keys.field.copy_from_slice(&bundle[32..64]);
    keys.identity.copy_from_slice(&bundle[64..]);
    Ok(keys)
}

pub(super) fn read_meta(state: &AppState) -> ApiResult<VaultMeta> {
    let bytes = fs::read(meta_path(state))
        .map_err(|_| ApiError(StatusCode::NOT_FOUND, "保险库尚未初始化".into()))?;
    if bytes.len() > 4096 {
        return Err(bad_request("密钥封装大小无效"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| bad_request("密钥封装格式不受支持或已损坏，请使用新数据目录"))
}

pub(super) fn private_dir(path: &FsPath) -> ApiResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(internal)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path).map_err(internal)?;
    Ok(())
}

// Before rename, every error preserves the old file. After rename the commit happened;
// an fsync failure is returned as a durability warning, never as an ambiguous rollback.
pub(super) fn atomic_meta(path: &FsPath, meta: &VaultMeta) -> ApiResult<bool> {
    atomic_bytes(path, &serde_json::to_vec(meta).map_err(internal)?)
}
fn atomic_bytes(path: &FsPath, bytes: &[u8]) -> ApiResult<bool> {
    atomic_bytes_before_commit(path, bytes, || Ok(()))
}
fn atomic_bytes_before_commit(
    path: &FsPath,
    bytes: &[u8],
    before_commit: impl FnOnce() -> ApiResult<()>,
) -> ApiResult<bool> {
    atomic_bytes_with_sync(path, bytes, before_commit, sync_directory)
}
fn atomic_bytes_with_sync(
    path: &FsPath,
    bytes: &[u8],
    before_commit: impl FnOnce() -> ApiResult<()>,
    sync_parent: impl FnOnce(&FsPath) -> std::io::Result<()>,
) -> ApiResult<bool> {
    let parent = path
        .parent()
        .ok_or_else(|| internal("missing parent directory"))?;
    let temporary = parent.join(format!(".envelope-{}.tmp", Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(internal)?;
        file.write_all(bytes).map_err(internal)?;
        file.sync_all().map_err(internal)?;
        drop(file);
        before_commit()?;
        fs::rename(&temporary, path).map_err(internal)?;
        Ok(sync_parent(parent).is_err())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub(super) fn sync_directory(path: &FsPath) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

pub(super) fn initialize_vault(state: &AppState, password: &str) -> ApiResult<(KeySet, bool)> {
    if state.data_dir.join("vault").exists() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "保险库已经初始化".into(),
        ));
    }
    let staging = state
        .data_dir
        .join(format!(".vault-init-{}", Uuid::new_v4().simple()));
    private_dir(&staging)?;
    let result = (|| {
        let keys = random_keys();
        let meta = wrap_keys(password, &keys, None)?;
        let db = staging.join("securevault.db");
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        drop(options.open(&db).map_err(internal)?);
        let connection = open_database(&db, &keys.db)?;
        initialize_schema(&connection)?;
        drop(connection);
        File::open(&db)
            .map_err(internal)?
            .sync_all()
            .map_err(internal)?;
        atomic_meta(&staging.join("vault.meta.json"), &meta)?;
        sync_directory(&staging).map_err(internal)?;
        fs::rename(&staging, state.data_dir.join("vault")).map_err(internal)?;
        Ok((keys, sync_directory(&state.data_dir).is_err()))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

#[derive(Deserialize, Zeroize, zeroize::ZeroizeOnDrop)]
pub(super) struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
    confirm_password: String,
}

pub(super) async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> ApiResult<Response> {
    validate_new_password(&request.new_password)?;
    if request.new_password != request.confirm_password {
        return Err(bad_request("new password confirmation does not match"));
    }
    if request.current_password == request.new_password {
        return Err(bad_request(
            "new password must differ from current password",
        ));
    }
    let mut runtime = state.runtime.lock().await;
    expire_runtime(&mut runtime);
    if !owner_cookie(&headers, &runtime) {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "owner session is no longer valid".into(),
        ));
    }
    check_password_limit(&runtime)?;
    let old_meta = read_meta(&state)?;
    let keys = match unwrap_keys(&request.current_password, &old_meta) {
        Ok(keys) => keys,
        Err(error) => {
            if error.0 == StatusCode::UNAUTHORIZED {
                password_failure(&mut runtime);
            }
            return Err(error);
        }
    };
    let connection = open_database(&database_path(&state), &keys.db)?;
    connection
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(internal)?;
    let replacement = wrap_keys(&request.new_password, &keys, Some(&old_meta))?;
    // Verify the replacement before publishing it. No database or field keys change.
    let checked = unwrap_keys(&request.new_password, &replacement)?;
    if *checked.db != *keys.db
        || *checked.field != *keys.field
        || *checked.identity != *keys.identity
    {
        return Err(internal("key envelope validation failed"));
    }
    let warning = atomic_meta(&meta_path(&state), &replacement)?;
    // The metadata rename is the commit point. Audit failure cannot undo the password change.
    let audit_warning = connection.execute("INSERT INTO audit_events(event,field_name) VALUES('master_password_changed','key_envelope')", []).is_err();
    runtime.keys = None;
    runtime.session_hash = None;
    runtime.unlocked_at = None;
    runtime.last_activity = None;
    runtime.persistent = false;
    runtime.unlock_failures = 0;
    runtime.unlock_after = None;
    state.batches.lock().await.clear();
    let mut response = Json(json!({"sealed":true,"password_changed":true,"durability_warning":warning,"audit_warning":audit_warning})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("vault_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0"),
    );
    Ok(response)
}

pub(super) fn lock_data_directory(path: &FsPath) -> ApiResult<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path.join(".server.lock")).map_err(internal)?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| {
        ApiError(
            StatusCode::CONFLICT,
            "数据目录正在被其他服务使用，请先停止该服务".into(),
        )
    })?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("samples/.build");
            fs::create_dir_all(&root).unwrap();
            let path = root.join(format!("envelope-test-{}", Uuid::new_v4()));
            private_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn rewrapping_keeps_random_data_keys_and_rejects_old_password_and_tampering() {
        let keys = random_keys();
        assert_ne!(*keys.db, *keys.field);
        let original = wrap_keys("first-password-123", &keys, None).unwrap();
        let replacement = wrap_keys("second-password-456", &keys, Some(&original)).unwrap();
        assert_ne!(original.header.salt, replacement.header.salt);
        assert_ne!(original.nonce, replacement.nonce);
        assert_eq!(original.header.vault_id, replacement.header.vault_id);
        assert_eq!(replacement.header.generation, 2);
        assert!(unwrap_keys("first-password-123", &replacement).is_err());
        let opened = unwrap_keys("second-password-456", &replacement).unwrap();
        assert_eq!(*keys.db, *opened.db);
        assert_eq!(*keys.field, *opened.field);
        assert_eq!(*keys.identity, *opened.identity);
        let mut damaged: VaultMeta =
            serde_json::from_slice(&serde_json::to_vec(&replacement).unwrap()).unwrap();
        damaged.header.generation += 1;
        assert!(unwrap_keys("second-password-456", &damaged).is_err());
        damaged.nonce = "00".into();
        assert!(unwrap_keys("second-password-456", &damaged).is_err());
        damaged.header.memory_kib = u32::MAX;
        assert!(unwrap_keys("second-password-456", &damaged).is_err());
        assert!(serde_json::from_str::<VaultMeta>(r#"{"salt":"00","verifier":"00"}"#).is_err());
    }
    #[test]
    fn failed_atomic_commit_preserves_previous_file_and_cleans_temporary_file() {
        let scratch = Scratch::new();
        let path = scratch.0.join("metadata");
        atomic_bytes(&path, b"old complete envelope").unwrap();
        let failure = atomic_bytes_before_commit(&path, b"new complete envelope", || {
            Err(internal("simulated disk error before commit"))
        });
        assert!(failure.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old complete envelope");
        assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), 1);
        atomic_bytes(&path, b"new complete envelope").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new complete envelope");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn directory_sync_failure_reports_committed_state() {
        let scratch = Scratch::new();
        let path = scratch.0.join("metadata");
        atomic_bytes(&path, b"old").unwrap();
        let warning = atomic_bytes_with_sync(
            &path,
            b"new",
            || Ok(()),
            |_| Err(std::io::Error::other("simulated directory sync failure")),
        )
        .unwrap();
        assert!(warning);
        assert_eq!(fs::read(path).unwrap(), b"new");
    }
    #[test]
    fn initialization_publishes_a_complete_vault_and_never_recreates_a_missing_database() {
        let scratch = Scratch::new();
        let state = AppState {
            data_dir: scratch.0.clone(),
            public_origin: None,
            batches: Arc::new(Mutex::new(std::collections::HashMap::new())),
            runtime: Arc::new(Mutex::new(Runtime {
                keys: None,
                unlocked_at: None,
                last_activity: None,
                persistent: false,
                session_hash: None,
                unlock_failures: 0,
                unlock_after: None,
            })),
        };
        assert!(initialize_vault(&state, "short").is_err());
        assert!(!state.data_dir.join("vault").exists());
        assert_eq!(fs::read_dir(&state.data_dir).unwrap().count(), 0);
        let (keys, warning) = initialize_vault(&state, "initial-password-123").unwrap();
        assert!(!warning);
        let decoded = unwrap_keys("initial-password-123", &read_meta(&state).unwrap()).unwrap();
        assert_eq!(*keys.db, *decoded.db);
        let connection = open_database(&database_path(&state), &keys.db).unwrap();
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        drop(connection);
        assert!(initialize_vault(&state, "second-password-123").is_err());
        fs::remove_file(database_path(&state)).unwrap();
        assert!(open_database(&database_path(&state), &keys.db).is_err());
        assert!(!database_path(&state).exists());
    }
    #[test]
    fn data_directory_has_single_writer_and_lock_releases_on_exit() {
        let scratch = Scratch::new();
        let lock = lock_data_directory(&scratch.0).unwrap();
        assert!(lock_data_directory(&scratch.0).is_err());
        drop(lock);
        assert!(lock_data_directory(&scratch.0).is_ok());
    }
}
