use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce, aead::Aead};
use argon2::Argon2;
use axum::{
    Json, Router,
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use calamine::{Reader, open_workbook_auto_from_rs};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
#[cfg(debug_assertions)]
use tower_http::services::ServeDir;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

type HmacSha256 = Hmac<Sha256>;

#[cfg(any(not(debug_assertions), test))]
use axum::http::Uri;
#[cfg(any(not(debug_assertions), test))]
include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

#[cfg(any(not(debug_assertions), test))]
async fn serve_embedded_web(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match embedded_asset(path) {
        Some((body, content_type)) => (
            [(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache")],
            body,
        ).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Clone)]
struct AppState {
    runtime: Arc<Mutex<Runtime>>,
    data_dir: PathBuf,
    batches: Arc<Mutex<std::collections::HashMap<String, (Instant, Vec<Value>)>>>,
}

struct StartupOptions {
    data_dir: PathBuf,
    address: SocketAddr,
    password: Option<Zeroizing<String>>,
}

struct Runtime {
    keys: Option<KeySet>,
    unlocked_at: Option<Instant>,
    last_activity: Option<Instant>,
    persistent: bool,
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

fn app_key_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn validate_permission(permission: &str) -> bool {
    matches!(permission, "search" | "secrets")
}

fn authorize_app(connection: &Connection, headers: &HeaderMap, required: &str) -> ApiResult<()> {
    let app_id = headers.get("x-app-id").and_then(|v| v.to_str().ok());
    let app_key = headers.get("x-app-key").and_then(|v| v.to_str().ok());
    if app_id.is_none() && app_key.is_none() { return Ok(()); }
    let (Some(app_id), Some(app_key)) = (app_id, app_key) else { return Err(ApiError(StatusCode::UNAUTHORIZED, "both X-App-Id and X-App-Key are required".into())); };
    let row: Option<(String, bool, String, Option<i64>)> = connection.query_row("SELECT permission,disabled,datasets_json,access_expires_at FROM api_apps WHERE id=?1 AND key_hash=?2", params![app_id, app_key_hash(app_key)], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional().map_err(internal)?;
    let Some((permission, disabled, _, access_expires_at)) = row else { return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid app credentials".into())); };
    if disabled { return Err(ApiError(StatusCode::FORBIDDEN, "app is disabled".into())); }
    if access_expires_at.is_some_and(|expires| expires <= unix_now()) { return Err(ApiError(StatusCode::FORBIDDEN, "app authorization has expired".into())); }
    if required == "secrets" && permission != "secrets" { return Err(ApiError(StatusCode::FORBIDDEN, "app does not have secrets permission".into())); }
    Ok(())
}

fn authorize_app_dataset(connection: &Connection, headers: &HeaderMap, dataset_id: &str, required: &str) -> ApiResult<()> {
    authorize_app(connection, headers, required)?;
    let app_id = headers.get("x-app-id").and_then(|v| v.to_str().ok());
    let app_key = headers.get("x-app-key").and_then(|v| v.to_str().ok());
    let (Some(app_id), Some(app_key)) = (app_id, app_key) else { return Ok(()); };
    let datasets_json: String = connection.query_row("SELECT datasets_json FROM api_apps WHERE id=?1 AND key_hash=?2", params![app_id, app_key_hash(app_key)], |row| row.get(0)).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "invalid app credentials".into()))?;
    let datasets: Vec<String> = serde_json::from_str(&datasets_json).unwrap_or_default();
    if !datasets.iter().any(|allowed| allowed == dataset_id) { return Err(ApiError(StatusCode::FORBIDDEN, "app is not authorized for this dataset".into())); }
    Ok(())
}

fn authorized_dataset_scope(connection: &Connection, headers: &HeaderMap, required: &str) -> ApiResult<Option<Vec<String>>> {
    authorize_app(connection, headers, required)?;
    let Some(app_id) = headers.get("x-app-id").and_then(|value| value.to_str().ok()) else { return Ok(None); };
    let datasets_json: String = connection.query_row(
        "SELECT datasets_json FROM api_apps WHERE id=?1",
        [app_id],
        |row| row.get(0),
    ).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "invalid app credentials".into()))?;
    Ok(Some(serde_json::from_str(&datasets_json).unwrap_or_default()))
}

fn normalized_app_datasets(connection: &Connection, datasets: &[String]) -> ApiResult<Vec<String>> {
    let mut normalized = Vec::new();
    for dataset_id in datasets.iter().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        if normalized.iter().any(|existing| existing == dataset_id) { continue; }
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM datasets WHERE id=?1)",
            [dataset_id],
            |row| row.get(0),
        ).map_err(internal)?;
        if !exists { return Err(bad_request(format!("unknown dataset: {dataset_id}"))); }
        normalized.push(dataset_id.to_owned());
    }
    Ok(normalized)
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
}

#[derive(Deserialize, Clone, Serialize)]
struct FieldDefinition {
    source_key: String,
    #[serde(default)]
    previous_source_key: Option<String>,
    #[serde(default)]
    display_name: String,
    #[serde(default = "default_zone")]
    zone: String,
    #[serde(default)]
    unique: bool,
    #[serde(default)]
    position: usize,
}

#[derive(Deserialize, Clone, Serialize)]
struct ListFieldDefinition {
    source_key: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    position: usize,
    #[serde(default = "default_list_format")]
    format: String,
    #[serde(default = "default_list_visible")]
    visible: bool,
}

fn default_list_format() -> String { "single_line".into() }
fn default_list_visible() -> bool { true }

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
    #[serde(default)]
    list_fields: Vec<ListFieldDefinition>,
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
    #[serde(default)]
    list_fields: Option<Vec<ListFieldDefinition>>,
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

