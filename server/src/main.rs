use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce, aead::Aead};
use argon2::Argon2;
use axum::{
    Json, Router,
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use calamine::{Reader, open_workbook_auto_from_rs};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    fs,
    io::Cursor,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tower_http::services::ServeDir;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
struct AppState {
    runtime: Arc<Mutex<Runtime>>,
    data_dir: PathBuf,
    batches: Arc<Mutex<std::collections::HashMap<String, (Instant, Vec<Value>)>>>,
}

struct Runtime {
    keys: Option<KeySet>,
    unlocked_at: Option<Instant>,
    last_activity: Option<Instant>,
}

struct KeySet {
    db: Zeroizing<[u8; 32]>,
    field: Zeroizing<[u8; 32]>,
    identity: Zeroizing<[u8; 32]>,
}

impl Drop for KeySet {
    fn drop(&mut self) {
        self.db.zeroize();
        self.field.zeroize();
        self.identity.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct VaultMeta {
    salt: String,
    verifier: String,
}

#[derive(Debug)]
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}
fn locked() -> ApiError {
    ApiError(StatusCode::LOCKED, "vault is sealed".into())
}
fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
}

#[derive(Deserialize, Clone, Serialize)]
struct FieldDefinition {
    source_key: String,
    #[serde(default)]
    display_name: String,
    #[serde(default = "default_zone")]
    zone: String,
    #[serde(default)]
    unique: bool,
}

fn default_zone() -> String {
    "indexes".into()
}

#[derive(Deserialize)]
struct SchemaPreviewRequest {
    sample_data: Value,
}

#[derive(Deserialize)]
struct DatasetCreateRequest {
    category_path: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    fields: Vec<FieldDefinition>,
    #[serde(default)]
    identity_fields: Vec<String>,
    #[serde(default = "default_conflict")]
    conflict_strategy: String,
    #[serde(default)]
    sample_data: Option<Value>,
}

fn default_conflict() -> String {
    "allow_mark".into()
}

#[derive(Deserialize)]
struct ImportRequest {
    dataset_id: String,
    batch_id: String,
    #[serde(default)]
    mappings: Vec<FieldMapping>,
    #[serde(default)]
    template_name: Option<String>,
    #[serde(default)]
    skip_existing: bool,
    #[serde(default)]
    delete_missing: bool,
    #[serde(default)]
    evolved_fields: Vec<FieldDefinition>,
    #[serde(default)]
    evolved_identity_fields: Vec<String>,
}

#[derive(Deserialize, Clone, Serialize)]
struct FieldMapping {
    source_key: String,
    target_key: String,
    #[serde(default)]
    json_path: Option<String>,
}

#[derive(Deserialize)]
struct RecordFlags {
    expired: bool,
}

#[derive(Deserialize)]
struct DatasetUpdate {
    #[serde(default)]
    category_path: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    clear_environment: bool,
    #[serde(default)]
    fields: Option<Vec<FieldDefinition>>,
    #[serde(default)]
    identity_fields: Option<Vec<String>>,
    #[serde(default)]
    merge_fields: bool,
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    include_expired: bool,
    #[serde(default = "default_page")]
    page: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_page() -> usize {
    1
}
fn default_limit() -> usize {
    40
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let data_dir = std::env::var_os("SECUREVAULT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("data"));
    fs::create_dir_all(&data_dir)?;
    let web_dir = root.join("web");
    let state = AppState {
        runtime: Arc::new(Mutex::new(Runtime {
            keys: None,
            unlocked_at: None,
            last_activity: None,
        })),
        data_dir,
        batches: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    let api = Router::new()
        .route("/vault/status", get(vault_status))
        .route("/vault/setup", post(vault_setup))
        .route("/vault/unlock", post(vault_unlock))
        .route("/vault/seal", post(vault_seal))
        .route("/datasets/schema-preview", post(schema_preview))
        .route("/datasets", get(list_datasets).post(create_dataset))
        .route("/datasets/{id}", axum::routing::patch(update_dataset))
        .route("/datasets/{id}/templates", get(list_import_templates))
        .route("/datasets/tree", get(dataset_tree))
        .route("/vault/summary", get(vault_summary))
        .route("/imports/upload", post(upload_import))
        .route("/records/import", post(import_records))
        .route("/records/{id}/expired", post(set_expired))
        .route("/records/search", get(search_records))
        .route("/records/{id}/secrets/reveal", post(reveal_secret))
        .with_state(state.clone());

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true))
        .with_state(state);
    let address: SocketAddr = std::env::var("SECUREVAULT_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:4173".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("SecureVault listening on http://{address}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn meta_path(state: &AppState) -> PathBuf {
    state.data_dir.join("vault.meta.json")
}
fn database_path(state: &AppState) -> PathBuf {
    state.data_dir.join("securevault.db")
}

fn derive_keys(password: &str, salt: &[u8]) -> ApiResult<KeySet> {
    let mut root = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut *root)
        .map_err(|e| internal(format!("key derivation failed: {e}")))?;
    let hk = Hkdf::<Sha256>::new(Some(salt), &*root);
    let mut db = Zeroizing::new([0u8; 32]);
    let mut field = Zeroizing::new([0u8; 32]);
    let mut identity = Zeroizing::new([0u8; 32]);
    hk.expand(b"securevault/sqlcipher/v1", &mut *db)
        .map_err(internal)?;
    hk.expand(b"securevault/field-encryption/v1", &mut *field)
        .map_err(internal)?;
    hk.expand(b"securevault/identity-hmac/v1", &mut *identity)
        .map_err(internal)?;
    Ok(KeySet {
        db,
        field,
        identity,
    })
}

fn verifier(key: &[u8; 32]) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts 32-byte keys");
    mac.update(b"securevault/password-verifier/v1");
    hex::encode(mac.finalize().into_bytes())
}

fn open_database(path: &FsPath, key: &[u8; 32]) -> ApiResult<Connection> {
    let connection = Connection::open(path).map_err(internal)?;
    let key_hex = hex::encode(key);
    connection
        .execute_batch(&format!(
            "PRAGMA key = \"x'{key_hex}'\"; PRAGMA cipher_memory_security = ON;"
        ))
        .map_err(internal)?;
    connection
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(internal)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(internal)?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> ApiResult<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS datasets (
           id TEXT PRIMARY KEY, category_path TEXT NOT NULL, environment TEXT,
           fields_json TEXT NOT NULL, identity_fields_json TEXT NOT NULL,
           conflict_strategy TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS ix_datasets_category ON datasets(category_path);
         CREATE TABLE IF NOT EXISTS records (
           id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id),
           category_path TEXT NOT NULL, environment TEXT, indexes_json TEXT NOT NULL,
           display_json TEXT NOT NULL, search_blob TEXT NOT NULL, identity_hash TEXT,
           duplicate_of TEXT, expired INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS ix_records_dataset_identity ON records(dataset_id, identity_hash);
         CREATE INDEX IF NOT EXISTS ix_records_category_env ON records(category_path, environment);
         CREATE INDEX IF NOT EXISTS ix_records_dataset ON records(dataset_id);
         CREATE TABLE IF NOT EXISTS protected_fields (
           record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
           source_key TEXT NOT NULL, zone TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL,
           PRIMARY KEY(record_id, source_key)
         );
         CREATE TABLE IF NOT EXISTS audit_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, record_id TEXT,
           field_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );"
    ).map_err(internal)?;
    let has_expired: bool = connection
        .prepare("PRAGMA table_info(records)")
        .map_err(internal)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(internal)?
        .filter_map(Result::ok)
        .any(|name| name == "expired");
    if !has_expired {
        connection
            .execute(
                "ALTER TABLE records ADD COLUMN expired INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(internal)?;
    }
    connection.execute_batch("CREATE TABLE IF NOT EXISTS import_templates(name TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, mappings_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);").map_err(internal)
}

async fn vault_status(State(state): State<AppState>) -> Json<Value> {
    let runtime = state.runtime.lock().await;
    let now = Instant::now();
    let idle = runtime
        .last_activity
        .map(|t| 1800u64.saturating_sub(now.duration_since(t).as_secs()));
    let ttl = runtime
        .unlocked_at
        .map(|t| 14400u64.saturating_sub(now.duration_since(t).as_secs()));
    Json(
        json!({ "initialized": meta_path(&state).exists(), "sealed": runtime.keys.is_none(), "idle_seconds_remaining": idle, "ttl_seconds_remaining": ttl }),
    )
}

async fn vault_setup(
    State(state): State<AppState>,
    Json(request): Json<PasswordRequest>,
) -> ApiResult<Json<Value>> {
    if request.password.len() < 12 {
        return Err(bad_request("master password must be at least 12 bytes"));
    }
    if meta_path(&state).exists() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "vault is already initialized".into(),
        ));
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let keys = derive_keys(&request.password, &salt)?;
    let meta = VaultMeta {
        salt: hex::encode(salt),
        verifier: verifier(&keys.db),
    };
    fs::write(
        meta_path(&state),
        serde_json::to_vec(&meta).map_err(internal)?,
    )
    .map_err(internal)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(meta_path(&state), fs::Permissions::from_mode(0o600))
            .map_err(internal)?;
    }
    let connection = open_database(&database_path(&state), &keys.db)?;
    initialize_schema(&connection)?;
    drop(connection);
    activate(&state, keys).await;
    Ok(Json(json!({ "sealed": false })))
}

