use super::*;

pub(super) const SESSION_MAX_SECONDS: u64 = 6 * 60 * 60;
pub(super) const SESSION_IDLE_SECONDS: u64 = 30 * 60;
pub(super) const SESSION_WARNING_SECONDS: u64 = 10 * 60;

// Monotonic time prevents clock rollback from extending a session; wall time also
// accounts for system sleep on platforms whose monotonic clock pauses while asleep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SessionInstant {
    tick: Instant,
    wall: std::time::SystemTime,
}

impl SessionInstant {
    pub(super) fn now() -> Self {
        Self { tick: Instant::now(), wall: std::time::SystemTime::now() }
    }

    fn elapsed(self) -> Duration {
        self.tick.elapsed().max(self.wall.elapsed().unwrap_or_default())
    }
}

impl std::ops::Sub<Duration> for SessionInstant {
    type Output = Self;
    fn sub(self, age: Duration) -> Self {
        Self { tick: self.tick - age, wall: self.wall - age }
    }
}

pub(super) fn expire_runtime(runtime: &mut Runtime) {
    if !runtime.persistent
        && (runtime
            .unlocked_at
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(SESSION_MAX_SECONDS))
            || runtime
                .last_activity
                .is_some_and(|t| t.elapsed() >= Duration::from_secs(SESSION_IDLE_SECONDS)))
    {
        runtime.authorization_events = Default::default();
        runtime.keys = None;
        runtime.session_hash = None;
        runtime.session_id = None;
        runtime.unlocked_at = None;
        runtime.last_activity = None;
    }
}

pub(super) fn owner_cookie(headers: &HeaderMap, runtime: &Runtime) -> bool {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|part| part.trim().strip_prefix("vault_session="))
        })
        .is_some_and(|token| {
            runtime
                .session_hash
                .as_ref()
                .is_some_and(|hash| *hash == app_key_hash(token))
        })
        && runtime.keys.is_some()
}

// Only the authenticated browser owner receives session timing and identity.
pub(super) fn owner_status(runtime: &Runtime, owner: bool) -> Value {
    json!({
        "sealed": !owner,
        "authorization_notice": if owner { runtime.authorization_events.summary() } else { Value::Null },
        "can_manage": owner,
        "persistent": runtime.persistent,
        "session_id": if owner { runtime.session_id.as_deref() } else { None },
        "idle_timeout_seconds": SESSION_IDLE_SECONDS,
        "max_session_seconds": SESSION_MAX_SECONDS,
        "warning_seconds": SESSION_WARNING_SECONDS,
        "idle_seconds_remaining": if owner { runtime.last_activity.map(|t| SESSION_IDLE_SECONDS.saturating_sub(t.elapsed().as_secs())) } else { None },
        "ttl_seconds_remaining": if owner { runtime.unlocked_at.map(|t| SESSION_MAX_SECONDS.saturating_sub(t.elapsed().as_secs())) } else { None }
    })
}

#[derive(Deserialize)]
pub(super) struct ActivityRequest {
    session_id: String,
    idle_ms: u64,
}

pub(super) async fn vault_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ActivityRequest>,
) -> ApiResult<Json<Value>> {
    let mut runtime = state.runtime.lock().await;
    expire_runtime(&mut runtime);
    if runtime.keys.is_none() { return Err(locked()); }
    // Recheck under the lock: neither expired cookies nor app credentials can renew a session.
    if headers.contains_key("x-app-id") || headers.contains_key("x-app-key") || !owner_cookie(&headers, &runtime) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "owner session required".into()));
    }
    if runtime.session_id.as_deref() != Some(request.session_id.as_str()) {
        return Err(ApiError(StatusCode::CONFLICT, "owner session changed".into()));
    }
    if request.idle_ms >= SESSION_IDLE_SECONDS * 1000 {
        return Err(bad_request("activity is too old"));
    }
    // Report the age of the actual interaction; a delayed/throttled flush is not new activity.
    let activity = SessionInstant::now() - Duration::from_millis(request.idle_ms);
    if runtime.last_activity.is_none_or(|previous| activity.tick > previous.tick) {
        runtime.last_activity = Some(activity);
    }
    Ok(Json(owner_status(&runtime, true)))
}