#[derive(Deserialize)]
struct AppCreateRequest {
    name: String,
    #[serde(default = "default_app_permission")]
    permission: String,
    #[serde(default)]
    datasets: Vec<String>,
    #[serde(default)]
    access_ttl_seconds: Option<i64>,
}

#[derive(Deserialize)]
struct AppUpdateRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    permission: Option<String>,
    #[serde(default)]
    disabled: Option<bool>,
    #[serde(default)]
    datasets: Option<Vec<String>>,
    #[serde(default)]
    access_ttl_seconds: Option<i64>,
}

#[derive(Deserialize, Default)]
struct ExportQuery {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    include_secrets: bool,
}

fn default_app_permission() -> String {
    "search".into()
}

fn default_page() -> usize {
    1
}
fn default_limit() -> usize {
    40
}

fn parse_startup_options(root: &FsPath) -> Result<StartupOptions, Box<dyn std::error::Error>> {
    let mut data_dir = std::env::var_os("SECUREVAULT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("data"));
    let mut address = std::env::var("SECUREVAULT_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:4173".into())
        .parse::<SocketAddr>()?;
    let mut password = std::env::var("SECUREVAULT_PASSWORD").ok();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--data-dir" => {
                index += 1;
                data_dir = PathBuf::from(args.get(index).ok_or("--data-dir requires a path")?);
            }
            "--port" => {
                index += 1;
                let port: u16 = args.get(index).ok_or("--port requires a number")?.parse()?;
                address.set_port(port);
            }
            "--addr" => {
                index += 1;
                address = args.get(index).ok_or("--addr requires host:port")?.parse()?;
            }
            "--password" => {
                index += 1;
                password = Some(args.get(index).ok_or("--password requires a value")?.clone());
                eprintln!("warning: --password may be visible in the process list; prefer SECUREVAULT_PASSWORD or --password-stdin");
            }
            "--password-stdin" => {
                use std::io::Read;
                let mut value = String::new();
                std::io::stdin().read_to_string(&mut value)?;
                password = Some(value.trim_end_matches(['\r', '\n']).to_owned());
            }
            "--help" | "-h" => {
                println!("SecureVault options: --data-dir PATH --port PORT --addr HOST:PORT --password-stdin");
                std::process::exit(0);
            }
            unknown => return Err(format!("unknown argument: {unknown}").into()),
        }
        index += 1;
    }
    Ok(StartupOptions {
        data_dir,
        address,
        password: password.map(Zeroizing::new),
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Release binaries are self-contained; debug builds read the project's web directory.
    let executable = std::env::current_exe()?;
    let executable_dir = executable.parent().ok_or("executable has no parent directory")?;
    let root = if !cfg!(debug_assertions) {
        executable_dir.to_path_buf()
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    };
    let options = parse_startup_options(&root)?;
    let data_dir = options.data_dir;
    fs::create_dir_all(&data_dir)?;
    #[cfg(debug_assertions)]
    let web_dir = root.join("web");
    let state = AppState {
        runtime: Arc::new(Mutex::new(Runtime {
            keys: None,
            unlocked_at: None,
            last_activity: None,
            persistent: false,
        })),
        data_dir,
        batches: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    if let Some(password) = options.password {
        let password = password.as_str();
        if meta_path(&state).exists() {
            let meta: VaultMeta = serde_json::from_slice(&fs::read(meta_path(&state))?)?;
            let salt = hex::decode(meta.salt)?;
            let keys = derive_keys(password, &salt).map_err(|e| std::io::Error::other(e.1))?;
            if verifier(&keys.db) != meta.verifier {
                return Err("startup password does not match the vault".into());
            }
            let connection = open_database(&database_path(&state), &keys.db).map_err(|e| std::io::Error::other(e.1))?;
            initialize_schema(&connection).map_err(|e| std::io::Error::other(e.1))?;
            drop(connection);
            activate(&state, keys, true).await;
        } else {
            if password.len() < 12 {
                return Err("startup password must be at least 12 bytes".into());
            }
            let mut salt = [0u8; 16];
            OsRng.fill_bytes(&mut salt);
            let keys = derive_keys(password, &salt).map_err(|e| std::io::Error::other(e.1))?;
            let meta = VaultMeta { salt: hex::encode(salt), verifier: verifier(&keys.db) };
            fs::write(meta_path(&state), serde_json::to_vec(&meta)?)?;
            let connection = open_database(&database_path(&state), &keys.db).map_err(|e| std::io::Error::other(e.1))?;
            initialize_schema(&connection).map_err(|e| std::io::Error::other(e.1))?;
            drop(connection);
            activate(&state, keys, true).await;
        }
    }

    let api = Router::new()
        .route("/vault/status", get(vault_status))
        .route("/vault/setup", post(vault_setup))
        .route("/vault/unlock", post(vault_unlock))
        .route("/vault/seal", post(vault_seal))
        .route("/datasets/schema-preview", post(schema_preview))
        .route("/datasets", get(list_datasets).post(create_dataset))
        .route("/datasets/{id}", axum::routing::patch(update_dataset))
        .route("/datasets/{id}/export", get(export_dataset))
        .route("/datasets/{id}/templates", get(list_import_templates))
        .route("/datasets/tree", get(dataset_tree))
        .route("/vault/summary", get(vault_summary))
        .route("/imports/upload", post(upload_import))
        .route("/records/import", post(import_records))
        .route("/records/{id}/expired", post(set_expired))
        .route("/records/{id}", get(record_detail))
        .route("/records/search", get(search_records))
        .route("/records/{id}/secrets/reveal", post(reveal_secret))
        .route("/apps", get(list_apps).post(create_app))
        .route("/apps/{id}", axum::routing::patch(update_app).delete(delete_app))
        .route("/apps/{id}/rotate", post(rotate_app))
        .with_state(state.clone());

    let app = Router::new()
        .nest("/api", api)
        .with_state(state);
    #[cfg(debug_assertions)]
    let app = app.fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true));
    #[cfg(not(debug_assertions))]
    let app = app.fallback(get(serve_embedded_web));
    let address = options.address;
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

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
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
           conflict_strategy TEXT NOT NULL, list_fields_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    connection.execute_batch("CREATE TABLE IF NOT EXISTS import_templates(name TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, mappings_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS api_apps(id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, permission TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, datasets_json TEXT NOT NULL DEFAULT '[]', access_expires_at INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);").map_err(internal)?;
    let has_list_fields: bool = connection.prepare("PRAGMA table_info(datasets)").map_err(internal)?.query_map([], |row| row.get::<_, String>(1)).map_err(internal)?.filter_map(Result::ok).any(|name| name == "list_fields_json");
    if !has_list_fields { connection.execute("ALTER TABLE datasets ADD COLUMN list_fields_json TEXT NOT NULL DEFAULT '[]'", []).map_err(internal)?; }
    let has_datasets: bool = connection.prepare("PRAGMA table_info(api_apps)").map_err(internal)?.query_map([], |row| row.get::<_, String>(1)).map_err(internal)?.filter_map(Result::ok).any(|name| name == "datasets_json");
    if !has_datasets { connection.execute("ALTER TABLE api_apps ADD COLUMN datasets_json TEXT NOT NULL DEFAULT '[]'", []).map_err(internal)?; }
    let has_access_expiry: bool = connection.prepare("PRAGMA table_info(api_apps)").map_err(internal)?.query_map([], |row| row.get::<_, String>(1)).map_err(internal)?.filter_map(Result::ok).any(|name| name == "access_expires_at");
    if !has_access_expiry { connection.execute("ALTER TABLE api_apps ADD COLUMN access_expires_at INTEGER", []).map_err(internal)?; }
    Ok(())
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
    Json(json!({ "initialized": meta_path(&state).exists(), "sealed": runtime.keys.is_none(), "persistent": runtime.persistent, "idle_seconds_remaining": idle, "ttl_seconds_remaining": ttl }))
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
    activate(&state, keys, false).await;
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
    activate(&state, keys, false).await;
    Ok(Json(json!({ "sealed": false })))
}

