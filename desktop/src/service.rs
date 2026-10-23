use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

pub struct Service {
    child: Child,
    pub url: tauri::Url,
    pub data_dir: PathBuf,
    errors: Arc<Mutex<String>>,
}

pub struct SwitchResult {
    pub reload: bool,
    pub error: Option<String>,
}

fn ready_url(line: &str, port: u16) -> Result<tauri::Url, String> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "本地服务启动协议无效")?;
    if value["event"] != "ready" || value["protocol"] != 1 {
        return Err("本地服务启动协议不匹配".into());
    }
    let url = tauri::Url::parse(value["url"].as_str().ok_or("本地服务地址缺失")?)
        .map_err(|_| "本地服务地址无效")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || (port != 0 && url.port_or_known_default() != Some(port))
    {
        return Err("本地服务返回了非预期地址".into());
    }
    Ok(url)
}

fn binary_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) {
        "securevault.exe"
    } else {
        "securevault"
    };
    let adjacent = executable.parent().ok_or("无法定位桌面程序")?.join(name);
    if adjacent.is_file() {
        return Ok(adjacent);
    }
    #[cfg(debug_assertions)]
    {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let development = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "binaries/securevault-{}{suffix}",
            env!("DESKTOP_TARGET")
        ));
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("缺少随应用分发的 securevault 服务，请重新构建或安装完整应用。".into())
}

impl Service {
    pub fn launch(data_dir: PathBuf, port: Option<u16>) -> Result<Self, String> {
        Self::start_with_policy(data_dir, port.unwrap_or(4173), port.is_none())
    }

    pub fn switch_to(&mut self, directory: PathBuf, settings: &std::path::Path) -> SwitchResult {
        if self.data_dir.canonicalize().ok().as_ref() == Some(&directory) {
            return SwitchResult {
                reload: false,
                error: crate::directories::save(settings, &directory).err(),
            };
        }
        // Probe while the current service is still running. In particular, an occupied
        // target must not close the current vault or lose its unlocked session/drafts.
        let mut probe = match Self::start(directory.clone(), 0) {
            Ok(service) => service,
            Err(error) => {
                return SwitchResult {
                    reload: false,
                    error: Some(error),
                };
            }
        };
        probe.stop();
        let previous = self.data_dir.clone();
        let port = self.url.port_or_known_default().unwrap();
        self.stop();
        let replacement = Self::start(directory.clone(), port).and_then(|mut service| {
            if let Err(error) = crate::directories::save(settings, &directory) {
                service.stop();
                return Err(format!("无法保存数据目录设置：{error}"));
            }
            Ok(service)
        });
        match replacement {
            Ok(service) => {
                *self = service;
                SwitchResult {
                    reload: true,
                    error: None,
                }
            }
            Err(error) => {
                let error = match Self::start(previous, port) {
                    Ok(service) => {
                        *self = service;
                        format!("切换失败，已恢复原目录，请重新解锁。\n{error}")
                    }
                    Err(restore) => format!(
                        "切换失败，原目录服务也无法重启。数据仍保留在原位置，请重新打开应用。\n{error}\n{restore}"
                    ),
                };
                SwitchResult {
                    reload: true,
                    error: Some(error),
                }
            }
        }
    }

    pub fn start(data_dir: PathBuf, port: u16) -> Result<Self, String> {
        Self::start_with_policy(data_dir, port, false)
    }