async fn vault_unlock(
    State(state): State<AppState>,
    Json(request): Json<PasswordRequest>,
) -> ApiResult<Json<Value>> {
    let meta: VaultMeta = serde_json::from_slice(
        &fs::read(meta_path(&state))
            .map_err(|_| ApiError(StatusCode::NOT_FOUND, "vault is not initialized".into()))?,
    )
    .map_err(internal)?;
    let salt = hex::decode(meta.salt).map_err(internal)?;
    let keys = derive_keys(&request.password, &salt)?;
    if verifier(&keys.db) != meta.verifier {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "invalid master password".into(),
        ));
    }
    let connection = open_database(&database_path(&state), &keys.db)?;
    initialize_schema(&connection)?;
    drop(connection);
    activate(&state, keys).await;
    Ok(Json(json!({ "sealed": false })))
}

async fn activate(state: &AppState, keys: KeySet) {
    let mut runtime = state.runtime.lock().await;
    runtime.keys = Some(keys);
    runtime.unlocked_at = Some(Instant::now());
    runtime.last_activity = runtime.unlocked_at;
}

async fn vault_seal(State(state): State<AppState>) -> Json<Value> {
    let mut runtime = state.runtime.lock().await;
    runtime.keys = None;
    runtime.unlocked_at = None;
    runtime.last_activity = None;
    drop(runtime);
    state.batches.lock().await.clear();
    Json(json!({ "sealed": true }))
}