async fn activate(state: &AppState, keys: KeySet, persistent: bool) {
    let mut runtime = state.runtime.lock().await;
    runtime.keys = Some(keys);
    runtime.unlocked_at = Some(Instant::now());
    runtime.last_activity = runtime.unlocked_at;
    runtime.persistent = persistent;
}

async fn vault_seal(State(state): State<AppState>) -> Json<Value> {
    let mut runtime = state.runtime.lock().await;
    runtime.keys = None;
    runtime.unlocked_at = None;
    runtime.last_activity = None;
    runtime.persistent = false;
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
    if !runtime.persistent && (runtime
        .unlocked_at
        .is_some_and(|start| start.elapsed() >= Duration::from_secs(4 * 60 * 60))
        || runtime
            .last_activity
            .is_some_and(|last| last.elapsed() >= Duration::from_secs(30 * 60)))
    {
        runtime.keys = None;
        runtime.unlocked_at = None;
        runtime.last_activity = None;
        runtime.persistent = false;
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
                previous_source_key: None,
                display_name: source_key.clone(),
                zone: guess_zone(&source_key).into(),
                unique: false,
                position: 0,
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

fn insert_nested_value(root: &mut serde_json::Map<String, Value>, path: &str, value: Value) {
    let mut segments = path.split('.').peekable();
    let Some(first) = segments.next() else { return; };
    if segments.peek().is_none() { root.insert(first.to_owned(), value); return; }
    let entry = root.entry(first.to_owned()).or_insert_with(|| Value::Object(Default::default()));
    if !entry.is_object() { *entry = Value::Object(Default::default()); }
    if let Value::Object(object) = entry { insert_nested_value(object, &segments.collect::<Vec<_>>().join("."), value); }
}

fn migrate_schema_records(
    connection: &Connection,
    keys: &KeySet,
    dataset_id: &str,
    old_definitions: &[FieldDefinition],
    new_definitions: &[FieldDefinition],
    identity_fields: &[String],
    category: &str,
    environment: Option<&str>,
) -> ApiResult<()> {
    let records: Vec<(String, String, String)> = {
        let mut statement = connection.prepare("SELECT id,indexes_json,display_json FROM records WHERE dataset_id=?1").map_err(internal)?;
        statement.query_map([dataset_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(internal)?.collect::<Result<Vec<_>, _>>().map_err(internal)?
    };
    let old_by_key: std::collections::HashMap<String, &FieldDefinition> = old_definitions.iter().map(|field| (field.source_key.clone(), field)).collect();
    for (record_id, indexes_json, display_json) in records {
        let indexes: serde_json::Map<String, Value> = serde_json::from_str::<Value>(&indexes_json).ok().and_then(|value| value.as_object().cloned()).unwrap_or_default();
        let display: serde_json::Map<String, Value> = serde_json::from_str::<Value>(&display_json).ok().and_then(|value| value.as_object().cloned()).unwrap_or_default();
        let protected_rows: Vec<(String, String, Vec<u8>, Vec<u8>)> = {
            let mut statement = connection.prepare("SELECT source_key,zone,nonce,ciphertext FROM protected_fields WHERE record_id=?1").map_err(internal)?;
            statement.query_map([&record_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map_err(internal)?.collect::<Result<Vec<_>, _>>().map_err(internal)?
        };
        let mut values: std::collections::BTreeMap<String, (String, Value)> = std::collections::BTreeMap::new();
        for (key, value) in indexes { values.insert(key, ("indexes".into(), value)); }
        for (key, value) in display { values.insert(key, ("display".into(), value)); }
        for (key, zone, nonce, ciphertext) in protected_rows {
            values.insert(key.clone(), (zone, open_field(&keys.field, &record_id, &key, &nonce, &ciphertext)?));
        }
        let mut output: std::collections::BTreeMap<String, (String, Value)> = std::collections::BTreeMap::new();
        let mut consumed = std::collections::HashSet::new();
        for field in new_definitions {
            let old_key = field.previous_source_key.as_deref().filter(|key| old_by_key.contains_key(*key)).unwrap_or(&field.source_key);
            if let Some((_, value)) = values.get(old_key) { output.insert(field.source_key.clone(), (field.zone.clone(), value.clone())); consumed.insert(old_key.to_owned()); }
        }
        for (key, value) in values { if !consumed.contains(&key) { output.insert(key, value); } }
        let mut next_indexes = serde_json::Map::new();
        let mut next_display = serde_json::Map::new();
        for (key, (zone, value)) in &output { if zone == "display" { next_display.insert(key.clone(), value.clone()); } else if zone != "hidden" && zone != "secrets" { next_indexes.insert(key.clone(), value.clone()); } }
        connection.execute("DELETE FROM protected_fields WHERE record_id=?1", [&record_id]).map_err(internal)?;
        for (key, (zone, value)) in &output { if zone == "hidden" || zone == "secrets" { let (nonce, ciphertext) = seal_field(&keys.field, &record_id, key, value)?; connection.execute("INSERT INTO protected_fields(record_id,source_key,zone,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5)", params![record_id, key, zone, nonce, ciphertext]).map_err(internal)?; } }
        let mut identity_input = serde_json::Map::new();
        for (key, (_, value)) in &output { insert_nested_value(&mut identity_input, key, value.clone()); }
        let identity_hash_value = identity_hash(&keys.identity, dataset_id, identity_fields, &Value::Object(identity_input));
        let indexes_value = Value::Object(next_indexes);
        let display_value = Value::Object(next_display);
        let blob = search_blob(category, environment, &indexes_value, &display_value);
        connection.execute("UPDATE records SET indexes_json=?2,display_json=?3,search_blob=?4,identity_hash=?5 WHERE id=?1", params![record_id, indexes_value.to_string(), display_value.to_string(), blob, identity_hash_value]).map_err(internal)?;
    }
    Ok(())
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

#[derive(Clone, Copy)]
enum SearchOperator { Contains, Exact, Prefix, Suffix, Regex }

#[derive(Clone)]
struct SearchClause { field: Option<String>, operator: SearchOperator, value: String }

fn parse_search_clauses(query: &str) -> ApiResult<Vec<SearchClause>> {
    query_terms(query).into_iter().map(|term| {
        let (field, raw) = term.split_once(':').map(|(field, value)| (Some(field.to_lowercase()), value.to_owned())).unwrap_or((None, term));
        let (operator, mut value) = match raw.chars().next() {
            Some('=') => (SearchOperator::Exact, raw[1..].to_owned()),
            Some('^') => (SearchOperator::Prefix, raw[1..].to_owned()),
            Some('$') => (SearchOperator::Suffix, raw[1..].to_owned()),
            Some('~') => (SearchOperator::Regex, raw[1..].trim_matches('/').to_owned()),
            _ => (SearchOperator::Contains, raw),
        };
        if matches!(operator, SearchOperator::Regex) { Regex::new(&value).map_err(|error| bad_request(format!("invalid search regex: {error}")))?; }
        if value.is_empty() { return Err(bad_request("search operator requires a value")); }
        Ok(SearchClause { field, operator, value: { if matches!(operator, SearchOperator::Regex) { value } else { std::mem::take(&mut value) } } })
    }).collect()
}

fn value_text(value: &Value) -> String { value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()) }

fn matches_value(value: &str, clause: &SearchClause) -> bool {
    match clause.operator {
        SearchOperator::Contains => value.to_lowercase().contains(&clause.value.to_lowercase()),
        SearchOperator::Exact => value.eq_ignore_ascii_case(&clause.value),
        SearchOperator::Prefix => value.to_lowercase().starts_with(&clause.value.to_lowercase()),
        SearchOperator::Suffix => value.to_lowercase().ends_with(&clause.value.to_lowercase()),
        SearchOperator::Regex => Regex::new(&clause.value).map(|regex| regex.is_match(value)).unwrap_or(false),
    }
}

fn clause_fields(clause: &SearchClause, category: &str, environment: Option<&str>, dataset_id: &str, indexes: &Value, display: &Value) -> Vec<(String, Value)> {
    match clause.field.as_deref() {
        Some("category") => vec![("category".into(), Value::String(category.to_owned()))],
        Some("env") | Some("environment") => environment.map(|value| vec![("environment".into(), Value::String(value.to_owned()))]).unwrap_or_default(),
        Some("dataset") | Some("dataset_id") => vec![("dataset".into(), Value::String(dataset_id.to_owned()))],
        Some(field) => {
            let key = field.strip_prefix("indexes.").or_else(|| field.strip_prefix("display.")).unwrap_or(field);
            indexes.as_object().and_then(|map| map.iter().find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))).map(|(candidate, value)| vec![(candidate.clone(), value.clone())]).or_else(|| display.as_object().and_then(|map| map.iter().find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))).map(|(candidate, value)| vec![(candidate.clone(), value.clone())])).unwrap_or_default()
        }
        None => {
            let mut fields = vec![("category".into(), Value::String(category.to_owned()))];
            if let Some(environment) = environment { fields.push(("environment".into(), Value::String(environment.to_owned()))); }
            fields.extend(indexes.as_object().into_iter().flat_map(|map| map.iter()).map(|(key, value)| (key.clone(), value.clone())));
            fields.extend(display.as_object().into_iter().flat_map(|map| map.iter()).map(|(key, value)| (key.clone(), value.clone())));
            fields
        }
    }
}

fn clause_matches(field: &str, value: &Value, clause: &SearchClause) -> bool {
    let value = value_text(value);
    if field == "category" && matches!(clause.operator, SearchOperator::Exact) {
        return value.eq_ignore_ascii_case(&clause.value)
            || value.get(..clause.value.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(&clause.value))
                && value.as_bytes().get(clause.value.len()) == Some(&b'/');
    }
    matches_value(&value, clause)
}

fn record_matches(clauses: &[SearchClause], category: &str, environment: Option<&str>, dataset_id: &str, indexes: &Value, display: &Value) -> bool {
    clauses.iter().all(|clause| clause_fields(clause, category, environment, dataset_id, indexes, display).iter().any(|(field, value)| clause_matches(field, value, clause)))
}

fn matched_fields(clauses: &[SearchClause], category: &str, environment: Option<&str>, dataset_id: &str, indexes: &Value, display: &Value) -> Vec<String> {
    let mut fields = Vec::new();
    for clause in clauses { for (field, value) in clause_fields(clause, category, environment, dataset_id, indexes, display) { if clause_matches(&field, &value, clause) && !fields.iter().any(|item| item == &field) { fields.push(field); } } }
    fields
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
        let list_fields = if request.list_fields.is_empty() {
            request.fields.iter().filter(|field| matches!(field.zone.as_str(), "indexes" | "display")).enumerate().map(|(position, field)| ListFieldDefinition { source_key: field.source_key.clone(), display_name: field.display_name.clone(), position, format: default_list_format(), visible: true }).collect::<Vec<_>>()
        } else { request.list_fields.clone() };
        let list_fields_json = serde_json::to_string(&list_fields).map_err(internal)?;
        connection.execute("INSERT INTO datasets(id,category_path,environment,fields_json,identity_fields_json,conflict_strategy,list_fields_json) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![dataset_id, category, environment, definitions_json, identity_json, request.conflict_strategy, list_fields_json]).map_err(internal)?;
        let import = if records.is_empty() { json!({"imported":0,"record_ids":[],"duplicates":[]}) } else { insert_records(connection, keys, &dataset_id, &category, environment.as_deref(), &request.fields, &request.identity_fields, &records, false)? };
        Ok(Json(json!({ "dataset_id": dataset_id, "category_path": category, "environment": environment, "fields": request.fields, "identity_fields": request.identity_fields, "import": import })))
    }).await
}

async fn update_dataset(
    State(state): State<AppState>,
    Path(dataset_id): Path<String>,
    Json(request): Json<DatasetUpdate>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, keys| {
        let (old_category, old_environment, old_fields, old_identity, old_list_fields): (String, Option<String>, String, String, String) = connection.query_row(
            "SELECT category_path,environment,fields_json,identity_fields_json,list_fields_json FROM datasets WHERE id=?1", [&dataset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        ).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "dataset not found".into()))?;
        let category = request.category_path.as_deref().map(normalize_category).transpose()?.unwrap_or(old_category);
        let environment = if request.clear_environment { None } else { request.environment.map(|v| if v.trim().is_empty() { None } else { Some(v.trim().to_owned()) }).unwrap_or(old_environment) };
        let old_definitions: Vec<FieldDefinition> = serde_json::from_str(&old_fields).map_err(internal)?;
        let new_definitions = if let Some(new_fields) = request.fields {
            let mut definitions = old_definitions.clone();
            if request.merge_fields {
                for field in new_fields { if let Some(existing) = definitions.iter_mut().find(|item| item.source_key == field.source_key) { *existing = field; } else { definitions.push(field); } }
            } else { definitions = new_fields; }
            definitions
        } else { old_definitions.clone() };
        let mut normalized_definitions = new_definitions.clone();
        for field in &mut normalized_definitions { field.previous_source_key = None; }
        let fields = serde_json::to_string(&normalized_definitions).map_err(internal)?;
        let identity_fields: Vec<String> = request.identity_fields.clone().unwrap_or_else(|| serde_json::from_str(&old_identity).unwrap_or_default());
        let identity = serde_json::to_string(&identity_fields).map_err(internal)?;
        let list_fields = request.list_fields.unwrap_or_else(|| serde_json::from_str(&old_list_fields).unwrap_or_default());
        let list_fields_json = serde_json::to_string(&list_fields).map_err(internal)?;
        connection.execute("UPDATE datasets SET category_path=?2,environment=?3,fields_json=?4,identity_fields_json=?5,list_fields_json=?6 WHERE id=?1", params![dataset_id, category, environment, fields, identity, list_fields_json]).map_err(internal)?;
        connection.execute("UPDATE records SET category_path=?2,environment=?3 WHERE dataset_id=?1", params![dataset_id, category, environment]).map_err(internal)?;
        migrate_schema_records(connection, keys, &dataset_id, &old_definitions, &new_definitions, &identity_fields, &category, environment.as_deref())?;
        Ok(Json(json!({"id":dataset_id,"category_path":category,"environment":environment,"list_fields":list_fields})))
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
        let mut statement = connection.prepare("SELECT d.id,d.category_path,d.environment,d.fields_json,d.identity_fields_json,d.conflict_strategy,d.list_fields_json,COUNT(r.id) FROM datasets d LEFT JOIN records r ON r.dataset_id=d.id GROUP BY d.id ORDER BY d.category_path").map_err(internal)?;
        let rows = statement.query_map([], |row| Ok(json!({ "id": row.get::<_,String>(0)?, "category_path": row.get::<_,String>(1)?, "environment": row.get::<_,Option<String>>(2)?, "fields": serde_json::from_str::<Value>(&row.get::<_,String>(3)?).unwrap_or(Value::Array(vec![])), "identity_fields": serde_json::from_str::<Value>(&row.get::<_,String>(4)?).unwrap_or(Value::Array(vec![])), "conflict_strategy": row.get::<_,String>(5)?, "list_fields": serde_json::from_str::<Value>(&row.get::<_,String>(6)?).unwrap_or(Value::Array(vec![])), "record_count": row.get::<_,i64>(7)? }))).map_err(internal)?;
        let mut datasets = Vec::new(); for row in rows { datasets.push(row.map_err(internal)?); }
        Ok(Json(json!({ "datasets": datasets })))
    }).await
}

