use super::*;
use std::io::Read;

#[derive(Deserialize, Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct Passwords {
    current_password: String,
    new_password: String,
    confirm_password: String,
}

pub(super) fn run_cli() -> ApiResult<()> {
    let args: Vec<_> = std::env::args().skip(2).collect();
    let mut source = None;
    let mut output = None;
    let mut stdin = false;
    let mut i = 0;
    let mut seen = std::collections::HashSet::new();
    while i < args.len() {
        let flag = cli_flag(&args[i], "rotate-keys");
        if !seen.insert(flag) {
            return Err(bad_request(format!("参数 {flag} 重复，请只指定一次")));
        }
        match flag {
            "--data-dir" | "--output-dir" => {
                i += 1;
                let path = PathBuf::from(args.get(i).ok_or_else(|| bad_request("缺少路径参数"))?);
                if flag == "--data-dir" {
                    source = Some(path);
                } else {
                    output = Some(path);
                }
            }
            "--passwords-stdin" => stdin = true,
            "--help" | "-h" => {
                println!(
                    "用法：securevault rotate-keys -d 源目录 -o 新目录 [-s]\n选项：\n  -d, --data-dir 路径       源数据目录\n  -o, --output-dir 路径     新数据目录（必须不存在，且位于源目录之外）\n  -s, --passwords-stdin     从标准输入读取密码 JSON\n  -h, --help                显示帮助\n默认通过终端输入密码，输入时不回显。\n使用 -s 时，JSON 必须包含 current_password、new_password、confirm_password 三个字段，分别填写当前主密码、新主密码、新主密码确认。\n操作前请停止服务；轮换后全部应用凭据撤销，需要重新签发。源目录保持原样，验证新库后请切换服务的数据目录。"
                );
                return Ok(());
            }
            _ => return Err(bad_request("未知的密钥轮换参数")),
        }
        i += 1;
    }
    let source = source.ok_or_else(|| bad_request("必须指定源数据目录（-d / --data-dir）"))?;
    let output = output.ok_or_else(|| bad_request("必须指定新数据目录（-o / --output-dir）"))?;
    let passwords: Passwords = if stdin {
        let mut bytes = Zeroizing::new(Vec::new());
        std::io::stdin()
            .take(32769)
            .read_to_end(&mut bytes)
            .map_err(internal)?;
        if bytes.len() > 32768 {
            return Err(bad_request("密码 JSON 输入超过 32 KiB 限制"));
        }
        serde_json::from_slice(&bytes).map_err(|_| bad_request("密码 JSON 格式无效，请按帮助说明提供字段"))?
    } else {
        let mut passwords = Passwords {
            current_password: String::new(),
            new_password: String::new(),
            confirm_password: String::new(),
        };
        passwords.current_password = hidden_password("当前主密码：")?;
        passwords.new_password = hidden_password("新的主密码：")?;
        passwords.confirm_password = hidden_password("确认新密码：")?;
        passwords
    };
    validate_new_password(&passwords.new_password)?;
    if passwords.new_password != passwords.confirm_password {
        return Err(bad_request("两次输入的新主密码不一致"));
    }
    if passwords.new_password == passwords.current_password {
        return Err(bad_request("新主密码必须与当前主密码不同"));
    }
    let warning = rotate(
        &source,
        &output,
        &passwords.current_password,
        &passwords.new_password,
    )?;
    println!(
        "完整密钥轮换已完成。新数据目录：{}。原目录未修改；请切换服务 --data-dir，并重新签发应用凭据。",
        output.display()
    );
    if warning {
        eprintln!("警告：新目录已发布，但父目录同步失败；请确认存储状态并验证新库后再处理原目录。");
    }
    Ok(())
}

