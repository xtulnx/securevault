use super::*;

// Session-local operational diagnostics, not a durable security audit trail.
// Never store request URLs, queries, record/field values or credentials.
#[derive(Clone, Serialize)]
pub(super) struct AuthorizationEvent {
    id: u64,
    app_id: String,
    app_name: String,
    reason: String,
    operation: String,
    first_at: i64,
    last_at: i64,
    count: u64,
    unread: bool,
    ignored: bool,
}

#[derive(Default)]
pub(super) struct AuthorizationEvents {
    revision: u64,
    muted: bool,
    events: Vec<AuthorizationEvent>,
}
impl AuthorizationEvents {
    pub(super) fn summary(&self) -> Value {
        json!({"revision": self.revision, "muted": self.muted,
            "unread": if self.muted { 0 } else { self.events.iter().filter(|e| e.unread && !e.ignored).count() }})
    }
    fn record(&mut self, app_id: &str, app_name: &str, reason: &str, operation: &str) {
        self.revision = self.revision.saturating_add(1);
        if let Some(index) = self.events.iter().position(|e| e.app_id == app_id && e.reason == reason && e.operation == operation) {
            let mut event = self.events.remove(index);
            event.last_at = unix_now();
            event.count = event.count.saturating_add(1);
            event.app_name = app_name.to_owned();
            // Acknowledged repeated failures do not continually recreate a badge.
            self.events.insert(0, event);
        } else {
            self.events.insert(0, AuthorizationEvent { id: self.revision, app_id: app_id.into(), app_name: app_name.into(),
                reason: reason.into(), operation: operation.into(), first_at: unix_now(), last_at: unix_now(), count: 1, unread: true, ignored: false });
            self.events.truncate(100);
        }
    }
}

#[derive(Clone)]
pub(super) struct AuthorizationDenial(pub &'static str);
pub(super) fn denial_reason(message: &str) -> Option<&'static str> {
    match message {
        "app is disabled" => Some("disabled"),
        "app authorization has expired" => Some("expired"),
        "app does not have secrets permission" => Some("secrets_permission"),
        "app is not authorized for this dataset" => Some("dataset_scope"),
        "management requires an owner session" => Some("owner_required"),
        _ => None,
    }
}

// Identity is verified independently of permission/expiry. Invalid credentials never create an event.
pub(super) struct VerifiedApp { id: String, name: String, pub has_dataset: bool, pub target_allowed: bool }
#[derive(Deserialize)]
pub(super) struct Target { pub dataset_id: Option<String> }
pub(super) fn verified_app(db: &Connection, headers: &HeaderMap, target: Option<&str>) -> ApiResult<Option<VerifiedApp>> {
    let (Some(id), Some(key)) = (headers.get("x-app-id").and_then(|v| v.to_str().ok()), headers.get("x-app-key").and_then(|v| v.to_str().ok())) else { return Ok(None); };
    let row: Option<(String, bool, String)> = db.query_row("SELECT name,EXISTS(SELECT 1 FROM datasets WHERE id IN (SELECT value FROM json_each(CASE WHEN json_valid(api_apps.datasets_json) THEN api_apps.datasets_json ELSE '[]' END))),datasets_json FROM api_apps WHERE id=?1 AND key_hash=?2", params![id, app_key_hash(key)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(internal)?;
    Ok(row.map(|(name, has_dataset, raw)| {
        let scope: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        VerifiedApp { id: id.into(), name, has_dataset, target_allowed: target.is_none_or(|id| scope.iter().any(|allowed| allowed == id)) }
    }))
}
pub(super) fn operation(method: &axum::http::Method, path: &str) -> &'static str {
    if !security::app_route(method, path) { "management" }
    else if path.ends_with("/secrets/reveal") { "reveal" }
    else if path.ends_with("/export") { "export" }
    else if path == "/client/datasets" { "datasets" }
    else if path == "/records/search" { "search" }
    else { "detail" }
}

pub(super) async fn list(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let mut runtime = state.runtime.lock().await;
    expire_runtime(&mut runtime);
    if runtime.keys.is_none() { return Err(locked()); }
    // Recheck under the same lock as the snapshot/update: a session can rotate
    // after middleware approval while this handler is waiting for the mutex.
    if headers.contains_key("x-app-id") || headers.contains_key("x-app-key") || !owner_cookie(&headers, &runtime) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "owner session required".into()));
    }
    Ok(Json(json!({"session_id": runtime.session_id, "summary": runtime.authorization_events.summary(), "events": runtime.authorization_events.events})))
}

