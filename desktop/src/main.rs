#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod directories;
mod service;

use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{
    Manager, WebviewWindow,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

struct Desktop {
    service: Mutex<service::Service>,
    closing: AtomicBool,
    confirming: AtomicBool,
    exit_allowed: AtomicBool,
    smoke: bool,
    switching: AtomicBool,
    settings: PathBuf,
    initial_dir: PathBuf,
}

#[derive(Default, Clone)]
struct Options {
    data_dir: Option<PathBuf>,
    port: Option<u16>,
    smoke: bool,
}

fn options() -> Result<Options, String> {
    let mut result = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" | "-d" => {
                result.data_dir = Some(PathBuf::from(args.next().ok_or("--data-dir 后需要目录")?))
            }
            "--port" | "-p" => {
                result.port = Some(
                    args.next()
                        .ok_or("--port 后需要端口")?
                        .parse()
                        .map_err(|_| "端口无效")?,
                )
            }
            "--smoke-test" if cfg!(debug_assertions) => result.smoke = true,
            "--help" | "-h" => {
                println!(
                    "SecureVault 桌面版\n  --data-dir PATH  指定保险库目录\n  --port PORT      指定本机服务端口；0 自动分配。未指定时优先 4173，被占用则自动分配\n目录优先级：--data-dir > SECUREVAULT_DATA_DIR > 上次选择 > 旧版应用目录 > 系统应用数据目录"
                );
                std::process::exit(0);
            }
            arg if arg.starts_with("-psn_") => {} // Finder on older macOS.
            _ => return Err(format!("未知参数：{arg}")),
        }
    }
    if result.smoke && result.data_dir.as_ref().is_none_or(|path| path.exists()) {
        return Err("桌面冒烟检查必须指定尚不存在的独立 --data-dir".into());
    }
    Ok(result)
}

fn trusted(window: &WebviewWindow, state: &Desktop) -> Result<(), String> {
    let expected = state
        .service
        .lock()
        .map_err(|_| "服务状态不可用")?
        .url
        .origin();
    if window.label() != "main" || window.url().map_err(|e| e.to_string())?.origin() != expected {
        return Err("此页面不能调用桌面功能".into());
    }
    Ok(())
}

#[tauri::command]
fn desktop_directory_info(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
) -> Result<String, String> {
    trusted(&window, &state)?;
    Ok(state
        .service
        .lock()
        .map_err(|_| "服务状态不可用")?
        .data_dir
        .display()
        .to_string())
}

struct Switching<'a>(&'a AtomicBool);
impl Drop for Switching<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn change_directory(app: tauri::AppHandle, directory: PathBuf) -> Result<(), String> {
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<Desktop>();
        let mut service = state.service.lock().map_err(|_| "服务状态不可用")?;
        Ok::<_, String>(service.switch_to(directory, &state.settings))
    })
    .await
    .map_err(|e| e.to_string())??;
    if result.reload {
        if let Some(window) = app.get_webview_window("main") {
            // The old service/session has ended. Clear sensitive UI and drafts before reload,
            // including on rollback. No new server is unlocked implicitly.
            window
                .eval("window.secureVaultDirectoryChanged?.()")
                .map_err(|e| e.to_string())?;
        }
        if let Some(error) = result.error {
            app.dialog()
                .message(error)
                .title("SecureVault 数据目录")
                .show(|_| {});
        }
        Ok(())
    } else {
        result.error.map_or(Ok(()), Err)
    }
}