async fn with_connection<T>(
    state: &AppState,
    operation: impl FnOnce(&Connection, &KeySet) -> ApiResult<T>,
) -> ApiResult<T> {
    let mut runtime = state.runtime.lock().await;
    if runtime.keys.is_none() {
        return Err(locked());
    }
    if runtime
        .unlocked_at
        .is_some_and(|start| start.elapsed() >= Duration::from_secs(4 * 60 * 60))
        || runtime
            .last_activity
            .is_some_and(|last| last.elapsed() >= Duration::from_secs(30 * 60))
    {
        runtime.keys = None;
        runtime.unlocked_at = None;
        runtime.last_activity = None;
        return Err(locked());
    }
    runtime.last_activity = Some(Instant::now());
    let keys = runtime.keys.as_ref().ok_or_else(locked)?;
    let connection = open_database(&database_path(state), &keys.db)?;
    operation(&connection, keys)
}

fn flatten_sample(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

fn flatten_fields(value: &Value, prefix: &str, output: &mut Vec<(String, Value)>) {
    if let Value::Object(object) = value {
        for (key, nested) in object {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            if nested.is_object() {
                flatten_fields(nested, &path, output);
            } else {
                output.push((path, nested.clone()));
            }
        }
    }
}

fn guess_zone(field: &str) -> &'static str {
    if [
        "key",
        "secret",
        "token",
        "password",
        "private",
        "credential",
    ]
    .iter()
    .any(|part| field.to_lowercase().contains(part))
    {
        "secrets"
    } else {
        "indexes"
    }
}

async fn schema_preview(Json(request): Json<SchemaPreviewRequest>) -> ApiResult<Json<Value>> {
    let mut found = std::collections::BTreeMap::<String, Value>::new();
    for sample in flatten_sample(&request.sample_data) {
        let mut fields = Vec::new();
        flatten_fields(&sample, "", &mut fields);
        for (name, value) in fields {
            found.entry(name).or_insert(value);
        }
    }
    let fields: Vec<Value> = found.into_iter().map(|(source_key, sample)| {
        let zone = guess_zone(&source_key);
        let display_name = source_key.split(['_', '-', '.']).map(|part| {
            let mut chars = part.chars(); chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        }).collect::<Vec<_>>().join(" ");
        json!({ "source_key": source_key, "display_name": display_name, "zone": zone, "type": match sample { Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number", Value::String(_) => "string", Value::Array(_) => "array", Value::Object(_) => "object" } })
    }).collect();
    Ok(Json(json!({ "fields": fields })))
}

fn normalize_category(value: &str) -> ApiResult<String> {
    let parts: Vec<&str> = value.split('/').map(str::trim).collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(bad_request(
            "category_path must be a valid slash-delimited path",
        ));
    }
    Ok(parts.join("/"))
}

fn transform_record(
    input: &Value,
    definitions: &[FieldDefinition],
) -> (Value, Value, Vec<(String, String, Value)>) {
    let mut indexes = serde_json::Map::new();
    let mut display = serde_json::Map::new();
    let mut protected = Vec::new();
    let mut flat = Vec::new();
    flatten_fields(input, "", &mut flat);
    for (source_key, value) in flat {
        let definition = definitions
            .iter()
            .find(|field| field.source_key == source_key)
            .cloned()
            .unwrap_or(FieldDefinition {
                source_key: source_key.clone(),
                display_name: source_key.clone(),
                zone: guess_zone(&source_key).into(),
                unique: false,
            });
        match definition.zone.as_str() {
            "display" => {
                display.insert(source_key, value);
            }
            "hidden" | "secrets" => protected.push((source_key, definition.zone, value)),
            _ => {
                indexes.insert(source_key, value);
            }
        }
    }
    (Value::Object(indexes), Value::Object(display), protected)
}

fn seal_field(
    key: &[u8; 32],
    record_id: &str,
    field: &str,
    value: &Value,
) -> ApiResult<(Vec<u8>, Vec<u8>)> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let aad = format!("{record_id}\x1f{field}");
    let plaintext = Zeroizing::new(serde_json::to_vec(value).map_err(internal)?);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| internal("field encryption failed"))?;
    Ok((nonce.to_vec(), ciphertext))
}

