use super::*;

pub(super) fn expire_runtime(runtime: &mut Runtime) {
    if !runtime.persistent
        && (runtime
            .unlocked_at
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(14400))
            || runtime
                .last_activity
                .is_some_and(|t| t.elapsed() >= Duration::from_secs(1800)))
    {
        runtime.keys = None;
        runtime.session_hash = None;
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

pub(super) async fn owner_session(state: &AppState) -> ApiResult<Response> {
    let token = Zeroizing::new(format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ));
    state.runtime.lock().await.session_hash = Some(app_key_hash(&token));
    let mut response = Json(json!({"sealed": false})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "vault_session={}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=14400{}",
            token.as_str(),
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

fn app_route(method: &axum::http::Method, path: &str) -> bool {
    if method == axum::http::Method::GET {
        return path == "/records/search"
            || (path.starts_with("/records/") && path.split('/').count() == 3)
            || (path.starts_with("/datasets/") && path.ends_with("/export"));
    }
    method == axum::http::Method::POST
        && path.starts_with("/records/")
        && path.ends_with("/secrets/reveal")
}

pub(super) async fn protect_api(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    // Never trust a client-supplied marker, even with valid app credentials.
    request.headers_mut().remove("x-vault-owner");
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
        if !app_route(request.method(), path) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "management requires an owner session".into(),
            ));
        }
        let keys = runtime.keys.as_ref().ok_or_else(locked)?;
        let connection = open_database(&database_path(&state), &keys.db)?;
        authorize_app(&connection, request.headers(), "search")?;
        Ok(())
    }
    .await;
    let mut response = match response {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
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

pub(super) fn valid_verifier(key: &[u8; 32], expected: &str) -> bool {
    let Ok(expected) = hex::decode(expected) else {
        return false;
    };
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).unwrap();
    mac.update(b"securevault/password-verifier/v1");
    mac.verify_slice(&expected).is_ok()
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
                "indexes" | "display" | "secrets" | "hidden"
            )
        {
            return Err(bad_request("invalid or duplicate field definition"));
        }
    }
    if identity.iter().any(|key| !seen.contains(key)) {
        return Err(bad_request("identity field is not defined in schema"));
    }
    for field in list {
        if !matches!(field.format.as_str(), "single_line" | "multiline" | "json")
            || !seen.contains(&field.source_key)
        {
            return Err(bad_request("invalid list field or format"));
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
    fn legacy_kdf_remains_compatible_and_verifier_rejects_tampering() {
        let meta: VaultMeta = serde_json::from_str(r#"{"salt":"00","verifier":"00"}"#).unwrap();
        assert_eq!(meta.kdf_version, 1);
        let salt = [7u8; 16];
        let keys = derive_keys("legacy-password-123", &salt, meta.kdf_version).unwrap();
        let mut root = [0u8; 32];
        Argon2::default()
            .hash_password_into(b"legacy-password-123", &salt, &mut root)
            .unwrap();
        let mut expected = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), &root)
            .expand(b"securevault/sqlcipher/v1", &mut expected)
            .unwrap();
        assert_eq!(*keys.db, expected);
        assert!(valid_verifier(&keys.db, &verifier(&keys.db)));
        assert!(!valid_verifier(&keys.db, &"00".repeat(32)));
    }
    #[test]
    fn expired_sessions_drop_keys_without_request_activity() {
        let mut runtime = Runtime {
            keys: Some(derive_keys("test-password-123", &[0; 16], 1).unwrap()),
            unlocked_at: Some(Instant::now()),
            last_activity: Some(Instant::now() - Duration::from_secs(1801)),
            persistent: false,
            session_hash: Some("token".into()),
            unlock_failures: 0,
            unlock_after: None,
        };
        expire_runtime(&mut runtime);
        assert!(runtime.keys.is_none() && runtime.session_hash.is_none());
    }
    #[test]
    fn app_routes_exclude_management_and_csv_formulas_are_neutralized() {
        use axum::http::Method;
        assert!(app_route(&Method::GET, "/records/search"));
        assert!(app_route(&Method::POST, "/records/rec_1/secrets/reveal"));
        for (method, path) in [
            (Method::GET, "/apps"),
            (Method::POST, "/datasets"),
            (Method::POST, "/vault/seal"),
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