async fn export_dataset(
    State(state): State<AppState>,
    Path(dataset_id): Path<String>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let format = query.format.as_deref().unwrap_or("json");
    if !matches!(format, "json" | "csv") { return Err(bad_request("export format must be json or csv")); }
    with_connection(&state, |connection, keys| {
        authorize_app_dataset(connection, &headers, &dataset_id, if query.include_secrets { "secrets" } else { "search" })?;
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM datasets WHERE id=?1)", [&dataset_id], |row| row.get(0)).map_err(internal)?;
        if !exists { return Err(ApiError(StatusCode::NOT_FOUND, "dataset not found".into())); }
        let mut statement = connection.prepare("SELECT id,indexes_json,display_json FROM records WHERE dataset_id=?1 ORDER BY id").map_err(internal)?;
        let base_rows = statement.query_map([&dataset_id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?))).map_err(internal)?.collect::<Result<Vec<_>, _>>().map_err(internal)?;
        let mut records = Vec::new();
        for (id, indexes_json, display_json) in base_rows {
            let indexes: Value = serde_json::from_str(&indexes_json).unwrap_or(Value::Object(Default::default()));
            let display: Value = serde_json::from_str(&display_json).unwrap_or(Value::Object(Default::default()));
            let mut record = serde_json::Map::new();
            if let Some(map) = indexes.as_object() { for (field, value) in map { record.insert(field.clone(), value.clone()); } }
            if let Some(map) = display.as_object() { for (field, value) in map { record.insert(field.clone(), value.clone()); } }
            if query.include_secrets {
                let mut secret_statement = connection.prepare("SELECT source_key,nonce,ciphertext FROM protected_fields WHERE record_id=?1 ORDER BY source_key").map_err(internal)?;
                let encrypted = secret_statement.query_map([&id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,Vec<u8>>(1)?, row.get::<_,Vec<u8>>(2)?))).map_err(internal)?.collect::<Result<Vec<_>, _>>().map_err(internal)?;
                for (field, nonce, ciphertext) in encrypted { record.insert(field.clone(), open_field(&keys.field, &id, &field, &nonce, &ciphertext)?); }
            }
            records.push(Value::Object(record));
        }
        let filename = format!("securevault-{dataset_id}.{format}");
        let (content_type, bytes) = if format == "csv" {
            let mut writer = csv::Writer::from_writer(Vec::new());
            let mut columns = Vec::new();
            for record in &records { if let Some(map) = record.as_object() { for field in map.keys() { if !columns.contains(field) { columns.push(field.clone()); } } } }
            writer.write_record(&columns).map_err(internal)?;
            for record in &records { let row = columns.iter().map(|field| record.get(field).map(|value| if value.is_string() { value.as_str().unwrap_or_default().to_owned() } else { value.to_string() }).unwrap_or_default()).collect::<Vec<_>>(); writer.write_record(row).map_err(internal)?; }
            ("text/csv; charset=utf-8", writer.into_inner().map_err(internal)?)
        } else { ("application/json", serde_json::to_vec_pretty(&Value::Array(records)).map_err(internal)?) };
        connection.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('dataset_export',?1,?2)", params![dataset_id, if query.include_secrets { "with_secrets" } else { "without_secrets" }]).map_err(internal)?;
        let mut response = bytes.into_response();
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(content_type).map_err(internal)?);
        response.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")).map_err(internal)?);
        Ok(response)
    }).await
}