#[tauri::command]
async fn desktop_select_directory(
    window: WebviewWindow,
    state: tauri::State<'_, Desktop>,
    existing_only: bool,
    dirty: bool,
) -> Result<(), String> {
    trusted(&window, &state)?;
    if state.closing.load(Ordering::SeqCst)
        || state.confirming.load(Ordering::SeqCst)
        || state.switching.swap(true, Ordering::SeqCst)
    {
        return Err("请先完成当前桌面操作".into());
    }
    let _guard = Switching(&state.switching);
    let current = state
        .service
        .lock()
        .map_err(|_| "服务状态不可用")?
        .data_dir
        .clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_directory(&current)
        .set_title(if existing_only {
            "选择已有保险库的数据目录"
        } else {
            "选择空文件夹或已有保险库的数据目录"
        })
        .pick_folder(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive.await.map_err(|_| "目录选择窗口已关闭")? else {
        return Ok(());
    };
    let directory =
        directories::selected(&path.into_path().map_err(|e| e.to_string())?, existing_only)?;
    if current.canonicalize().ok().as_ref() == Some(&directory) {
        return directories::save(&state.settings, &directory);
    }
    let warning = if dirty {
        "有未保存的修改或正在进行的操作，切换会丢弃未保存内容。\n\n"
    } else {
        ""
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    window.dialog().message(format!("{warning}切换到：{}\n\n原目录和已有数据会保留，不会复制、移动或覆盖。切换后需要重新解锁；空目录需自行初始化。\n下次启动仍优先使用命令行或 SECUREVAULT_DATA_DIR 指定的目录。", directory.display()))
        .title("切换数据目录？").buttons(MessageDialogButtons::OkCancelCustom("切换目录".into(), "取消".into()))
        .show(move |accepted| { let _ = send.send(accepted); });
    if !receive.await.map_err(|_| "确认窗口已关闭")? {
        return Ok(());
    }
    change_directory(window.app_handle().clone(), directory).await
}

#[tauri::command]
async fn desktop_smoke_switch(
    window: WebviewWindow,
    state: tauri::State<'_, Desktop>,
    original: bool,
) -> Result<(), String> {
    trusted(&window, &state)?;
    if !cfg!(debug_assertions) || !state.smoke {
        return Err("测试接口未启用".into());
    }
    if state.switching.swap(true, Ordering::SeqCst) {
        return Err("正在切换".into());
    }
    let _guard = Switching(&state.switching);
    let target = if original {
        state.initial_dir.clone()
    } else {
        state.initial_dir.with_file_name("smoke-second-vault")
    };
    if !original {
        std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    }
    let target = directories::selected(&target, original)?;
    change_directory(window.app_handle().clone(), target).await
}

#[tauri::command]
fn desktop_copy(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    text: String,
) -> Result<(), String> {
    trusted(&window, &state)?;
    if text.len() > 1024 * 1024 {
        return Err("复制内容超过 1 MiB".into());
    }
    window
        .app_handle()
        .clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_save(
    window: WebviewWindow,
    state: tauri::State<'_, Desktop>,
    name: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    trusted(&window, &state)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("桌面导出超过 64 MiB，请通过浏览器下载".into());
    }
    // Only a suggested basename comes from the page. The native picker grants the destination.
    let name = name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("securevault-export");
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(name)
        .save_file(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive.await.map_err(|_| "保存窗口已关闭")? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(true)
}

fn exit(app: &tauri::AppHandle, code: i32) {
    app.state::<Desktop>()
        .exit_allowed
        .store(true, Ordering::SeqCst);
    app.exit(code);
}

fn finish_close(app: tauri::AppHandle, dirty: bool) {
    if !dirty {
        exit(&app, 0);
        return;
    }
    if app
        .state::<Desktop>()
        .confirming
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    app.dialog()
        .message("有未保存的修改或正在进行的操作。退出将丢弃未保存内容并关闭本地服务。")
        .title("退出 SecureVault？")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "退出".into(),
            "继续使用".into(),
        ))
        .show(move |accepted| {
            if accepted {
                exit(&app, 0);
            } else {
                app.state::<Desktop>()
                    .confirming
                    .store(false, Ordering::SeqCst);
            }
        });
}

#[tauri::command]
fn desktop_close(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    dirty: bool,
) -> Result<(), String> {
    trusted(&window, &state)?;
    if state.closing.swap(false, Ordering::SeqCst) {
        finish_close(window.app_handle().clone(), dirty);
    }
    Ok(())
}

fn request_close(app: &tauri::AppHandle) {
    let state = app.state::<Desktop>();
    if state.exit_allowed.load(Ordering::SeqCst)
        || state.switching.load(Ordering::SeqCst)
        || state.confirming.load(Ordering::SeqCst)
        || state.closing.swap(true, Ordering::SeqCst)
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.secureVaultRequestClose?.()");
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        if app.state::<Desktop>().closing.swap(false, Ordering::SeqCst) {
            // An unresponsive or not-yet-loaded frontend must not prevent quitting.
            finish_close(app, true);
        }
    });
}