pub(super) async fn owner_session(state: &AppState, warning: bool) -> ApiResult<Response> {
    let token = Zeroizing::new(format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ));
    let mut runtime = state.runtime.lock().await;
    runtime.authorization_events = Default::default();
    runtime.session_hash = Some(app_key_hash(&token));
    runtime.session_id = Some(Uuid::new_v4().to_string());
    let mut status = owner_status(&runtime, true);
    status["durability_warning"] = json!(warning);
    let mut response = Json(status).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "vault_session={}; HttpOnly; SameSite=Strict; Path=/api; Max-Age={}{}",
            token.as_str(),
            SESSION_MAX_SECONDS,
            if state.public_origin.is_some() {
                "; Secure"
            } else {
                ""
            }
        ))
        .map_err(internal)?,
    );
    Ok(response)
}

pub(super) fn app_route(method: &axum::http::Method, path: &str) -> bool {
    if method == axum::http::Method::GET {
        return path == "/records/search"
            || path == "/client/datasets"
            || (path.starts_with("/records/") && path.split('/').count() == 3)
            || (path.starts_with("/datasets/") && path.ends_with("/export"));
    }
    method == axum::http::Method::POST
        && (path.starts_with("/records/") || path.starts_with("/supplement/"))
        && path.ends_with("/secrets/reveal")
}

pub(super) async fn protect_api(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    // Never trust a client-supplied marker, even with valid app credentials.
    request.headers_mut().remove("x-vault-owner");
    let mut verified_identity = None;
    let mut event_session = None;
    let target = Query::<authorization_events::Target>::try_from_uri(request.uri()).ok().and_then(|query| query.0.dataset_id);
    let operation = authorization_events::operation(request.method(), request.uri().path());
    let response = async {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let authority = host
            .parse::<axum::http::uri::Authority>()
            .map_err(|_| bad_request("invalid Host"))?;
        let local_host = matches!(
            authority.host(),
            "127.0.0.1" | "localhost" | "[::1]" | "::1"
        );
        let public_host = state
            .public_origin
            .as_ref()
            .and_then(|v| v.strip_prefix("https://"));
        if !local_host && public_host != Some(host) {
            return Err(ApiError(StatusCode::FORBIDDEN, "untrusted Host".into()));
        }
        let expected_origin = if public_host == Some(host) {
            state.public_origin.clone().unwrap()
        } else {
            format!("http://{host}")
        };
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            if origin.to_str().ok() != Some(expected_origin.as_str()) {
                return Err(ApiError(StatusCode::FORBIDDEN, "untrusted Origin".into()));
            }
        }
        if request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|v| v != "same-origin" && v != "none")
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "cross-site requests are forbidden".into(),
            ));
        }
        let path = request.uri().path();
        if matches!(path, "/vault/status" | "/vault/setup" | "/vault/unlock") {
            return Ok(());
        }
        let mut runtime = state.runtime.lock().await;
        expire_runtime(&mut runtime);
        if runtime.keys.is_none() {
            return Err(locked());
        }
        let app_credentials = request.headers().contains_key("x-app-id")
            || request.headers().contains_key("x-app-key");
        if !app_credentials && owner_cookie(request.headers(), &runtime) {
            request
                .headers_mut()
                .insert("x-vault-owner", HeaderValue::from_static("1"));
            return Ok(());
        }
        if !app_credentials {
            return Err(ApiError(
                StatusCode::UNAUTHORIZED,
                "owner session or app credentials required".into(),
            ));
        }
        let keys = runtime.keys.as_ref().ok_or_else(locked)?;
        let connection = open_database(&database_path(&state), &keys.db)?;
        verified_identity = authorization_events::verified_app(&connection, request.headers(), target.as_deref())?;
        event_session = runtime.session_id.clone();
        if !app_route(request.method(), path) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "management requires an owner session".into(),
            ));
        }
        authorize_app(&connection, request.headers(), "search")?;
        Ok(())
    }
    .await;
    let mut response = match response {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    let denial = response.extensions_mut().remove::<authorization_events::AuthorizationDenial>();
    let empty_scope = response.status().is_success() && verified_identity.as_ref().is_some_and(|identity| !identity.has_dataset);
    let target_denied = response.status().is_success() && operation == "search" && verified_identity.as_ref().is_some_and(|identity| !identity.target_allowed);
    let reason = denial.map(|denial| denial.0).or(if target_denied { Some("dataset_scope") } else if empty_scope { Some("no_datasets") } else { None });
    authorization_events::record(&state, event_session, verified_identity, reason, operation).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

pub(super) fn check_password_limit(runtime: &Runtime) -> ApiResult<()> {
    if runtime
        .unlock_after
        .is_some_and(|after| Instant::now() < after)
    {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "password verification rate limited; retry later".into(),
        ));
    }
    Ok(())
}
pub(super) fn password_failure(runtime: &mut Runtime) {
    runtime.unlock_failures = runtime.unlock_failures.saturating_add(1);
    runtime.unlock_after =
        Some(Instant::now() + Duration::from_secs(1u64 << runtime.unlock_failures.min(6)));
}