// Configure the terminal before publishing the prompt, so even immediate pasted
// input cannot race with echo suppression. Ctrl-C is handled as input for RAII cleanup.
#[cfg(unix)]
pub(super) fn hidden_password(prompt: &str) -> ApiResult<String> {
    use std::io::Write;
    use std::os::fd::AsRawFd;
    let mut tty = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| bad_request("没有可交互的终端，请使用 -s / --passwords-stdin 从标准输入提供密码 JSON"))?;
    let fd = tty.as_raw_fd();
    let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
    // tcgetattr initializes the whole termios structure on success.
    if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
        return Err(internal("终端配置失败"));
    }
    let original = unsafe { original.assume_init() };
    let mut hidden = original;
    hidden.c_lflag &= !(libc::ECHO | libc::ECHONL | libc::ICANON | libc::ISIG);
    hidden.c_cc[libc::VMIN] = 1;
    hidden.c_cc[libc::VTIME] = 0;
    if unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &hidden) } != 0 {
        return Err(internal("终端配置失败"));
    }
    struct Restore {
        fd: std::os::fd::RawFd,
        original: libc::termios,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            unsafe {
                libc::tcsetattr(self.fd, libc::TCSAFLUSH, &self.original);
            }
        }
    }
    let _restore = Restore { fd, original };
    tty.write_all(prompt.as_bytes()).map_err(internal)?;
    tty.flush().map_err(internal)?;
    let mut bytes = Zeroizing::new(Vec::new());
    let result = (|| {
        loop {
            let mut byte = Zeroizing::new([0u8; 1]);
            tty.read_exact(&mut *byte).map_err(internal)?;
            match byte[0] {
                b'\n' | b'\r' => break,
                3 | 4 => return Err(bad_request("已取消密码输入")),
                8 | 127 => {
                    bytes.pop();
                    while !bytes.is_empty() && std::str::from_utf8(&bytes).is_err() {
                        bytes.pop();
                    }
                }
                21 => {
                    bytes.zeroize();
                    bytes.clear();
                }
                0..=31 => return Err(bad_request("密码中包含不支持的控制字符")),
                value => {
                    if bytes.len() >= 1024 {
                        return Err(bad_request("密码超过 1024 个 UTF-8 字节限制"));
                    }
                    bytes.push(value);
                }
            }
        }
        std::str::from_utf8(&bytes)
            .map(str::to_owned)
            .map_err(|_| bad_request("密码必须使用 UTF-8 编码"))
    })();
    let _ = tty.write_all(b"\n");
    result
}
#[cfg(not(unix))]
pub(super) fn hidden_password(_prompt: &str) -> ApiResult<String> {
    Err(bad_request("交互式密码输入需要 macOS 或 Linux"))
}

pub(super) fn state_for(data_dir: PathBuf) -> AppState {
    AppState {
        data_dir,
        public_origin: None,
        runtime: Arc::new(Mutex::new(Runtime {
            keys: None,
            unlocked_at: None,
            last_activity: None,
            persistent: false,
            session_hash: None,
            unlock_failures: 0,
            unlock_after: None,
        })),
        batches: Arc::new(Mutex::new(Default::default())),
    }
}

