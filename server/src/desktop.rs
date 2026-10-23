//! Private launcher protocol: readiness on stdout, parent lifetime on stdin.
use std::future::IntoFuture;
use std::io::{Read, Write};

// Let the owning process bind the actual socket; a launcher-side availability
// probe would leave a race between checking a port and starting the service.
pub(super) async fn bind(
    address: std::net::SocketAddr,
    auto_port: bool,
) -> std::io::Result<tokio::net::TcpListener> {
    match tokio::net::TcpListener::bind(address).await {
        Err(error) if auto_port && error.kind() == std::io::ErrorKind::AddrInUse => {
            tokio::net::TcpListener::bind(std::net::SocketAddr::new(address.ip(), 0)).await
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn fallback_only_on_conflict_and_when_enabled() {
        let occupied = super::bind("127.0.0.1:0".parse().unwrap(), false)
            .await
            .unwrap();
        let address = occupied.local_addr().unwrap();
        assert_eq!(
            super::bind(address, false).await.unwrap_err().kind(),
            std::io::ErrorKind::AddrInUse
        );
        let fallback = super::bind(address, true).await.unwrap();
        assert_ne!(fallback.local_addr().unwrap().port(), address.port());
        assert_eq!(fallback.local_addr().unwrap().ip(), address.ip());
        drop(occupied);
        let preferred = super::bind(address, true).await.unwrap();
        assert_eq!(preferred.local_addr().unwrap(), address);
    }
}

pub(super) async fn ipc_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(request).await;
    let header = axum::http::header::CONTENT_SECURITY_POLICY;
    if let Some(csp) = response
        .headers()
        .get(&header)
        .and_then(|value| value.to_str().ok())
    {
        let csp = csp.replace(
            "connect-src 'self'",
            "connect-src 'self' ipc: http://ipc.localhost",
        );
        if let Ok(value) = csp.parse() {
            response.headers_mut().insert(header, value);
        }
    }
    response
}

pub(super) async fn serve(
    listener: tokio::net::TcpListener,
    app: axum::Router,
) -> std::io::Result<()> {
    let address = listener.local_addr()?;
    let (closed, mut shutdown) = tokio::sync::watch::channel(false);
    std::thread::spawn(move || {
        let mut buffer = [0; 256];
        while let Ok(count) = std::io::stdin().read(&mut buffer) {
            if count == 0 {
                break;
            }
        }
        let _ = closed.send(true);
    });
    println!(
        "{}",
        serde_json::json!({"event": "ready", "protocol": 1, "url": format!("http://{address}")})
    );
    std::io::stdout().flush()?;
    let mut deadline = shutdown.clone();
    let serving = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = shutdown.wait_for(|closed| *closed).await;
    });
    tokio::select! {
        result = serving.into_future() => result,
        _ = async move {
            let _ = deadline.wait_for(|closed| *closed).await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        } => Ok(()),
    }
}