fn open_field(
    key: &[u8; 32],
    record_id: &str,
    field: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> ApiResult<Value> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let aad = format!("{record_id}\x1f{field}");
    let mut plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| internal("field authentication failed"))?;
    let result = serde_json::from_slice(&plaintext).map_err(internal);
    plaintext.zeroize();
    result
}

fn identity_hash(
    key: &[u8; 32],
    dataset_id: &str,
    field_names: &[String],
    input: &Value,
) -> Option<String> {
    if field_names.is_empty() {
        return None;
    }
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).ok()?;
    let mut add_part = |bytes: &[u8]| {
        mac.update(&(bytes.len() as u64).to_be_bytes());
        mac.update(bytes);
    };
    add_part(dataset_id.as_bytes());
    for field in field_names {
        let value = field
            .split('.')
            .try_fold(input, |current, segment| current.get(segment))?;
        if value.is_null() {
            return None;
        }
        let serialized = Zeroizing::new(serde_json::to_vec(value).ok()?);
        add_part(field.as_bytes());
        add_part(&serialized);
    }
    Some(hex::encode(mac.finalize().into_bytes()))
}

fn search_blob(
    category: &str,
    environment: Option<&str>,
    indexes: &Value,
    display: &Value,
) -> String {
    let mut terms = vec![category.to_lowercase()];
    if let Some(environment) = environment {
        terms.push(environment.to_lowercase());
    }
    let value_text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if let Some(map) = indexes.as_object() {
        for (key, value) in map {
            terms.push(format!(
                "{}:{}",
                key.to_lowercase(),
                value_text(value).to_lowercase()
            ));
        }
    }
    if let Some(map) = display.as_object() {
        for (key, value) in map {
            terms.push(format!(
                "{}:{}",
                key.to_lowercase(),
                value_text(value).to_lowercase()
            ));
        }
    }
    terms.join(" ")
}

fn query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in query.chars() {
        match character {
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    terms.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }
    terms
}