#[derive(Deserialize)]
pub(super) struct Acknowledge {
    session_id: String,
    #[serde(default)]
    seen_ids: Vec<u64>,
    ignore_id: Option<u64>,
    muted: Option<bool>,
}
pub(super) async fn acknowledge(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Acknowledge>) -> ApiResult<Json<Value>> {
    let mut runtime = state.runtime.lock().await;
    expire_runtime(&mut runtime);
    if runtime.keys.is_none() { return Err(locked()); }
    // Recheck under the same lock as the snapshot/update: a session can rotate
    // after middleware approval while this handler is waiting for the mutex.
    if headers.contains_key("x-app-id") || headers.contains_key("x-app-key") || !owner_cookie(&headers, &runtime) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "owner session required".into()));
    }
    if runtime.session_id.as_deref() != Some(body.session_id.as_str()) { return Err(ApiError(StatusCode::CONFLICT, "owner session changed".into())); }
    let session_id = runtime.session_id.clone();
    let events = &mut runtime.authorization_events;
    if body.seen_ids.len() > 100 { return Err(bad_request("too many event IDs")); }
    for event in &mut events.events {
        if body.seen_ids.contains(&event.id) { event.unread = false; }
        if Some(event.id) == body.ignore_id { event.ignored = true; event.unread = false; }
    }
    if let Some(muted) = body.muted { events.muted = muted; }
    events.revision = events.revision.saturating_add(1);
    Ok(Json(json!({"session_id": session_id, "summary": events.summary()})))
}

