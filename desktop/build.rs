fn main() {
    println!(
        "cargo:rustc-env=DESKTOP_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_save",
            "desktop_copy",
            "desktop_close",
            "desktop_directory_info",
            "desktop_select_directory",
            "desktop_smoke_switch",
            "desktop_smoke_result",
        ]),
    ))
    .expect("build desktop resources");
}