fn like_contains(value: &str) -> String {
    format!(
        "%{}%",
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn insert_records(
    connection: &Connection,
    keys: &KeySet,
    dataset_id: &str,
    category: &str,
    environment: Option<&str>,
    definitions: &[FieldDefinition],
    identity_fields: &[String],
    inputs: &[Value],
    skip_existing: bool,
) -> ApiResult<Value> {
    let mut seen = std::collections::HashMap::<String, String>::new();
    let mut inserted = Vec::new();
    let mut duplicates = Vec::new();
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let tx = connection.unchecked_transaction().map_err(internal)?;
    for (index, input) in inputs.iter().enumerate() {
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("rec_{}", Uuid::new_v4().simple()));
        let (indexes, display, protected) = transform_record(input, definitions);
        let hash = identity_hash(&keys.identity, dataset_id, identity_fields, input);
        let duplicate_of = if let Some(ref hash) = hash {
            seen.get(hash).cloned().or_else(|| {
                tx.query_row(
                    "SELECT id FROM records WHERE dataset_id=?1 AND identity_hash=?2 ORDER BY updated_at,id LIMIT 1",
                    params![dataset_id, hash],
                    |row| row.get(0),
                )
                .optional()
                .map_err(internal)
                .ok()
                .flatten()
            })
        } else {
            None
        };
        if let (Some(hash), Some(existing)) = (hash.as_ref(), duplicate_of.as_ref()) {
            duplicates.push(json!({ "input_index": index, "record_id": id, "duplicate_of": existing, "identity_hash": hash }));
            if skip_existing {
                skipped += 1;
                continue;
            }
        }
        let blob = search_blob(category, environment, &indexes, &display);
        let target_id = duplicate_of.clone().unwrap_or_else(|| id.clone());
        if duplicate_of.is_some() {
            tx.execute("UPDATE records SET category_path=?2,environment=?3,indexes_json=?4,display_json=?5,search_blob=?6,identity_hash=?7,duplicate_of=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![target_id, category, environment, indexes.to_string(), display.to_string(), blob, hash]).map_err(internal)?;
            tx.execute(
                "DELETE FROM protected_fields WHERE record_id=?1",
                [&target_id],
            )
            .map_err(internal)?;
            updated += 1;
        } else {
            tx.execute("INSERT INTO records(id,dataset_id,category_path,environment,indexes_json,display_json,search_blob,identity_hash,duplicate_of) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![id, dataset_id, category, environment, indexes.to_string(), display.to_string(), blob, hash, duplicate_of]).map_err(internal)?;
        }
        for (field, zone, value) in protected {
            let (nonce, ciphertext) = seal_field(&keys.field, &target_id, &field, &value)?;
            tx.execute("INSERT INTO protected_fields(record_id,source_key,zone,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5)", params![target_id, field, zone, nonce, ciphertext]).map_err(internal)?;
        }
        if let Some(hash) = hash {
            seen.entry(hash).or_insert(target_id.clone());
        }
        inserted.push(target_id);
    }
    tx.commit().map_err(internal)?;
    Ok(
        json!({ "imported": inserted.len() - updated, "updated":updated,"skipped":skipped,"record_ids": inserted, "duplicates": duplicates, "duplicate_policy": if skip_existing {"skip-existing"} else {"update-first-match"}, "physical_unique_constraint": false }),
    )
}

async fn create_dataset(
    State(state): State<AppState>,
    Json(request): Json<DatasetCreateRequest>,
) -> ApiResult<Json<Value>> {
    let category = normalize_category(&request.category_path)?;
    let environment = request.environment.filter(|value| !value.trim().is_empty());
    let records = request
        .sample_data
        .as_ref()
        .map(flatten_sample)
        .unwrap_or_default();
    if request.conflict_strategy != "allow_mark" {
        return Err(bad_request(
            "only logical allow_mark conflict handling is supported",
        ));
    }
    let dataset_id = format!("ds_{}", Uuid::new_v4().simple());
    with_connection(&state, |connection, keys| {
        let definitions_json = serde_json::to_string(&request.fields).map_err(internal)?;
        let identity_json = serde_json::to_string(&request.identity_fields).map_err(internal)?;
        connection.execute("INSERT INTO datasets(id,category_path,environment,fields_json,identity_fields_json,conflict_strategy) VALUES(?1,?2,?3,?4,?5,?6)", params![dataset_id, category, environment, definitions_json, identity_json, request.conflict_strategy]).map_err(internal)?;
        let import = if records.is_empty() { json!({"imported":0,"record_ids":[],"duplicates":[]}) } else { insert_records(connection, keys, &dataset_id, &category, environment.as_deref(), &request.fields, &request.identity_fields, &records, false)? };
        Ok(Json(json!({ "dataset_id": dataset_id, "category_path": category, "environment": environment, "fields": request.fields, "identity_fields": request.identity_fields, "import": import })))
    }).await
}

async fn update_dataset(
    State(state): State<AppState>,
    Path(dataset_id): Path<String>,
    Json(request): Json<DatasetUpdate>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let (old_category, old_environment, old_fields, old_identity): (String, Option<String>, String, String) = connection.query_row(
            "SELECT category_path,environment,fields_json,identity_fields_json FROM datasets WHERE id=?1", [&dataset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        ).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "dataset not found".into()))?;
        let category = request.category_path.as_deref().map(normalize_category).transpose()?.unwrap_or(old_category);
        let environment = if request.clear_environment { None } else { request.environment.map(|v| if v.trim().is_empty() { None } else { Some(v.trim().to_owned()) }).unwrap_or(old_environment) };
        let fields = if let Some(new_fields) = request.fields {
            let mut definitions: Vec<FieldDefinition> = serde_json::from_str(&old_fields).map_err(internal)?;
            if request.merge_fields {
                for field in new_fields { if let Some(existing) = definitions.iter_mut().find(|item| item.source_key == field.source_key) { *existing = field; } else { definitions.push(field); } }
            } else { definitions = new_fields; }
            serde_json::to_string(&definitions).map_err(internal)?
        } else { old_fields };
        let identity = request.identity_fields.map(|v| serde_json::to_string(&v).map_err(internal)).transpose()?.unwrap_or(old_identity);
        connection.execute("UPDATE datasets SET category_path=?2,environment=?3,fields_json=?4,identity_fields_json=?5 WHERE id=?1", params![dataset_id, category, environment, fields, identity]).map_err(internal)?;
        connection.execute("UPDATE records SET category_path=?2,environment=?3 WHERE dataset_id=?1", params![dataset_id, category, environment]).map_err(internal)?;
        Ok(Json(json!({"id":dataset_id,"category_path":category,"environment":environment})))
    }).await
}

async fn set_expired(
    State(state): State<AppState>,
    Path(record_id): Path<String>,
    Json(request): Json<RecordFlags>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let changed = connection
            .execute(
                "UPDATE records SET expired=?2 WHERE id=?1",
                params![record_id, request.expired],
            )
            .map_err(internal)?;
        if changed == 0 {
            return Err(ApiError(StatusCode::NOT_FOUND, "record not found".into()));
        }
        Ok(Json(json!({"id":record_id,"expired":request.expired})))
    })
    .await
}

async fn list_datasets(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let mut statement = connection.prepare("SELECT d.id,d.category_path,d.environment,d.fields_json,d.identity_fields_json,d.conflict_strategy,COUNT(r.id) FROM datasets d LEFT JOIN records r ON r.dataset_id=d.id GROUP BY d.id ORDER BY d.category_path").map_err(internal)?;
        let rows = statement.query_map([], |row| Ok(json!({ "id": row.get::<_,String>(0)?, "category_path": row.get::<_,String>(1)?, "environment": row.get::<_,Option<String>>(2)?, "fields": serde_json::from_str::<Value>(&row.get::<_,String>(3)?).unwrap_or(Value::Array(vec![])), "identity_fields": serde_json::from_str::<Value>(&row.get::<_,String>(4)?).unwrap_or(Value::Array(vec![])), "conflict_strategy": row.get::<_,String>(5)?, "record_count": row.get::<_,i64>(6)? }))).map_err(internal)?;
        let mut datasets = Vec::new(); for row in rows { datasets.push(row.map_err(internal)?); }
        Ok(Json(json!({ "datasets": datasets })))
    }).await
}