// The source remains untouched. Only a fully verified encrypted destination is published.
fn rotate(
    source: &FsPath,
    output: &FsPath,
    old_password: &str,
    new_password: &str,
) -> ApiResult<bool> {
    #[cfg(not(unix))]
    return Err(bad_request(
        "离线密钥轮换目前需要 macOS 或 Linux 本地文件系统",
    ));
    validate_new_password(new_password)?;
    let source = fs::canonicalize(source).map_err(internal)?;
    let _source_lock = lock_data_directory(&source)?;
    let state = state_for(source.clone());
    let meta = read_meta(&state)?;
    let old_keys = unwrap_keys(old_password, &meta)?;
    let connection = open_database(&database_path(&state), &old_keys.db)?;
    connection
        .execute_batch("PRAGMA temp_store=MEMORY")
        .map_err(internal)?;
    check_integrity(&connection)?;
    let parent = fs::canonicalize(
        output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(FsPath::new(".")),
    )
    .map_err(internal)?;
    let output = parent.join(
        output
            .file_name()
            .ok_or_else(|| bad_request("输出目录无效"))?,
    );
    if output.try_exists().map_err(internal)? || fs::symlink_metadata(&output).is_ok() {
        return Err(bad_request("输出目录已存在，请选择新目录，避免覆盖原有数据"));
    }
    if parent.starts_with(&source) {
        return Err(bad_request("输出目录必须位于源数据目录之外"));
    }
    let staging = parent.join(format!(".vault-rotation-{}", Uuid::new_v4().simple()));
    private_dir(&staging)?;
    let result = (|| {
        let _destination_lock = lock_data_directory(&staging)?;
        let vault = staging.join("vault");
        private_dir(&vault)?;
        let db = vault.join("securevault.db");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        drop(options.open(&db).map_err(internal)?);
        let new_keys = random_keys();
        let replacement = wrap_keys(new_password, &new_keys, Some(&meta))?;
        let hex_key = Zeroizing::new(hex::encode(&*new_keys.db));
        let key = Zeroizing::new(format!("x'{}'", hex_key.as_str()));
        connection
            .execute(
                "ATTACH DATABASE ?1 AS rotated KEY ?2",
                params![
                    db.to_str()
                        .ok_or_else(|| bad_request("输出路径必须使用 UTF-8 编码"))?,
                    key.as_str()
                ],
            )
            .map_err(internal)?;
        let exported = connection
            .query_row("SELECT sqlcipher_export('rotated')", [], |_| Ok(()))
            .map_err(internal);
        let detached = connection
            .execute_batch("DETACH DATABASE rotated")
            .map_err(internal);
        exported?;
        detached?;
        let mut target = open_database(&db, &new_keys.db)?;
        for pragma in ["user_version", "application_id"] {
            let value: i64 = connection
                .query_row(&format!("PRAGMA {pragma}"), [], |r| r.get(0))
                .map_err(internal)?;
            target
                .pragma_update(None, pragma, value)
                .map_err(internal)?;
        }
        target
            .execute_batch("PRAGMA temp_store=MEMORY")
            .map_err(internal)?;
        let tx = target.transaction().map_err(internal)?;
        let mut records = connection.prepare("SELECT r.id,r.dataset_id,r.indexes_json,r.display_json,d.identity_fields_json FROM records r JOIN datasets d ON d.id=r.dataset_id ORDER BY r.id").map_err(internal)?;
        let mut rows = records.query([]).map_err(internal)?;
        let mut record_count = 0i64;
        while let Some(row) = rows.next().map_err(internal)? {
            let id: String = row.get(0).map_err(internal)?;
            let dataset: String = row.get(1).map_err(internal)?;
            let mut values = serde_json::Map::new();
            for column in [2, 3] {
                let flat: serde_json::Map<String, Value> =
                    serde_json::from_str(&row.get::<_, String>(column).map_err(internal)?)
                        .map_err(internal)?;
                for (field, value) in flat {
                    insert_nested_value(&mut values, &field, value);
                }
            }
            let fields: Vec<String> =
                serde_json::from_str(&row.get::<_, String>(4).map_err(internal)?)
                    .map_err(internal)?;
            let mut secrets = connection.prepare("SELECT source_key,nonce,ciphertext FROM protected_fields WHERE record_id=?1 ORDER BY source_key").map_err(internal)?;
            let mut secret_rows = secrets.query([&id]).map_err(internal)?;
            while let Some(secret) = secret_rows.next().map_err(internal)? {
                let field: String = secret.get(0).map_err(internal)?;
                let nonce: Vec<u8> = secret.get(1).map_err(internal)?;
                let ciphertext: Vec<u8> = secret.get(2).map_err(internal)?;
                let value = open_field(&old_keys.field, &id, &field, &nonce, &ciphertext)?;
                let (nonce, ciphertext) = seal_field(&new_keys.field, &id, &field, &value)?;
                if open_field(&new_keys.field, &id, &field, &nonce, &ciphertext)? != value {
                    return Err(internal("field verification failed"));
                }
                let changed = tx.execute("UPDATE protected_fields SET nonce=?3,ciphertext=?4 WHERE record_id=?1 AND source_key=?2", params![id, field, nonce, ciphertext]).map_err(internal)?;
                if changed != 1 {
                    return Err(internal("missing protected field"));
                }
                insert_nested_value(&mut values, &field, value);
            }
            let hash = identity_hash(
                &new_keys.identity,
                &dataset,
                &fields,
                &Value::Object(values),
            );
            tx.execute(
                "UPDATE records SET identity_hash=?2 WHERE id=?1",
                params![id, hash],
            )
            .map_err(internal)?;
            record_count += 1;
        }
        let expected: i64 = connection
            .query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0))
            .map_err(internal)?;
        if expected != record_count {
            return Err(internal("orphan records detected"));
        }
        // Stolen old application tokens must not grant access to the new vault.
        let ids = {
            let mut apps = tx.prepare("SELECT id FROM api_apps").map_err(internal)?;
            apps.query_map([], |r| r.get::<_, String>(0))
                .map_err(internal)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(internal)?
        };
        for id in ids {
            tx.execute(
                "UPDATE api_apps SET disabled=1,key_hash=?2 WHERE id=?1",
                params![id, app_key_hash(&Uuid::new_v4().to_string())],
            )
            .map_err(internal)?;
        }
        tx.execute(
            "INSERT INTO audit_events(event,field_name) VALUES('data_keys_rotated','offline_cli')",
            [],
        )
        .map_err(internal)?;
        tx.commit().map_err(internal)?;
        target
            .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; VACUUM;")
            .map_err(internal)?;
        check_integrity(&target)?;
        for table in [
            "datasets",
            "records",
            "protected_fields",
            "import_templates",
            "api_apps",
        ] {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let a: i64 = connection
                .query_row(&sql, [], |r| r.get(0))
                .map_err(internal)?;
            let b: i64 = target.query_row(&sql, [], |r| r.get(0)).map_err(internal)?;
            if a != b {
                return Err(internal("row count verification failed"));
            }
        }
        drop(target);
        let checked = unwrap_keys(new_password, &replacement)?;
        let reopened = open_database(&db, &checked.db)?;
        check_integrity(&reopened)?;
        verify_records(&connection, &reopened, &old_keys, &checked)?;
        drop(reopened);
        fs::File::open(&db)
            .map_err(internal)?
            .sync_all()
            .map_err(internal)?;
        if atomic_meta(&vault.join("vault.meta.json"), &replacement)? {
            return Err(internal("metadata durability failed"));
        }
        sync_directory(&vault).map_err(internal)?;
        sync_directory(&staging).map_err(internal)?;
        // Atomic no-replace publication also closes the destination creation race.
        if output.try_exists().map_err(internal)? {
            return Err(bad_request("轮换期间输出目录已被其他操作创建，请选择新目录"));
        }
        publish_directory(&staging, &output)?;
        Ok(sync_directory(&parent).is_err())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

// Reopen and verify persisted protected values and HMACs, one record at a time.
fn verify_records(
    source: &Connection,
    target: &Connection,
    old: &KeySet,
    new: &KeySet,
) -> ApiResult<()> {
    let mut records = source
        .prepare("SELECT id,dataset_id,indexes_json,display_json FROM records ORDER BY id")
        .map_err(internal)?;
    let mut rows = records.query([]).map_err(internal)?;
    while let Some(row) = rows.next().map_err(internal)? {
        let id: String = row.get(0).map_err(internal)?;
        let dataset: String = row.get(1).map_err(internal)?;
        let mut values = serde_json::Map::new();
        for column in [2, 3] {
            let flat: serde_json::Map<String, Value> =
                serde_json::from_str(&row.get::<_, String>(column).map_err(internal)?)
                    .map_err(internal)?;
            for (field, value) in flat {
                insert_nested_value(&mut values, &field, value);
            }
        }
        let fields: String = source
            .query_row(
                "SELECT identity_fields_json FROM datasets WHERE id=?1",
                [&dataset],
                |r| r.get(0),
            )
            .map_err(internal)?;
        let fields: Vec<String> = serde_json::from_str(&fields).map_err(internal)?;
        let mut protected = source
            .prepare("SELECT source_key,nonce,ciphertext FROM protected_fields WHERE record_id=?1")
            .map_err(internal)?;
        let mut secrets = protected.query([&id]).map_err(internal)?;
        while let Some(secret) = secrets.next().map_err(internal)? {
            let field: String = secret.get(0).map_err(internal)?;
            let nonce: Vec<u8> = secret.get(1).map_err(internal)?;
            let ciphertext: Vec<u8> = secret.get(2).map_err(internal)?;
            let value = open_field(&old.field, &id, &field, &nonce, &ciphertext)?;
            let (nonce,ciphertext): (Vec<u8>,Vec<u8>) = target.query_row("SELECT nonce,ciphertext FROM protected_fields WHERE record_id=?1 AND source_key=?2", params![id,field], |r| Ok((r.get(0)?,r.get(1)?))).map_err(internal)?;
            if open_field(&new.field, &id, &field, &nonce, &ciphertext)? != value {
                return Err(internal("persisted field verification failed"));
            }
            insert_nested_value(&mut values, &field, value);
        }
        let expected = identity_hash(&new.identity, &dataset, &fields, &Value::Object(values));
        let actual: Option<String> = target
            .query_row(
                "SELECT identity_hash FROM records WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if actual != expected {
            return Err(internal("persisted identity verification failed"));
        }
    }
    Ok(())
}

pub(super) fn publish_directory(source: &FsPath, destination: &FsPath) -> ApiResult<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(internal)?;
        let destination =
            std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(internal)?;
        // Both paths are private staging/publish paths, and the kernel must refuse replacement.
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result =
            unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
        if result != 0 {
            return Err(internal(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (source, destination);
        Err(bad_request(
            "离线原子发布需要 macOS 或 Linux",
        ))
    }
}

pub(super) fn check_integrity(connection: &Connection) -> ApiResult<()> {
    let mut cipher = connection
        .prepare("PRAGMA cipher_integrity_check")
        .map_err(internal)?;
    if cipher
        .query([])
        .map_err(internal)?
        .next()
        .map_err(internal)?
        .is_some()
    {
        return Err(internal("SQLCipher integrity failed"));
    }
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(internal)?;
    if result != "ok" {
        return Err(internal("database integrity failed"));
    }
    let mut foreign = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(internal)?;
    if foreign
        .query([])
        .map_err(internal)?
        .next()
        .map_err(internal)?
        .is_some()
    {
        return Err(internal("foreign key integrity failed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_never_replaces_an_existing_directory() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let scratch = root.join(format!("publication-test-{}", Uuid::new_v4()));
        private_dir(&scratch).unwrap();
        let staging = scratch.join("staging");
        let target = scratch.join("target");
        private_dir(&staging).unwrap();
        private_dir(&target).unwrap();
        fs::write(target.join("marker"), b"original").unwrap();
        assert!(publish_directory(&staging, &target).is_err());
        assert!(staging.exists());
        assert_eq!(fs::read(target.join("marker")).unwrap(), b"original");
        fs::remove_dir_all(&scratch).unwrap();
    }
    #[test]
    fn offline_rotation_rekeys_all_layers_and_preserves_original_on_failure() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let scratch = root.join(format!("rotation-test-{}", Uuid::new_v4()));
        private_dir(&scratch).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(scratch.clone());
        let source = scratch.join("source");
        private_dir(&source).unwrap();
        let state = state_for(source.clone());
        let (old, _) = initialize_vault(&state, "original-password-123").unwrap();
        let db = open_database(&database_path(&state), &old.db).unwrap();
        db.execute("INSERT INTO datasets(id,category_path,fields_json,identity_fields_json,conflict_strategy) VALUES('d','测试','[]','[\"account.token\"]','allow_mark')", []).unwrap();
        let secret = json!({"nested": ["敏感", 42]});
        let mut input = serde_json::Map::new();
        insert_nested_value(&mut input, "account.token", secret.clone());
        let hash = identity_hash(
            &old.identity,
            "d",
            &["account.token".into()],
            &Value::Object(input),
        );
        for (id, duplicate, expired) in [("r1", None, 0), ("r2", Some("r1"), 1)] {
            db.execute("INSERT INTO records(id,dataset_id,category_path,indexes_json,display_json,search_blob,identity_hash,duplicate_of,expired) VALUES(?1,'d','测试','{\"name\":\"demo\"}','{}','demo',?2,?3,?4)", params![id,hash,duplicate,expired]).unwrap();
            let (nonce, ciphertext) = seal_field(&old.field, id, "account.token", &secret).unwrap();
            db.execute(
                "INSERT INTO protected_fields VALUES(?1,'account.token','hidden',?2,?3)",
                params![id, nonce, ciphertext],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO api_apps(id,name,key_hash,permission) VALUES('a','test',?1,'search')",
            [app_key_hash("old-app-token")],
        )
        .unwrap();
        db.execute("INSERT INTO import_templates(name,dataset_id,mappings_json) VALUES('mapping','d','[]')", []).unwrap();
        drop(db);
        let original_db = fs::read(database_path(&state)).unwrap();
        let original_meta = fs::read(meta_path(&state)).unwrap();
        let output = scratch.join("destination");
        let lock = lock_data_directory(&source).unwrap();
        assert!(
            rotate(
                &source,
                &output,
                "original-password-123",
                "replacement-password-456"
            )
            .is_err()
        );
        drop(lock);
        assert!(rotate(&source, &output, "wrong", "replacement-password-456").is_err());
        assert!(!output.exists());
        assert!(
            !rotate(
                &source,
                &output,
                "original-password-123",
                "replacement-password-456"
            )
            .unwrap()
        );
        assert_eq!(fs::read(database_path(&state)).unwrap(), original_db);
        assert_eq!(fs::read(meta_path(&state)).unwrap(), original_meta);
        let next = state_for(output.clone());
        let meta = read_meta(&next).unwrap();
        assert!(unwrap_keys("original-password-123", &meta).is_err());
        let new = unwrap_keys("replacement-password-456", &meta).unwrap();
        assert_ne!(*new.db, *old.db);
        assert_ne!(*new.field, *old.field);
        assert_ne!(*new.identity, *old.identity);
        assert!(open_database(&database_path(&next), &old.db).is_err());
        let db = open_database(&database_path(&next), &new.db).unwrap();
        let (new_hash, duplicate, expired): (String, String, i64) = db
            .query_row(
                "SELECT identity_hash,duplicate_of,expired FROM records WHERE id='r2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_ne!(Some(new_hash), hash);
        assert_eq!(duplicate, "r1");
        assert_eq!(expired, 1);
        let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = db
            .query_row(
                "SELECT nonce,ciphertext FROM protected_fields WHERE record_id='r2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            open_field(&new.field, "r2", "account.token", &nonce, &ciphertext).unwrap(),
            secret
        );
        assert!(open_field(&old.field, "r2", "account.token", &nonce, &ciphertext).is_err());
        let (disabled, token): (bool, String) = db
            .query_row(
                "SELECT disabled,key_hash FROM api_apps WHERE id='a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(disabled);
        assert_ne!(token, app_key_hash("old-app-token"));
        assert!(
            rotate(
                &source,
                &output,
                "original-password-123",
                "replacement-password-456"
            )
            .is_err()
        );
        drop(db);
        // Corruption after a valid export must never publish a partially rotated directory.
        let db = open_database(&database_path(&state), &old.db).unwrap();
        db.execute(
            "UPDATE protected_fields SET nonce=x'01' WHERE record_id='r2'",
            [],
        )
        .unwrap();
        drop(db);
        let failed = scratch.join("failed");
        assert!(
            rotate(
                &source,
                &failed,
                "original-password-123",
                "replacement-password-456"
            )
            .is_err()
        );
        assert!(!failed.exists());
        assert!(!fs::read_dir(&scratch).unwrap().any(|p| {
            p.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".vault-rotation-")
        }));
    }
}