async fn list_apps(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let mut statement = connection.prepare("SELECT id,name,permission,disabled,datasets_json,access_expires_at,created_at FROM api_apps ORDER BY created_at DESC").map_err(internal)?;
        let rows = statement.query_map([], |row| Ok(json!({"id": row.get::<_,String>(0)?, "name": row.get::<_,String>(1)?, "permission": row.get::<_,String>(2)?, "disabled": row.get::<_,bool>(3)?, "datasets": serde_json::from_str::<Value>(&row.get::<_,String>(4)?).unwrap_or(Value::Array(vec![])), "access_expires_at": row.get::<_,Option<i64>>(5)?, "created_at": row.get::<_,String>(6)?}))).map_err(internal)?;
        Ok(Json(json!({"apps": rows.collect::<Result<Vec<_>, _>>().map_err(internal)?})))
    }).await
}

async fn create_app(State(state): State<AppState>, Json(request): Json<AppCreateRequest>) -> ApiResult<Json<Value>> {
    if request.name.trim().is_empty() { return Err(bad_request("app name is required")); }
    if !validate_permission(&request.permission) { return Err(bad_request("permission must be search or secrets")); }
    let id = format!("app_{}", Uuid::new_v4().simple());
    let raw_key = format!("svk_{}", Uuid::new_v4().simple());
    with_connection(&state, |connection, _| {
        let datasets = normalized_app_datasets(connection, &request.datasets)?;
        let access_expires_at = request.access_ttl_seconds.filter(|ttl| *ttl > 0).map(|ttl| unix_now() + ttl);
        connection.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json,access_expires_at) VALUES(?1,?2,?3,?4,?5,?6)", params![id, request.name.trim(), app_key_hash(&raw_key), request.permission, serde_json::to_string(&datasets).map_err(internal)?, access_expires_at]).map_err(internal)?;
        Ok(Json(json!({"id": id, "name": request.name.trim(), "key": raw_key, "permission": request.permission, "datasets": datasets, "access_expires_at": access_expires_at, "disabled": false})))
    }).await
}