async fn list_import_templates(
    State(state): State<AppState>,
    Path(dataset_id): Path<String>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let mut statement = connection.prepare("SELECT name,mappings_json,updated_at FROM import_templates WHERE dataset_id=?1 ORDER BY name").map_err(internal)?;
        let rows = statement.query_map([&dataset_id], |row| Ok(json!({"name":row.get::<_,String>(0)?,"mappings":serde_json::from_str::<Value>(&row.get::<_,String>(1)?).unwrap_or(Value::Array(vec![])),"updated_at":row.get::<_,String>(2)?}))).map_err(internal)?;
        let mut templates = Vec::new(); for row in rows { templates.push(row.map_err(internal)?); }
        Ok(Json(json!({"templates":templates})))
    }).await
}

async fn dataset_tree(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let mut statement = connection.prepare("SELECT category_path,COUNT(*) FROM records GROUP BY category_path ORDER BY category_path").map_err(internal)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,String>(0)?, row.get::<_,i64>(1)?))).map_err(internal)?;
        let mut nodes = std::collections::BTreeMap::<String, i64>::new();
        for row in rows { let (path, count) = row.map_err(internal)?; let parts: Vec<&str> = path.split('/').collect(); for i in 0..parts.len() { *nodes.entry(parts[..=i].join("/")).or_default() += count; } }
        Ok(Json(json!({ "directories": nodes.into_iter().map(|(path,count)| json!({"path":path,"count":count})).collect::<Vec<_>>() })))
    }).await
}

async fn vault_summary(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let records: i64 = connection.query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0)).map_err(internal)?;
        let datasets: i64 = connection.query_row("SELECT COUNT(*) FROM datasets", [], |row| row.get(0)).map_err(internal)?;
        let protected_fields: i64 = connection.query_row("SELECT COUNT(*) FROM protected_fields", [], |row| row.get(0)).map_err(internal)?;
        Ok(Json(json!({ "records": records, "datasets": datasets, "protected_fields": protected_fields })))
    }).await
}

fn parse_tabular(bytes: &[u8], filename: &str) -> ApiResult<Vec<Value>> {
    let extension = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "json" {
        let value: Value =
            serde_json::from_slice(bytes).map_err(|e| bad_request(format!("invalid JSON: {e}")))?;
        let records = flatten_sample(&value);
        if records.iter().any(|v| !v.is_object()) {
            return Err(bad_request("JSON import must contain objects"));
        }
        return Ok(records
            .into_iter()
            .map(|record| {
                let mut flattened = Vec::new();
                flatten_fields(&record, "", &mut flattened);
                Value::Object(flattened.into_iter().collect())
            })
            .collect());
    }
    let (headers, rows): (Vec<String>, Vec<Vec<String>>) = if extension == "csv" {
        let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
        let headers = reader
            .headers()
            .map_err(|e| bad_request(e.to_string()))?
            .iter()
            .map(str::to_owned)
            .collect();
        let rows = reader
            .records()
            .map(|r| {
                r.map(|v| v.iter().map(str::to_owned).collect())
                    .map_err(|e| bad_request(e.to_string()))
            })
            .collect::<ApiResult<Vec<_>>>()?;
        (headers, rows)
    } else if extension == "xlsx" || extension == "xls" {
        let mut workbook = open_workbook_auto_from_rs(Cursor::new(bytes.to_vec()))
            .map_err(|e| bad_request(format!("cannot read spreadsheet: {e}")))?;
        let range = workbook
            .worksheet_range_at(0)
            .ok_or_else(|| bad_request("spreadsheet has no worksheets"))?
            .map_err(|e| bad_request(e.to_string()))?;
        let mut iterator = range.rows();
        let header_row = iterator
            .next()
            .ok_or_else(|| bad_request("spreadsheet is empty"))?;
        let headers = header_row
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let rows = iterator
            .map(|row| row.iter().map(ToString::to_string).collect())
            .collect();
        (headers, rows)
    } else {
        return Err(bad_request("supported formats are JSON, CSV, and XLSX"));
    };
    if headers.is_empty() {
        return Err(bad_request("file has no header row"));
    }
    Ok(rows
        .into_iter()
        .filter(|row| row.iter().any(|v| !v.is_empty()))
        .map(|row| {
            Value::Object(
                headers
                    .iter()
                    .enumerate()
                    .filter_map(|(i, key)| {
                        let value = row.get(i).cloned().unwrap_or_default();
                        let parsed =
                            serde_json::from_str::<Value>(&value).unwrap_or(Value::String(value));
                        Some((key.clone(), parsed))
                    })
                    .collect(),
            )
        })
        .collect())
}