#[tauri::command]
fn desktop_smoke_result(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    error: Option<String>,
) -> Result<(), String> {
    trusted(&window, &state)?;
    if !cfg!(debug_assertions) || !state.smoke {
        return Err("测试接口未启用".into());
    }
    if let Some(error) = error {
        eprintln!("DESKTOP_SMOKE_FAILED: {error}");
        exit(window.app_handle(), 1);
    } else {
        println!("DESKTOP_SMOKE_OK");
        request_close(window.app_handle());
    }
    Ok(())
}

fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let quit = MenuItem::with_id(app, "quit", "退出 SecureVault", true, Some("CmdOrCtrl+Q"))?;
    let info = MenuItem::with_id(app, "info", "服务与数据目录…", true, None::<&str>)?;
    let open = MenuItem::with_id(
        app,
        "open-vault",
        "打开已有保险库…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let directory =
        MenuItem::with_id(app, "change-directory", "切换数据目录…", true, None::<&str>)?;
    let seal = MenuItem::with_id(app, "seal", "封印保险库", true, Some("CmdOrCtrl+Shift+L"))?;
    let application = Submenu::with_items(
        app,
        "SecureVault",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 SecureVault"), None)?,
            &info,
            &open,
            &directory,
            &seal,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&application, &edit])
}

fn setup(app: &tauri::AppHandle, options: Options) -> Result<(), Box<dyn std::error::Error>> {
    let settings = if options.smoke {
        options
            .data_dir
            .as_ref()
            .unwrap()
            .parent()
            .ok_or("测试目录无效")?
            .join("desktop-settings.json")
    } else {
        app.path().app_config_dir()?.join("desktop/settings.json")
    };
    let environment = std::env::var_os("SECUREVAULT_DATA_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut data_dir = directories::resolve(
        options.data_dir,
        environment,
        &settings,
        app.path().app_data_dir()?,
    )
    .map_err(std::io::Error::other)?;
    if data_dir.join("vault").exists()
        || data_dir.join("vault.meta.json").exists()
        || data_dir.join("securevault.db").exists()
    {
        data_dir = directories::selected(&data_dir, true).map_err(std::io::Error::other)?;
    }
    let initial_dir = data_dir.clone();
    let service =
        service::Service::launch(data_dir, options.port).map_err(std::io::Error::other)?;
    let url = service.url.clone();
    println!("DESKTOP_SERVICE_URL={url}");
    app.manage(Desktop {
        service: Mutex::new(service),
        closing: AtomicBool::new(false),
        confirming: AtomicBool::new(false),
        exit_allowed: AtomicBool::new(false),
        smoke: options.smoke,
        switching: AtomicBool::new(false),
        settings,
        initial_dir,
    });
    let mut permissions = vec![
        "allow-desktop-save",
        "allow-desktop-copy",
        "allow-desktop-close",
        "allow-desktop-directory-info",
        "allow-desktop-select-directory",
    ];
    if cfg!(debug_assertions) && options.smoke {
        permissions.push("allow-desktop-smoke-result");
        permissions.push("allow-desktop-smoke-switch");
    }
    let capability = serde_json::json!({
        "identifier": "local-vault", "description": "仅对本次启动的本机保险库开放保存、复制、目录选择和退出反馈",
        "local": false, "windows": ["main"], "remote": {"urls": [format!("{}/*", url.origin().ascii_serialization())]},
        "permissions": permissions
    });
    app.add_capability(capability.to_string())?;
    app.set_menu(menu(app)?)?;
    let origin = url.origin();
    let handle = app.clone();
    let external = app.clone();
    let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
        .title("SecureVault")
        .inner_size(1280.0, 860.0)
        .min_inner_size(800.0, 600.0)
        .initialization_script(
            "Object.defineProperty(window, '__SECUREVAULT_DESKTOP__', {value: true});",
        )
        .on_navigation(move |url| {
            if url.origin() == origin && matches!(url.path(), "/" | "/index.html") {
                return true;
            }
            if matches!(url.scheme(), "https" | "http") && url.origin() != origin {
                let _ = external.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "https" | "http") {
                let _ = handle.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            #[cfg(debug_assertions)]
            if options.smoke && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = window.eval(include_str!("../smoke.js"));
            }
            #[cfg(not(debug_assertions))]
            let _ = (window, payload);
        })
        .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            request_close(&handle);
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let state = handle.state::<Desktop>();
            if state.exit_allowed.load(Ordering::SeqCst) {
                break;
            }
            let mut service = state.service.lock().unwrap();
            if service.has_exited() {
                let error = service.error_text();
                drop(service);
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.eval("window.dispatchEvent(new Event('offline'))");
                }
                if state.smoke {
                    eprintln!("DESKTOP_SMOKE_FAILED: 本地服务退出 {error}");
                    exit(&handle, 1);
                } else {
                    let exit_handle = handle.clone();
                    handle
                        .dialog()
                        .message(format!("本地服务已退出，请重新打开应用。\n{error}"))
                        .title("SecureVault 服务中断")
                        .show(move |_| exit(&exit_handle, 1));
                }
                break;
            }
        }
    });
    Ok(())
}

