use std::{env, fs, path::Path};

fn collect(directory: &Path, root: &Path, entries: &mut Vec<String>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut paths: Vec<_> = fs::read_dir(directory)
        .expect("read web directory")
        .map(|entry| entry.expect("read web entry").path())
        .collect();
    paths.sort();
    for path in paths {
        if path.file_name().unwrap().to_string_lossy().starts_with('.') {
            continue;
        }
        assert!(!path.is_symlink(), "web assets must not be symlinks");
        if path.is_dir() {
            collect(&path, root, entries);
        } else {
            let name = path.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/");
            let mime = match path.extension().and_then(|value| value.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("json") => "application/json",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                Some("ico") => "image/x-icon",
                Some("woff2") => "font/woff2",
                _ => "application/octet-stream",
            };
            entries.push(format!("{name:?} => Some((include_bytes!({path:?}).as_slice(), {mime:?})),"));
        }
    }
}

fn main() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../web");
    assert!(root.join("index.html").is_file(), "web/index.html is required");
    let mut entries = Vec::new();
    collect(&root, &root, &mut entries);
    let source = format!(
        "fn embedded_asset(path: &str) -> Option<(&'static [u8], &'static str)> {{ match path {{ {} _ => None }} }}",
        entries.join("\n")
    );
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("web_assets.rs"), source)
        .expect("write embedded web assets");
}