    fn start_with_policy(data_dir: PathBuf, port: u16, auto_port: bool) -> Result<Self, String> {
        let mut command = Command::new(binary_path()?);
        command
            .args([
                "--desktop-stdio",
                "--addr",
                &format!("127.0.0.1:{port}"),
                "--data-dir",
            ])
            .arg(&data_dir)
            .env_remove("SECUREVAULT_PASSWORD")
            .env_remove("SECUREVAULT_PUBLIC_ORIGIN")
            .env_remove("SECUREVAULT_ADDR")
            .env_remove("SECUREVAULT_DATA_DIR")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if auto_port {
            command.arg("--desktop-auto-port");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动本地服务：{e}"))?;
        let stdout = child.stdout.take().ok_or("无法读取本地服务启动状态")?;
        let stderr = child.stderr.take().ok_or("无法读取本地服务错误")?;
        let errors = Arc::new(Mutex::new(String::new()));
        let output = errors.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut text) = output.lock()
                    && text.len() < 8192
                {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
        });
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            let first = lines
                .next()
                .and_then(Result::ok)
                .ok_or_else(|| "本地服务在就绪前退出".to_owned());
            let _ = send.send(first);
            // Drain output for the entire lifetime so a full pipe cannot stall the server.
            for _ in lines {}
        });
        let mut service = Self {
            child,
            url: "http://127.0.0.1/".parse().unwrap(),
            data_dir,
            errors,
        };
        let ready = receive
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "等待本地服务启动超时".to_owned())
            .and_then(|line| line)
            .and_then(|line| ready_url(&line, if auto_port { 0 } else { port }));
        match ready {
            Ok(url) => {
                service.url = url;
                Ok(service)
            }
            Err(error) => {
                service.stop();
                Err(format!(
                    "{error}\n{}\n请检查端口是否被占用、数据目录是否已由另一个服务打开。",
                    service.error_text()
                ))
            }
        }
    }

    pub fn error_text(&self) -> String {
        self.errors.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self) {
        // EOF also works when the parent crashes: the OS closes its pipe handles.
        self.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(6);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(30));
        }
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(
        service: &Service,
        path: &str,
        body: Option<&str>,
        cookie: &str,
    ) -> (String, String) {
        use std::io::{Read, Write};
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", service.url.port().unwrap())).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let method = if body.is_some() { "POST" } else { "GET" };
        let body = body.unwrap_or("");
        write!(stream, "{method} /api{path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Type: application/json\r\nCookie: {cookie}\r\nContent-Length: {}\r\n\r\n{body}", service.url.authority(), body.len()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(
            response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.1 201"),
            "{response}"
        );
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        let cookie = headers
            .lines()
            .find_map(|line| line.strip_prefix("set-cookie: "))
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        (body.to_owned(), cookie)
    }

    #[test]
    fn switching_handles_locked_targets_rolls_back_failed_preferences_and_preserves_vaults() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/.build");
        std::fs::create_dir_all(&base).unwrap();
        let temp = tempfile::tempdir_in(base).unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        let settings = temp.path().join("settings.json");
        let mut service = Service::start(a.clone(), 0).unwrap();
        let password = r#"{"password":"DESKTOP_SWITCH_TEST_ONLY_PASSWORD"}"#;
        let (_, cookie) = request(&service, "/vault/setup", Some(password), "");
        let metadata = std::fs::read(a.join("vault/vault.meta.json")).unwrap();
        request(
            &service,
            "/saved-queries",
            Some(r#"{"name":"preserved query","filters":{"q":"preserved value"}}"#),
            &cookie,
        );
        let mut other = Service::start(b.clone(), 0).unwrap();
        let target = b.canonicalize().unwrap();
        let failed = service.switch_to(target.clone(), &settings);
        assert!(!failed.reload && failed.error.is_some());
        assert!(
            request(&service, "/saved-queries", None, &cookie)
                .0
                .contains("preserved query")
        );
        assert!(!settings.exists());
        other.stop();
        let bad_settings = temp.path().join("a-directory");
        std::fs::create_dir(&bad_settings).unwrap();
        let rollback = service.switch_to(target.clone(), &bad_settings);
        assert!(rollback.reload && rollback.error.is_some());
        assert_eq!(service.data_dir, a);
        let (_, cookie) = request(&service, "/vault/unlock", Some(password), "");
        assert!(
            request(&service, "/saved-queries", None, &cookie)
                .0
                .contains("preserved query")
        );
        let switched = service.switch_to(target.clone(), &settings);
        assert!(switched.reload && switched.error.is_none());
        assert_eq!(crate::directories::load(&settings).unwrap(), Some(target));
        assert!(
            request(&service, "/vault/status", None, "")
                .0
                .contains("\"initialized\":false")
        );
        request(&service, "/vault/setup", Some(password), "");
        let returned = service.switch_to(a.canonicalize().unwrap(), &settings);
        assert!(returned.reload && returned.error.is_none());
        let (_, cookie) = request(&service, "/vault/unlock", Some(password), "");
        assert!(
            request(&service, "/saved-queries", None, &cookie)
                .0
                .contains("preserved query")
        );
        assert_eq!(
            std::fs::read(a.join("vault/vault.meta.json")).unwrap(),
            metadata
        );
        assert!(b.join("vault/securevault.db").is_file());
    }

    #[test]
    fn readiness_accepts_only_the_expected_loopback_service() {
        let message =
            |url| serde_json::json!({"event":"ready", "protocol":1, "url":url}).to_string();
        assert!(ready_url(&message("http://127.0.0.1:4173"), 4173).is_ok());
        assert!(ready_url(&message("http://127.0.0.1:49152"), 0).is_ok());
        for url in [
            "https://127.0.0.1:4173",
            "http://example.com:4173",
            "http://127.0.0.1:9999",
            "http://user@127.0.0.1:4173",
            "http://127.0.0.1:4173/other",
            "http://127.0.0.1:4173/?token=x",
        ] {
            assert!(ready_url(&message(url), 4173).is_err(), "{url}");
        }
        assert!(
            ready_url(
                r#"{"event":"ready","protocol":2,"url":"http://127.0.0.1:4173"}"#,
                4173
            )
            .is_err()
        );
    }
}