async fn upload_import(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let mut filename = String::new();
    let mut bytes = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| bad_request(e.to_string()))?
    {
        if field.name() == Some("file") {
            filename = field.file_name().unwrap_or("upload.json").to_owned();
            bytes = field
                .bytes()
                .await
                .map_err(|e| bad_request(e.to_string()))?
                .to_vec();
            break;
        }
    }
    if bytes.is_empty() {
        return Err(bad_request("file is missing or empty"));
    }
    let mut runtime = state.runtime.lock().await;
    if runtime.keys.is_none() {
        return Err(locked());
    }
    if runtime
        .unlocked_at
        .is_some_and(|start| start.elapsed() >= Duration::from_secs(4 * 60 * 60))
        || runtime
            .last_activity
            .is_some_and(|last| last.elapsed() >= Duration::from_secs(30 * 60))
    {
        runtime.keys = None;
        runtime.unlocked_at = None;
        runtime.last_activity = None;
        return Err(locked());
    }
    runtime.last_activity = Some(Instant::now());
    let records = parse_tabular(&bytes, &filename)?;
    let id = Uuid::new_v4().simple().to_string();
    let count = records.len();
    let fields = records
        .first()
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let mut batches = state.batches.lock().await;
    batches.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(3600));
    batches.insert(id.clone(), (Instant::now(), records));
    drop(runtime);
    Ok(Json(
        json!({"batch_id":id,"filename":filename,"record_count":count,"source_fields":fields,"expires_in_seconds":3600}),
    ))
}

fn mapped_records(inputs: &[Value], mappings: &[FieldMapping]) -> ApiResult<Vec<Value>> {
    if mappings.is_empty() {
        return Ok(inputs.to_vec());
    }
    inputs
        .iter()
        .map(|input| {
            let mut object = serde_json::Map::new();
            for mapping in mappings {
                let mut value = input
                    .get(&mapping.source_key)
                    .cloned()
                    .unwrap_or(Value::Null);
                if let Some(path) = mapping.json_path.as_deref().filter(|p| !p.is_empty()) {
                    if let Value::String(text) = &value {
                        value = serde_json::from_str(text).map_err(|_| {
                            bad_request(format!("{} is not valid JSON", mapping.source_key))
                        })?;
                    }
                    for segment in path.trim_matches('.').split('.') {
                        value = value.get(segment).cloned().unwrap_or(Value::Null);
                    }
                }
                if !value.is_null() {
                    object.insert(mapping.target_key.clone(), value);
                }
            }
            Ok(Value::Object(object))
        })
        .collect()
}

async fn import_records(
    State(state): State<AppState>,
    Json(request): Json<ImportRequest>,
) -> ApiResult<Json<Value>> {
    let inputs = {
        let batches = state.batches.lock().await;
        batches
            .get(&request.batch_id)
            .filter(|(created, _)| created.elapsed() < Duration::from_secs(3600))
            .map(|(_, records)| records.clone())
            .ok_or_else(|| {
                ApiError(
                    StatusCode::NOT_FOUND,
                    "temporary import batch expired or not found".into(),
                )
            })?
    };
    let inputs = mapped_records(&inputs, &request.mappings)?;
    with_connection(&state, |connection, keys| {
        let (category, environment, fields_json, identity_json): (String, Option<String>, String, String) = connection.query_row("SELECT category_path,environment,fields_json,identity_fields_json FROM datasets WHERE id=?1", [&request.dataset_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND,"dataset not found".into()))?;
        let mut fields: Vec<FieldDefinition> = serde_json::from_str(&fields_json).map_err(internal)?;
        let mut identity: Vec<String> = serde_json::from_str(&identity_json).map_err(internal)?;
        if !request.evolved_fields.is_empty() {
            let mut merged = fields;
            for field in request.evolved_fields.iter().cloned() {
                if let Some(existing) = merged.iter_mut().find(|item| item.source_key == field.source_key) { *existing = field; } else { merged.push(field); }
            }
            fields = merged;
            identity = request.evolved_identity_fields.clone();
            connection.execute("UPDATE datasets SET fields_json=?2,identity_fields_json=?3 WHERE id=?1", params![request.dataset_id, serde_json::to_string(&fields).map_err(internal)?, serde_json::to_string(&request.evolved_identity_fields).map_err(internal)?]).map_err(internal)?;
        }
        let result = insert_records(connection, keys, &request.dataset_id, &category, environment.as_deref(), &fields, &identity, &inputs, request.skip_existing)?;
        let deleted_missing = if request.delete_missing && !identity.is_empty() {
            let hashes = inputs.iter().filter_map(|r| identity_hash(&keys.identity, &request.dataset_id, &identity, r)).collect::<std::collections::HashSet<_>>();
            if hashes.len() != inputs.len() {
                return Err(bad_request("delete_missing requires every imported row to have a complete logical KEY"));
            }
            let ids = { let mut stmt = connection.prepare("SELECT id,identity_hash FROM records WHERE dataset_id=?1").map_err(internal)?; stmt.query_map([&request.dataset_id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,Option<String>>(1)?))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)?.into_iter().filter(|(_,h)| h.as_ref().is_none_or(|h| !hashes.contains(h))).map(|(id,_)| id).collect::<Vec<_>>() };
            for id in &ids { connection.execute("DELETE FROM records WHERE id=?1", [id]).map_err(internal)?; }
            ids.len()
        } else { 0 };
        if let Some(name) = request.template_name.as_deref().filter(|s| !s.trim().is_empty()) {
            connection.execute("INSERT INTO import_templates(name,dataset_id,mappings_json) VALUES(?1,?2,?3) ON CONFLICT(name) DO UPDATE SET dataset_id=excluded.dataset_id,mappings_json=excluded.mappings_json,updated_at=CURRENT_TIMESTAMP", params![name, request.dataset_id, serde_json::to_string(&request.mappings).map_err(internal)?]).map_err(internal)?;
        }
        let mut response = result;
        response["deleted_missing"] = json!(deleted_missing);
        Ok(Json(response))
    }).await
}