fn startup_failure(app: tauri::AppHandle, options: Options, error: String) {
    // When no service could be started, still offer a way to repair a saved directory
    // selection without requiring the user to edit a config file or use a terminal.
    if app.try_state::<Desktop>().is_some() {
        let handle = app.clone();
        app.dialog()
            .message(error)
            .title("SecureVault 无法启动")
            .show(move |_| exit(&handle, 1));
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "{error}\n\n可重新选择数据目录。原有数据会保留；端口冲突需先停止占用端口的服务。"
        ))
        .title("SecureVault 无法启动")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "选择数据目录…".into(),
            "退出".into(),
        ))
        .show(move |choose| {
            if !choose {
                handle.exit(1);
                return;
            }
            let picked = handle.clone();
            handle
                .dialog()
                .file()
                .set_title("选择空文件夹或已有保险库的数据目录")
                .pick_folder(move |path| {
                    let Some(path) = path else {
                        picked.exit(1);
                        return;
                    };
                    let directory = path
                        .into_path()
                        .map_err(|e| e.to_string())
                        .and_then(|path| directories::selected(&path, false));
                    match directory {
                        Err(error) => startup_failure(picked, options, error),
                        Ok(directory) => {
                            let mut retry = options;
                            retry.data_dir = Some(directory.clone());
                            let main = picked.clone();
                            let _ = picked.run_on_main_thread(move || {
                                if let Err(error) = setup(&main, retry.clone()) {
                                    startup_failure(main, retry, error.to_string());
                                } else if let Err(error) =
                                    directories::save(&main.state::<Desktop>().settings, &directory)
                                {
                                    main.dialog()
                                        .message(format!("已打开保险库，但无法记住目录：{error}"))
                                        .title("SecureVault")
                                        .show(|_| {});
                                }
                            });
                        }
                    }
                });
        });
}

fn main() {
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desktop_copy, desktop_save, desktop_close, desktop_directory_info, desktop_select_directory, desktop_smoke_result, desktop_smoke_switch])
        .setup(move |app| {
            let smoke = options.smoke;
            if let Err(error) = setup(app.handle(), options.clone()) {
                eprintln!("桌面启动失败：{error}");
                if smoke { return Err(error); }
                startup_failure(app.handle().clone(), options, error.to_string());
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => request_close(app),
            "open-vault" | "change-directory" => {
                if let Some(window) = app.get_webview_window("main") {
                    let existing = event.id().as_ref() == "open-vault";
                    let _ = window.eval(format!("window.secureVaultSelectDirectory?.({existing})"));
                }
            }
            "seal" => { if let Some(window) = app.get_webview_window("main") { let _ = window.eval("if (typeof sealVault === 'function') sealVault()"); } },
            "info" => {
                if let Some(state) = app.try_state::<Desktop>() {
                    let service = state.service.lock().unwrap();
                    app.dialog().message(format!("服务地址：{}\n数据目录：{}\n\n关闭应用会停止本地服务。Raycast 和 httpyac 可使用上面的服务地址。", service.url, service.data_dir.display()))
                        .title("SecureVault").show(|_| {});
                }
            }
            _ => {},
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("创建桌面应用失败");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if let Some(state) = app.try_state::<Desktop>()
                && !state.exit_allowed.load(Ordering::SeqCst)
            {
                api.prevent_exit();
                request_close(app);
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(state) = app.try_state::<Desktop>() {
                state.exit_allowed.store(true, Ordering::SeqCst);
                state.service.lock().unwrap().stop();
            }
        }
        _ => {}
    });
}