async fn update_app(State(state): State<AppState>, Path(app_id): Path<String>, Json(request): Json<AppUpdateRequest>) -> ApiResult<Json<Value>> {
    if let Some(permission) = request.permission.as_deref() { if !validate_permission(permission) { return Err(bad_request("permission must be search or secrets")); } }
    with_connection(&state, |connection, _| {
        let datasets_json = request.datasets.as_ref().map(|items| normalized_app_datasets(connection, items)).transpose()?.map(|items| serde_json::to_string(&items).map_err(internal)).transpose()?;
        let changed = if let Some(ttl) = request.access_ttl_seconds {
            let access_expires_at = if ttl > 0 { Some(unix_now() + ttl) } else { None };
            connection.execute("UPDATE api_apps SET name=COALESCE(?2,name),permission=COALESCE(?3,permission),disabled=COALESCE(?4,disabled),datasets_json=COALESCE(?5,datasets_json),access_expires_at=?6 WHERE id=?1", params![app_id, request.name.as_deref().map(str::trim), request.permission, request.disabled, datasets_json, access_expires_at]).map_err(internal)?
        } else {
            connection.execute("UPDATE api_apps SET name=COALESCE(?2,name),permission=COALESCE(?3,permission),disabled=COALESCE(?4,disabled),datasets_json=COALESCE(?5,datasets_json) WHERE id=?1", params![app_id, request.name.as_deref().map(str::trim), request.permission, request.disabled, datasets_json]).map_err(internal)?
        };
        if changed == 0 { return Err(ApiError(StatusCode::NOT_FOUND, "app not found".into())); }
        Ok(Json(json!({"id": app_id, "updated": true})))
    }).await
}

