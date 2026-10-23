use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const LEGACY_IDENTIFIER: &str = "com.securevault.desktop";

#[derive(Serialize, Deserialize)]
struct Preferences {
    data_dir: PathBuf,
}

pub fn load(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes)
            .map(|settings| Some(settings.data_dir))
            .map_err(|e| format!("无法读取目录设置 {}：{e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法读取目录设置 {}：{e}", path.display())),
    }
}

// Persist only the path, never vault contents or passwords. tempfile replaces atomically
// on Windows as well as Unix; a failed write leaves the previous preference intact.
pub fn save(path: &Path, data_dir: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("目录设置路径无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(
        &mut file,
        &Preferences {
            data_dir: data_dir.to_owned(),
        },
    )
    .map_err(|e| e.to_string())?;
    file.flush()
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resolve(
    explicit: Option<PathBuf>,
    environment: Option<PathBuf>,
    settings: &Path,
    default: PathBuf,
) -> Result<PathBuf, String> {
    let path = if let Some(path) = explicit.or(environment) {
        path
    } else if let Some(saved) = load(settings)? {
        // Never silently fall back if a saved disk is disconnected or a folder was moved.
        if !saved.is_dir() {
            return Err(format!(
                "上次使用的数据目录不可用：{}。请重新连接磁盘，或选择其他数据目录。",
                saved.display()
            ));
        }
        saved
    } else {
        let legacy = default
            .parent()
            .ok_or("系统应用数据目录无效")?
            .join(LEGACY_IDENTIFIER);
        if legacy.try_exists().map_err(|e| e.to_string())? {
            legacy
        } else {
            default
        }
    };
    if path.as_os_str().is_empty() {
        return Err("数据目录不能为空".into());
    }
    std::path::absolute(path).map_err(|e| e.to_string())
}

// Accept a data root or its vault/ child. Never interpret an unrelated or partially
// damaged nonempty directory as a new vault, and never copy/move/remove user files.
pub fn selected(path: &Path, existing_only: bool) -> Result<PathBuf, String> {
    let mut root = path
        .canonicalize()
        .map_err(|e| format!("无法打开所选目录：{e}"))?;
    if !root.is_dir() {
        return Err("请选择文件夹".into());
    }
    if root.file_name().is_some_and(|name| name == "vault")
        && (root.join("vault.meta.json").exists() || root.join("securevault.db").exists())
    {
        root = root.parent().ok_or("保险库目录无效")?.to_owned();
    }
    if root.join("vault.meta.json").exists() || root.join("securevault.db").exists() {
        return Err("此目录包含旧版保险库文件，请先使用原有迁移流程；不会覆盖现有文件。".into());
    }
    let vault = root.join("vault");
    let meta = vault.join("vault.meta.json").is_file();
    let database = vault.join("securevault.db").is_file();
    if meta && database {
        return Ok(root);
    }
    if vault.exists() {
        return Err("保险库文件不完整：需要 vault/vault.meta.json 和 vault/securevault.db。请检查备份，不会新建或覆盖保险库。".into());
    }
    if existing_only {
        return Err("所选目录没有已有保险库，请选择包含 vault 文件夹的数据目录。".into());
    }
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // The backend leaves its advisory lock file after closing an empty data root.
        if !matches!(
            entry.file_name().to_str(),
            Some(".DS_Store" | ".server.lock")
        ) {
            return Err(
                "新数据目录必须为空。所选目录有其他文件，请选择空文件夹或已有保险库。".into(),
            );
        }
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch() -> tempfile::TempDir {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/.build");
        fs::create_dir_all(&base).unwrap();
        tempfile::tempdir_in(base).unwrap()
    }
    #[test]
    fn selection_preserves_existing_files_and_rejects_partial_or_unrelated_data() {
        let temp = scratch();
        let root = temp.path();
        assert!(selected(root, true).is_err());
        assert!(selected(root, false).is_ok());
        fs::write(root.join("notes.txt"), b"keep me").unwrap();
        assert!(selected(root, false).is_err());
        fs::create_dir(root.join("vault")).unwrap();
        fs::write(root.join("vault/vault.meta.json"), b"original metadata").unwrap();
        assert!(selected(root, false).is_err());
        fs::write(root.join("vault/securevault.db"), b"original database").unwrap();
        assert_eq!(
            selected(&root.join("vault"), true).unwrap(),
            root.canonicalize().unwrap()
        );
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"keep me");
        assert_eq!(
            fs::read(root.join("vault/securevault.db")).unwrap(),
            b"original database"
        );
    }
    #[test]
    fn precedence_legacy_compatibility_and_atomic_preferences() {
        let temp = scratch();
        let root = temp.path();
        let default = root.join("org.nx.securevault");
        let legacy = root.join(LEGACY_IDENTIFIER);
        let prefs = root.join("config/settings.json");
        assert_eq!(
            resolve(None, None, &prefs, default.clone()).unwrap(),
            default
        );
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("preserve"), b"old").unwrap();
        assert_eq!(
            resolve(None, None, &prefs, default.clone()).unwrap(),
            legacy
        );
        let chosen = root.join("chosen");
        fs::create_dir(&chosen).unwrap();
        save(&prefs, &chosen).unwrap();
        assert_eq!(
            resolve(None, None, &prefs, default.clone()).unwrap(),
            chosen
        );
        assert_eq!(
            resolve(None, Some(legacy.clone()), &prefs, default.clone()).unwrap(),
            legacy
        );
        assert_eq!(
            resolve(
                Some(chosen.clone()),
                Some(legacy.clone()),
                &prefs,
                default.clone()
            )
            .unwrap(),
            chosen
        );
        save(&prefs, &legacy).unwrap();
        assert_eq!(load(&prefs).unwrap(), Some(legacy.clone()));
        save(&prefs, &root.join("missing")).unwrap();
        assert!(resolve(None, None, &prefs, default).is_err());
        assert_eq!(fs::read(legacy.join("preserve")).unwrap(), b"old");
    }
}