pub(super) async fn record(state: &AppState, session: Option<String>, identity: Option<VerifiedApp>, reason: Option<&str>, operation: &str) {
    let (Some(session), Some(identity), Some(reason)) = (session, identity, reason) else { return; };
    let mut runtime = state.runtime.lock().await;
    expire_runtime(&mut runtime);
    if runtime.keys.is_some() && runtime.session_id.as_deref() == Some(session.as_str()) {
        runtime.authorization_events.record(&identity.id, &identity.name, reason, operation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::{Body, to_bytes}, routing::{get, post}, Router};
    use tower::ServiceExt;

    fn headers(key: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-app-id", HeaderValue::from_static("reader"));
        headers.insert("x-app-key", HeaderValue::from_str(key).unwrap());
        headers
    }
    #[test]
    fn groups_are_bounded_and_repeated_failures_do_not_recreate_read_or_ignored_badges() {
        let mut log = AuthorizationEvents::default();
        log.record("reader", "Reader", "expired", "search");
        log.events[0].unread = false;
        log.record("reader", "Reader", "expired", "search");
        assert_eq!(log.events.len(), 1);
        assert_eq!(log.events[0].count, 2);
        assert_eq!(log.summary()["unread"], 0);
        log.events[0].ignored = true;
        log.record("reader", "Reader", "expired", "search");
        assert!(log.events[0].ignored);
        log.record("reader", "Reader", "secrets_permission", "reveal");
        assert_eq!(log.summary()["unread"], 1);
        log.muted = true;
        assert_eq!(log.summary()["unread"], 0);
        for i in 0..200 { log.record(&i.to_string(), "App", "expired", "search"); }
        assert_eq!(log.events.len(), 100);
    }
    #[test]
    fn only_verified_keys_qualify_and_deleted_datasets_do_not_count_as_available() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('reader','Reader',?1,'search','[\"deleted\"]')", [app_key_hash("valid-test-key")]).unwrap();
        assert!(verified_app(&db, &headers("wrong"), None).unwrap().is_none());
        assert!(verified_app(&db, &HeaderMap::new(), None).unwrap().is_none());
        let identity = verified_app(&db, &headers("valid-test-key"), Some("other")).unwrap().unwrap();
        assert!(!identity.has_dataset && !identity.target_allowed);
        assert!(denial_reason("invalid app credentials").is_none());
        assert!(denial_reason("untrusted Origin").is_none());
        assert!(denial_reason("internal failure").is_none());
    }
    async fn request(app: &Router, path: &str, method: &str, key: Option<&str>, cookie: Option<&str>, body: Value) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(path).header("host", "127.0.0.1").header("content-type", "application/json");
        if let Some(key) = key { builder = builder.header("x-app-id", "reader").header("x-app-key", key); }
        if let Some(cookie) = cookie { builder = builder.header("cookie", cookie); }
        let response = app.clone().oneshot(builder.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[tokio::test]
    async fn middleware_records_real_denials_but_never_bad_keys_or_owner_traffic_and_enforces_session_isolation() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("authorization-events-{}", Uuid::new_v4()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(dir.clone());
        fs::create_dir_all(&dir).unwrap();
        let state = rotation::state_for(dir);
        let (keys, _) = initialize_vault(&state, "authorization-test-password").unwrap();
        activate(&state, keys, false).await;
        let response = owner_session(&state, false).await.unwrap();
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
        let session = state.runtime.lock().await.session_id.clone().unwrap();
        with_connection(&state, |db, _| {
            db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json,access_expires_at) VALUES('reader','Reader',?1,'search','[]',1)", [app_key_hash("valid-test-key")]).map_err(internal)?;
            Ok(())
        }).await.unwrap();
        let app = Router::new()
            .route("/records/search", get(search_records))
            .route("/client/datasets", get(client::datasets))
            .route("/records/{id}", get(record_detail))
            .route("/records/{id}/secrets/reveal", post(reveal_secret))
            .route("/vault/status", get(vault_status))
            .route("/apps", get(list_apps))
            .route("/apps/authorization-events", get(list).post(acknowledge))
            .layer(middleware::from_fn_with_state(state.clone(), protect_api)).with_state(state.clone());
        let (code, _) = request(&app, "/records/search", "GET", Some("wrong-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert!(state.runtime.lock().await.authorization_events.events.is_empty());
        let (code, _) = request(&app, "/records/search", "GET", Some("valid-test-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        with_connection(&state, |db, _| { db.execute("UPDATE api_apps SET disabled=1", []).map_err(internal)?; Ok(()) }).await.unwrap();
        let (code, _) = request(&app, "/records/search", "GET", Some("valid-test-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        assert_eq!(state.runtime.lock().await.authorization_events.events[0].reason, "disabled");
        with_connection(&state, |db, _| { db.execute("UPDATE api_apps SET disabled=0", []).map_err(internal)?; Ok(()) }).await.unwrap();
        let (code, _) = request(&app, "/apps/authorization-events", "GET", Some("valid-test-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        let (_, anonymous) = request(&app, "/vault/status", "GET", None, None, json!(null)).await;
        assert!(anonymous["authorization_notice"].is_null());
        let (_, mixed) = request(&app, "/vault/status", "GET", Some("valid-test-key"), Some(&cookie), json!(null)).await;
        assert!(mixed["authorization_notice"].is_null(), "app credentials never receive owner diagnostics even alongside a cookie");
        let (_, result) = request(&app, "/apps/authorization-events", "GET", None, Some(&cookie), json!(null)).await;
        assert_eq!(result["events"].as_array().unwrap().len(), 3);
        assert_eq!(result["events"][2]["reason"], "expired");
        let old_id = result["events"][2]["id"].as_u64().unwrap();
        let (_, ack) = request(&app, "/apps/authorization-events", "POST", None, Some(&cookie), json!({"session_id":session,"seen_ids":[old_id]})).await;
        assert_eq!(ack["summary"]["unread"], 2, "unrendered/new groups stay unread");
        let (code, _) = request(&app, "/apps/authorization-events", "POST", None, Some(&cookie), json!({"session_id":"old-session","muted":true})).await;
        assert_eq!(code, StatusCode::CONFLICT);
        with_connection(&state, |db, _| { db.execute("UPDATE api_apps SET access_expires_at=NULL", []).map_err(internal)?; Ok(()) }).await.unwrap();
        let (code, _) = request(&app, "/client/datasets", "GET", Some("valid-test-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(state.runtime.lock().await.authorization_events.events[0].reason, "no_datasets");
        let dataset = serde_json::from_value(json!({"category_path":"Synthetic","fields":[{"source_key":"code","zone":"indexes"},{"source_key":"token","zone":"secrets"}],"sample_data":[{"code":"synthetic","token":"DO_NOT_LOG"}]})).unwrap();
        let Json(created) = create_dataset(State(state.clone()), Json(dataset)).await.unwrap();
        let id = created["dataset_id"].as_str().unwrap();
        with_connection(&state, |db, _| { db.execute("UPDATE api_apps SET datasets_json=?1", [json!([id]).to_string()]).map_err(internal)?; Ok(()) }).await.unwrap();
        let (_, result) = request(&app, "/records/search", "GET", Some("valid-test-key"), None, json!(null)).await;
        let record = result["records"][0]["id"].as_str().unwrap();
        let (code, _) = request(&app, &format!("/records/{record}/secrets/reveal"), "POST", Some("valid-test-key"), None, json!({"field_name":"token"})).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        let (code, _) = request(&app, "/records/search?dataset_id=outside", "GET", Some("valid-test-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::OK, "existing scoped-search empty-result behavior stays compatible");
        let (_, result) = request(&app, "/apps/authorization-events", "GET", None, Some(&cookie), json!(null)).await;
        assert_eq!(result["events"][0]["reason"], "dataset_scope");
        assert_eq!(result["events"][1]["reason"], "secrets_permission");
        let text = result.to_string();
        for secret in ["DO_NOT_LOG", "valid-test-key", "outside", "field_name"] { assert!(!text.contains(secret)); }
        let before = state.runtime.lock().await.last_activity;
        let (_, muted) = request(&app, "/apps/authorization-events", "POST", None, Some(&cookie), json!({"session_id":session,"muted":true})).await;
        assert_eq!(muted["summary"]["unread"], 0);
        assert_eq!(before, state.runtime.lock().await.last_activity, "event reads/settings are not user activity heartbeats");
        let identity = with_connection(&state, |db, _| verified_app(db, &headers("valid-test-key"), None)).await.unwrap();
        let _ = owner_session(&state, false).await.unwrap();
        record_event_after_rotation(&state, session, identity).await;
        let mut stale_headers = HeaderMap::new();
        stale_headers.insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        assert_eq!(list(State(state.clone()), stale_headers).await.unwrap_err().0, StatusCode::UNAUTHORIZED);
        assert!(state.runtime.lock().await.authorization_events.events.is_empty());
        assert_eq!(state.runtime.lock().await.authorization_events.summary()["muted"], false);
        let _ = vault_seal(State(state.clone())).await;
        let (code, _) = request(&app, "/records/search", "GET", Some("valid-test-key"), None, json!(null)).await;
        assert_eq!(code, StatusCode::LOCKED);
        assert!(state.runtime.lock().await.authorization_events.events.is_empty());
    }
    async fn record_event_after_rotation(state: &AppState, session: String, identity: Option<VerifiedApp>) {
        record(state, Some(session), identity, Some("expired"), "search").await;
    }
}