async fn delete_app(State(state): State<AppState>, Path(app_id): Path<String>) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let changed = connection.execute("DELETE FROM api_apps WHERE id=?1", [&app_id]).map_err(internal)?;
        if changed == 0 { return Err(ApiError(StatusCode::NOT_FOUND, "app not found".into())); }
        Ok(Json(json!({"id": app_id, "deleted": true})))
    }).await
}

async fn rotate_app(State(state): State<AppState>, Path(app_id): Path<String>) -> ApiResult<Json<Value>> {
    let raw_key = format!("svk_{}", Uuid::new_v4().simple());
    with_connection(&state, |connection, _| {
        let changed = connection.execute("UPDATE api_apps SET key_hash=?2 WHERE id=?1", params![app_id, app_key_hash(&raw_key)]).map_err(internal)?;
        if changed == 0 { return Err(ApiError(StatusCode::NOT_FOUND, "app not found".into())); }
        Ok(Json(json!({"id": app_id, "key": raw_key})))
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
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let limit = query.limit.clamp(1, 100);
    let offset = query.page.saturating_sub(1).saturating_mul(limit);
    let clauses = parse_search_clauses(&query.q)?;
    with_connection(&state, |connection, _| {
        let dataset_scope = authorized_dataset_scope(connection, &headers, "search")?;
        let mut sql = String::from("SELECT id,dataset_id,category_path,environment,indexes_json,display_json,updated_at,duplicate_of,(SELECT COUNT(*) FROM protected_fields p WHERE p.record_id=r.id AND p.zone='secrets'),(SELECT json_group_array(source_key) FROM protected_fields p WHERE p.record_id=r.id AND p.zone='secrets'),expired FROM records r WHERE 1=1");
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if !query.include_expired { sql.push_str(" AND expired=0"); }
        if let Some(category) = query.category.as_ref() { sql.push_str(" AND (category_path=? OR category_path LIKE ? ESCAPE '\\')"); values.push(category.clone().into()); values.push(format!("{}/%", category.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")).into()); }
        if let Some(environment) = query.environment.as_ref() { sql.push_str(" AND environment=?"); values.push(environment.clone().into()); }
        let mut statement=connection.prepare(&sql).map_err(internal)?;
        let rows=statement.query_map(rusqlite::params_from_iter(values), |row| {
            let category = row.get::<_,String>(2)?;
            let environment = row.get::<_,Option<String>>(3)?;
            let indexes: Value=serde_json::from_str(&row.get::<_,String>(4)?).unwrap_or(Value::Null);
            let display: Value=serde_json::from_str(&row.get::<_,String>(5)?).unwrap_or(Value::Null);
            let secret_fields: Value=serde_json::from_str(&row.get::<_,String>(9)?).unwrap_or(Value::Array(vec![]));
            let dataset_id = row.get::<_,String>(1)?;
            if dataset_scope.as_ref().is_some_and(|allowed| !allowed.iter().any(|candidate| candidate == &dataset_id)) { return Ok(None); }
            if !record_matches(&clauses, &category, environment.as_deref(), &dataset_id, &indexes, &display) { return Ok(None); }
            let matched = matched_fields(&clauses, &category, environment.as_deref(), &dataset_id, &indexes, &display);
            Ok(Some(json!({"id":row.get::<_,String>(0)?,"dataset_id":dataset_id,"category":category,"environment":environment,"indexes":indexes,"display":display,"updated":row.get::<_,String>(6)?,"duplicate_of":row.get::<_,Option<String>>(7)?,"secret_count":row.get::<_,i64>(8)?,"secret_fields":secret_fields,"matched_fields":matched,"expired":row.get::<_,bool>(10)?})))
        }).map_err(internal)?;
        let all_records: Vec<Value> = rows.filter_map(|row| row.map_err(internal).transpose()).collect::<ApiResult<Vec<_>>>()?;
        let total = all_records.len();
        let records = all_records.into_iter().skip(offset).take(limit).collect::<Vec<_>>();
        Ok(Json(json!({"records":records,"page":query.page.max(1),"limit":limit,"total":total})))
    }).await
}

async fn record_detail(
    State(state): State<AppState>,
    Path(record_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let row: Option<(String, String, String, Option<String>, String, String, String, Option<String>, bool)> = connection.query_row(
            "SELECT r.id,r.dataset_id,r.category_path,r.environment,r.indexes_json,r.display_json,r.updated_at,r.duplicate_of,r.expired FROM records r WHERE r.id=?1",
            [&record_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?))
        ).optional().map_err(internal)?;
        let (id, dataset_id, category, environment, indexes_json, display_json, updated, duplicate_of, expired) = row.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "record not found".into()))?;
        authorize_app_dataset(connection, &headers, &dataset_id, "search")?;
        let indexes: Value = serde_json::from_str(&indexes_json).unwrap_or(Value::Null);
        let display: Value = serde_json::from_str(&display_json).unwrap_or(Value::Null);
        let mut statement = connection.prepare("SELECT source_key,zone FROM protected_fields WHERE record_id=?1 ORDER BY source_key").map_err(internal)?;
        let protected = statement.query_map([&id], |row| Ok(json!({"field_name": row.get::<_,String>(0)?, "zone": row.get::<_,String>(1)?, "masked": "••••••••••••••••"}))).map_err(internal)?;
        let protected_fields: Vec<Value> = protected.collect::<Result<Vec<_>, _>>().map_err(internal)?;
        Ok(Json(json!({
            "id": id, "dataset_id": dataset_id, "category": category, "environment": environment,
            "indexes": indexes, "display": display, "protected_fields": protected_fields,
            "updated": updated, "duplicate_of": duplicate_of, "expired": expired
        })))
    }).await
}

#[derive(Deserialize)]
struct RevealRequest {
    field_name: String,
}

async fn reveal_secret(
    State(state): State<AppState>,
    Path(record_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RevealRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, keys| {
        let dataset_id: String = connection.query_row("SELECT dataset_id FROM records WHERE id=?1", [&record_id], |row| row.get(0)).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "record not found".into()))?;
        authorize_app_dataset(connection, &headers, &dataset_id, "secrets")?;
        let (nonce,ciphertext,zone): (Vec<u8>,Vec<u8>,String)=connection.query_row("SELECT nonce,ciphertext,zone FROM protected_fields WHERE record_id=?1 AND source_key=?2 AND zone='secrets'",params![record_id,request.field_name],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(internal)?.ok_or_else(||ApiError(StatusCode::NOT_FOUND,"secret field not found".into()))?;
        let value=open_field(&keys.field,&record_id,&request.field_name,&nonce,&ciphertext)?;
        connection.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('reveal',?1,?2)",params![record_id,request.field_name]).map_err(internal)?;
        Ok(Json(json!({"field_name":request.field_name,"zone":zone,"value":value,"expires_in_seconds":30})))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn embedded_web_serves_assets_and_rejects_unknown_paths() {
        for (path, content_type) in [
            ("/", "text/html; charset=utf-8"),
            ("/index.html", "text/html; charset=utf-8"),
            ("/styles.css?v=test", "text/css; charset=utf-8"),
            ("/app.js", "text/javascript; charset=utf-8"),
        ] {
            let response = serve_embedded_web(path.parse().unwrap()).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], content_type);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        }
        for path in ["/missing.js", "/../server/Cargo.toml", "/%2e%2e/server/Cargo.toml"] {
            assert_eq!(serve_embedded_web(path.parse().unwrap()).await.status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(embedded_asset("app.js").unwrap().0, include_bytes!("../../web/app.js"));
        assert_eq!(embedded_asset("styles.css").unwrap().0, include_bytes!("../../web/styles.css"));
    }

    #[test]
    fn combined_search_matches_directory_descendants_and_numeric_fields() {
        let clauses = parse_search_clauses("category:=husdk cid:=18").unwrap();
        let indexes = json!({"cid": 18});
        assert!(record_matches(&clauses, "husdk/hzqh/usdk", Some("prod"), "ds_1", &indexes, &json!({})));
        assert!(!record_matches(&clauses, "other/husdk", Some("prod"), "ds_1", &indexes, &json!({})));
        assert!(!record_matches(&clauses, "husdk/hzqh/usdk", Some("prod"), "ds_1", &json!({"cid": 180}), &json!({})));
    }

    #[test]
    fn structured_field_names_are_case_insensitive() {
        let clauses = parse_search_clauses("CID:^18 env:=PROD").unwrap();
        assert!(record_matches(&clauses, "husdk", Some("prod"), "ds_1", &json!({"cid": "1802"}), &json!({})));
    }
}