pub(super) fn csv_safe(value: &str) -> String {
    if value.trim_start().starts_with(['=', '+', '-', '@']) || value.starts_with(['\t', '\r', '\n'])
    {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

pub(super) fn validate_schema(
    fields: &[FieldDefinition],
    identity: &[String],
    list: &[ListFieldDefinition],
) -> ApiResult<()> {
    let mut seen = std::collections::HashSet::new();
    for field in fields {
        if field.source_key.is_empty()
            || !seen.insert(&field.source_key)
            || !matches!(
                field.zone.as_str(),
                "indexes" | "display" | "normal" | "ignore" | "secrets" | "hidden"
            )
        {
            return Err(bad_request("字段定义无效或重复"));
        }
        if field.zone == "ignore" && (field.unique || identity.contains(&field.source_key)) {
            return Err(bad_request("忽略字段不能作为逻辑唯一 KEY"));
        }
    }
    if identity.iter().any(|key| !seen.contains(key)) {
        return Err(bad_request("唯一标识字段未在数据集结构中定义"));
    }
    for field in list {
        if !matches!(field.format.as_str(), "single_line" | "multiline" | "json")
            || !seen.contains(&field.source_key)
            || (field.visible && !fields.iter().any(|definition| definition.source_key == field.source_key && matches!(definition.zone.as_str(), "indexes" | "display")))
        {
            return Err(bad_request("列表展示字段或格式无效"));
        }
    }
    Ok(())
}

pub(super) async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_sessions_drop_keys_without_request_activity() {
        let mut runtime = Runtime {
            keys: Some(random_keys()),
            unlocked_at: Some(SessionInstant::now()),
            last_activity: Some(SessionInstant::now() - Duration::from_secs(1801)),
            persistent: false,
            session_hash: Some("token".into()),
            session_id: Some("session".into()),
            authorization_events: Default::default(),
            unlock_failures: 0,
            unlock_after: None,
        };
        expire_runtime(&mut runtime);
        assert!(runtime.keys.is_none() && runtime.session_hash.is_none());
    }
    fn active_runtime() -> Runtime {
        Runtime {
            keys: Some(random_keys()),
            unlocked_at: Some(SessionInstant::now()),
            last_activity: Some(SessionInstant::now()),
            persistent: false,
            session_hash: Some(app_key_hash("test-cookie")),
            session_id: Some("test-session".into()),
            authorization_events: Default::default(),
            unlock_failures: 0,
            unlock_after: None,
        }
    }

    fn owner_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("vault_session=test-cookie"));
        headers
    }

    fn activity(idle_ms: u64) -> Json<ActivityRequest> {
        Json(ActivityRequest { session_id: "test-session".into(), idle_ms })
    }

    #[test]
    fn sessions_expire_at_idle_and_absolute_limits_but_active_sessions_survive_four_hours() {
        for (age, idle, expired) in [(21600, 0, true), (0, 1800, true), (21599, 1799, false), (18000, 0, false)] {
            let mut runtime = active_runtime();
            runtime.unlocked_at = Some(SessionInstant::now() - Duration::from_secs(age));
            runtime.last_activity = Some(SessionInstant::now() - Duration::from_secs(idle));
            expire_runtime(&mut runtime);
            assert_eq!(runtime.keys.is_none(), expired, "age={age}, idle={idle}");
            if expired {
                assert!(runtime.session_hash.is_none() && runtime.session_id.is_none());
                assert!(runtime.unlocked_at.is_none() && runtime.last_activity.is_none());
            }
        }
        let mut persistent = active_runtime();
        persistent.persistent = true;
        persistent.unlocked_at = Some(SessionInstant::now() - Duration::from_secs(21601));
        persistent.last_activity = persistent.unlocked_at;
        expire_runtime(&mut persistent);
        assert!(persistent.keys.is_some());
    }

    #[test]
    fn system_sleep_counts_toward_both_limits_and_clock_rollback_cannot_extend_them() {
        for hard_limit in [false, true] {
            let mut runtime = active_runtime();
            let age = Duration::from_secs(if hard_limit { SESSION_MAX_SECONDS } else { SESSION_IDLE_SECONDS });
            let timestamp = if hard_limit { runtime.unlocked_at.as_mut().unwrap() } else { runtime.last_activity.as_mut().unwrap() };
            timestamp.wall = timestamp.wall - age;
            expire_runtime(&mut runtime);
            assert!(runtime.keys.is_none(), "wall time must expire a session even when the monotonic clock paused");
        }
        let mut runtime = active_runtime();
        runtime.last_activity = Some(SessionInstant::now() - Duration::from_secs(SESSION_IDLE_SECONDS));
        runtime.last_activity.as_mut().unwrap().wall = std::time::SystemTime::now() + Duration::from_secs(3600);
        expire_runtime(&mut runtime);
        assert!(runtime.keys.is_none(), "clock rollback must not extend the monotonic deadline");
    }

    #[tokio::test]
    async fn activity_requires_current_owner_and_preserves_absolute_expiry_and_actual_event_age() {
        let state = rotation::state_for(PathBuf::new());
        *state.runtime.lock().await = active_runtime();
        let unlocked_at = state.runtime.lock().await.unlocked_at;
        state.runtime.lock().await.last_activity = Some(SessionInstant::now() - Duration::from_secs(1500));
        let original = state.runtime.lock().await.last_activity;
        for headers in [HeaderMap::new(), {
            let mut headers = owner_headers();
            headers.insert("x-app-id", HeaderValue::from_static("app"));
            headers
        }] {
            assert!(matches!(vault_activity(State(state.clone()), headers, activity(0)).await, Err(ApiError(StatusCode::UNAUTHORIZED, _))));
            assert_eq!(state.runtime.lock().await.last_activity, original);
        }
        assert!(matches!(vault_activity(State(state.clone()), owner_headers(), Json(ActivityRequest { session_id: "old-session".into(), idle_ms: 0 })).await, Err(ApiError(StatusCode::CONFLICT, _))));
        assert!(matches!(vault_activity(State(state.clone()), owner_headers(), activity(1800000)).await, Err(ApiError(StatusCode::BAD_REQUEST, _))));
        let Json(status) = vault_activity(State(state.clone()), owner_headers(), activity(12000)).await.unwrap();
        assert!((1787..=1788).contains(&status["idle_seconds_remaining"].as_u64().unwrap()));
        let renewed = state.runtime.lock().await.last_activity;
        let _ = vault_activity(State(state.clone()), owner_headers(), activity(60000)).await.unwrap();
        let runtime = state.runtime.lock().await;
        assert_eq!(runtime.unlocked_at, unlocked_at);
        assert_eq!(runtime.last_activity, renewed, "late reports from another tab cannot shorten the idle deadline");
    }

    #[tokio::test]
    async fn expired_activity_cannot_resurrect_a_session_and_status_expires_without_renewing() {
        for hard_limit in [false, true] {
            let state = rotation::state_for(PathBuf::new());
            let mut runtime = active_runtime();
            if hard_limit { runtime.unlocked_at = Some(SessionInstant::now() - Duration::from_secs(21600)); }
            else { runtime.last_activity = Some(SessionInstant::now() - Duration::from_secs(1800)); }
            *state.runtime.lock().await = runtime;
            assert!(matches!(vault_activity(State(state.clone()), owner_headers(), activity(0)).await, Err(ApiError(StatusCode::LOCKED, _))));
            assert!(state.runtime.lock().await.keys.is_none());
        }
        let state = rotation::state_for(PathBuf::new());
        *state.runtime.lock().await = active_runtime();
        let original = state.runtime.lock().await.last_activity;
        let Json(status) = vault_status(State(state.clone()), owner_headers()).await;
        assert_eq!(status["sealed"], false);
        assert_eq!(state.runtime.lock().await.last_activity, original);
        let Json(anonymous) = vault_status(State(state.clone()), HeaderMap::new()).await;
        assert!(anonymous["session_id"].is_null() && anonymous["ttl_seconds_remaining"].is_null());
        state.runtime.lock().await.last_activity = Some(SessionInstant::now() - Duration::from_secs(1800));
        let Json(status) = vault_status(State(state.clone()), owner_headers()).await;
        assert_eq!(status["sealed"], true);
        assert!(state.runtime.lock().await.keys.is_none());
    }

    #[tokio::test]
    async fn session_cookie_matches_the_six_hour_hard_limit_and_rotates_identity() {
        let state = rotation::state_for(PathBuf::new());
        *state.runtime.lock().await = active_runtime();
        let response = owner_session(&state, false).await.unwrap();
        assert!(response.headers()[header::SET_COOKIE].to_str().unwrap().contains("Max-Age=21600"));
        let old_id = state.runtime.lock().await.session_id.clone();
        let _ = owner_session(&state, false).await.unwrap();
        assert_ne!(state.runtime.lock().await.session_id, old_id);
    }

    #[test]
    fn app_routes_exclude_management_and_csv_formulas_are_neutralized() {
        use axum::http::Method;
        assert!(app_route(&Method::GET, "/records/search"));
        assert!(app_route(&Method::GET, "/client/datasets"));
        assert!(app_route(&Method::POST, "/supplement/sup_1/secrets/reveal"));
        assert!(app_route(&Method::POST, "/records/rec_1/secrets/reveal"));
        for (method, path) in [
            (Method::POST, "/imports/text"),
            (Method::POST, "/imports/batch/samples"),
            (Method::POST, "/records/import/report"),
            (Method::POST, "/datasets/transfer/report"),
            (Method::GET, "/apps"),
            (Method::GET, "/saved-queries"),
            (Method::POST, "/saved-queries"),
            (Method::PATCH, "/saved-queries/query_1"),
            (Method::DELETE, "/saved-queries/query_1"),
            (Method::GET, "/datasets"),
            (Method::GET, "/datasets/tree"),
            (Method::POST, "/client/datasets"),
            (Method::GET, "/datasets/ds_1/supplement"),
            (Method::PATCH, "/records/rec_1"),
            (Method::POST, "/datasets/ds_1/records"),
            (Method::POST, "/datasets/ds_1/supplement/cleanup"),
            (Method::POST, "/datasets"),
            (Method::POST, "/vault/seal"),
            (Method::POST, "/vault/activity"),
            (Method::PATCH, "/datasets/ds_1"),
        ] {
            assert!(!app_route(&method, path));
        }
        for value in ["=SUM(1,2)", " +1", "@cmd", "\tformula", "-123"] {
            assert!(csv_safe(value).starts_with('\''));
        }
        assert_eq!(csv_safe("00123"), "00123");
    }
}