async fn search_records(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<Value>> {
    let limit = query.limit.clamp(1, 100);
    let offset = query.page.saturating_sub(1).saturating_mul(limit);
    with_connection(&state, |connection, _| {
        let mut sql = String::from("SELECT id,dataset_id,category_path,environment,indexes_json,display_json,updated_at,duplicate_of,(SELECT COUNT(*) FROM protected_fields p WHERE p.record_id=r.id AND p.zone='secrets'),(SELECT json_group_array(source_key) FROM protected_fields p WHERE p.record_id=r.id AND p.zone='secrets'),expired FROM records r WHERE 1=1");
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if !query.include_expired { sql.push_str(" AND expired=0"); }
        if let Some(category) = query.category.as_ref() { sql.push_str(" AND (category_path=? OR category_path LIKE ? ESCAPE '\\')"); values.push(category.clone().into()); values.push(format!("{}/%", category.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")).into()); }
        if let Some(environment) = query.environment.as_ref() { sql.push_str(" AND environment=?"); values.push(environment.clone().into()); }
        for token in query_terms(&query.q) {
            if let Some((name, value)) = token.split_once(':') {
                let name = name.to_lowercase();
                match name.as_str() {
                    "category" => { sql.push_str(" AND category_path LIKE ? ESCAPE '\\'"); values.push(like_contains(value).into()); }
                    "env" | "environment" => { sql.push_str(" AND environment LIKE ? ESCAPE '\\'"); values.push(like_contains(value).into()); }
                    _ => { sql.push_str(" AND search_blob LIKE ? ESCAPE '\\'"); values.push(like_contains(&format!("{name}:{value}")).into()); }
                }
            } else {
                sql.push_str(" AND search_blob LIKE ? ESCAPE '\\'");
                values.push(like_contains(&token).into());
            }
        }
        let count_sql = format!("SELECT COUNT(*) FROM ({sql})");
        let total: i64 = connection.query_row(&count_sql, rusqlite::params_from_iter(values.clone()), |row| row.get(0)).map_err(internal)?;
        sql.push_str(" ORDER BY updated_at DESC,id LIMIT ? OFFSET ?"); values.push((limit as i64).into()); values.push((offset as i64).into());
        let mut statement=connection.prepare(&sql).map_err(internal)?;
        let rows=statement.query_map(rusqlite::params_from_iter(values), |row| {
            let indexes: Value=serde_json::from_str(&row.get::<_,String>(4)?).unwrap_or(Value::Null);
            let display: Value=serde_json::from_str(&row.get::<_,String>(5)?).unwrap_or(Value::Null);
            let secret_fields: Value=serde_json::from_str(&row.get::<_,String>(9)?).unwrap_or(Value::Array(vec![]));
            Ok(json!({"id":row.get::<_,String>(0)?,"dataset_id":row.get::<_,String>(1)?,"category":row.get::<_,String>(2)?,"environment":row.get::<_,Option<String>>(3)?,"indexes":indexes,"display":display,"updated":row.get::<_,String>(6)?,"duplicate_of":row.get::<_,Option<String>>(7)?,"secret_count":row.get::<_,i64>(8)?,"secret_fields":secret_fields,"expired":row.get::<_,bool>(10)?}))
        }).map_err(internal)?;
        let mut records=Vec::new(); for row in rows { records.push(row.map_err(internal)?); }
        Ok(Json(json!({"records":records,"page":query.page.max(1),"limit":limit,"total":total})))
    }).await
}

#[derive(Deserialize)]
struct RevealRequest {
    field_name: String,
}

async fn reveal_secret(
    State(state): State<AppState>,
    Path(record_id): Path<String>,
    Json(request): Json<RevealRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, keys| {
        let (nonce,ciphertext,zone): (Vec<u8>,Vec<u8>,String)=connection.query_row("SELECT nonce,ciphertext,zone FROM protected_fields WHERE record_id=?1 AND source_key=?2 AND zone='secrets'",params![record_id,request.field_name],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(internal)?.ok_or_else(||ApiError(StatusCode::NOT_FOUND,"secret field not found".into()))?;
        let value=open_field(&keys.field,&record_id,&request.field_name,&nonce,&ciphertext)?;
        connection.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('reveal',?1,?2)",params![record_id,request.field_name]).map_err(internal)?;
        Ok(Json(json!({"field_name":request.field_name,"zone":zone,"value":value,"expires_in_seconds":30})))
    }).await
}
