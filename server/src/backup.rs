use super::*;
use rotation::{check_integrity, hidden_password, publish_directory, state_for};
use std::io::{BufRead, BufReader, Read, Write};

// Public interchange v1 is JSONL, not SQL or SQLCipher pages. Only these logical
// columns are admitted; keys, key hashes, ciphertext and derived indexes are excluded.
const TABLES: &[(&str, &[&str])] = &[
    (
        "datasets",
        &[
            "id",
            "category_path",
            "environment",
            "fields_json",
            "identity_fields_json",
            "conflict_strategy",
            "list_fields_json",
            "created_at",
            "description",
        ],
    ),
    (
        "records",
        &[
            "id",
            "dataset_id",
            "category_path",
            "environment",
            "indexes_json",
            "display_json",
            "duplicate_of",
            "expired",
            "updated_at",
        ],
    ),
    ("protected_fields", &["record_id", "source_key", "zone"]),
    (
        "import_templates",
        &["name", "dataset_id", "mappings_json", "updated_at"],
    ),
    (
        "api_apps",
        &[
            "id",
            "name",
            "permission",
            "disabled",
            "datasets_json",
            "access_expires_at",
            "created_at",
        ],
    ),
    (
        "audit_events",
        &["id", "event", "record_id", "field_name", "created_at"],
    ),
];
const MAX_LINE: u64 = 16 * 1024 * 1024;
const MAX_EXPANDED: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Deserialize, Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct Passwords {
    master_password: String,
    backup_password: String,
    confirm_password: String,
}

pub(super) fn run_cli() -> ApiResult<()> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let args: Vec<_> = std::env::args().skip(2).collect();
    let mut source = None;
    let mut output = None;
    let mut stdin = false;
    let mut i = 0;
    let mut seen = std::collections::HashSet::new();
    while i < args.len() {
        let flag = cli_flag(&args[i], &mode);
        if !seen.insert(flag) {
            return Err(bad_request(format!("参数 {flag} 重复，请只指定一次")));
        }
        match flag {
            "--data-dir" if mode == "backup" => {
                i += 1;
                source = Some(PathBuf::from(
                    args.get(i)
                        .ok_or_else(|| bad_request("缺少数据目录路径"))?,
                ));
            }
            "--input" if mode == "restore" => {
                i += 1;
                source = Some(PathBuf::from(
                    args.get(i)
                        .ok_or_else(|| bad_request("缺少输入文件路径"))?,
                ));
            }
            "--output" if mode == "backup" => {
                i += 1;
                output = Some(PathBuf::from(
                    args.get(i)
                        .ok_or_else(|| bad_request("缺少输出文件路径"))?,
                ));
            }
            "--output-dir" if mode == "restore" => {
                i += 1;
                output = Some(PathBuf::from(
                    args.get(i)
                        .ok_or_else(|| bad_request("缺少输出目录路径"))?,
                ));
            }
            "--passwords-stdin" => stdin = true,
            "--help" | "-h" => {
                println!(
                    "用法：securevault backup -d 源目录 -o backup.jsonl.gz.age\n      securevault restore -i backup.jsonl.gz.age -o 新目录\n选项：\n  -d, --data-dir 路径       备份时使用的源数据目录\n  -i, --input 文件          恢复时读取的加密备份文件\n  -o, --output 文件         备份输出文件（必须不存在）\n  -o, --output-dir 路径     恢复输出目录（必须不存在）\n  -s, --passwords-stdin     从标准输入读取密码 JSON\n  -h, --help                显示帮助\n默认通过终端输入密码，输入时不回显。\n使用 -s 时，JSON 必须包含 master_password、backup_password、confirm_password 三个字段。\n备份时：分别填写当前主密码、独立备份密码、备份密码确认。\n恢复时：分别填写新库主密码、备份密码、新库主密码确认。\n备份前请停止源目录上的服务；恢复后旧应用凭据全部撤销，需要重新签发。"
                );
                return Ok(());
            }
            _ => return Err(bad_request("未知的备份或恢复参数")),
        }
        i += 1;
    }
    let source = source.ok_or_else(|| bad_request("必须指定源目录（-d）或备份输入文件（-i）"))?;
    let output = output.ok_or_else(|| bad_request("必须指定输出文件或目录（-o）"))?;
    // Reject paths, an active server and existing outputs before asking for secrets.
    destination(&output)?;
    if mode == "backup" {
        let source = backup_source(&source)?;
        drop(lock_data_directory(&source).map_err(|e| {
            if e.0 == StatusCode::CONFLICT {
                bad_request("源数据目录正在被使用，请先停止服务再备份")
            } else {
                e
            }
        })?);
    } else if !source.is_file() {
        return Err(bad_request("备份输入文件不存在或不是普通文件"));
    }
    let passwords: Passwords = if stdin {
        let mut bytes = Zeroizing::new(Vec::new());
        std::io::stdin()
            .take(32769)
            .read_to_end(&mut bytes)
            .map_err(internal)?;
        if bytes.len() > 32768 {
            return Err(bad_request("密码 JSON 输入超过 32 KiB 限制"));
        }
        serde_json::from_slice(&bytes).map_err(|_| bad_request("密码 JSON 格式无效，请按帮助说明提供字段"))?
    } else {
        let mut p = Passwords {
            master_password: String::new(),
            backup_password: String::new(),
            confirm_password: String::new(),
        };
        if mode == "backup" {
            p.master_password = hidden_password("当前主密码：")?;
            p.backup_password = hidden_password("独立备份密码：")?;
            p.confirm_password = hidden_password("确认备份密码：")?;
        } else {
            p.backup_password = hidden_password("备份密码：")?;
            p.master_password = hidden_password("新库主密码：")?;
            p.confirm_password = hidden_password("确认新库主密码：")?;
        }
        p
    };
    validate_new_password(&passwords.backup_password)?;
    let warning = if mode == "backup" {
        if passwords.backup_password != passwords.confirm_password {
            return Err(bad_request("两次输入的备份密码不一致"));
        }
        if passwords.backup_password == passwords.master_password {
            return Err(bad_request(
                "备份密码必须与当前主密码不同",
            ));
        }
        backup(
            &source,
            &output,
            &passwords.master_password,
            &passwords.backup_password,
        )?
    } else {
        validate_new_password(&passwords.master_password)?;
        if passwords.master_password != passwords.confirm_password {
            return Err(bad_request("两次输入的新库主密码不一致"));
        }
        if passwords.backup_password == passwords.master_password {
            return Err(bad_request(
                "新库主密码必须与备份密码不同",
            ));
        }
        restore(
            &source,
            &output,
            &passwords.backup_password,
            &passwords.master_password,
        )?
    };
    println!(
        "{}完成：{}",
        if mode == "backup" {
            "全量加密备份"
        } else {
            "全量恢复（旧应用凭据已撤销）"
        },
        output.display()
    );
    if warning {
        eprintln!("警告：输出已发布，但父目录持久化同步失败；请验证输出及存储状态。");
    }
    Ok(())
}

fn backup_source(path: &FsPath) -> ApiResult<PathBuf> {
    let source = fs::canonicalize(path).map_err(|_| bad_request("源数据目录不存在或无法访问"))?;
    if !source.is_dir() {
        return Err(bad_request("--data-dir 必须是数据目录"));
    }
    if source.join("vault.meta.json").exists() || source.join("securevault.db").exists() {
        if source.file_name() == Some(std::ffi::OsStr::new("vault")) {
            return Err(bad_request(format!(
                "--data-dir 多传了一层 vault/；请传其父目录：{}",
                source.parent().unwrap_or(&source).display()
            )));
        }
        return Err(bad_request(
            "该目录使用不兼容的旧开发数据布局，当前版本无法备份；需要使用与该数据格式兼容的工具版本读取",
        ));
    }
    let state = state_for(source.clone());
    if !meta_path(&state).is_file() {
        return Err(bad_request(
            "数据目录尚未初始化；--data-dir 应包含 vault/vault.meta.json 和 vault/securevault.db",
        ));
    }
    if !database_path(&state).is_file() {
        return Err(bad_request("密钥封装存在，但 vault/securevault.db 缺失"));
    }
    read_meta(&state)?;
    Ok(source)
}

fn destination(path: &FsPath) -> ApiResult<PathBuf> {
    let parent = fs::canonicalize(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(FsPath::new(".")),
    )
    .map_err(internal)?;
    let path = parent.join(
        path.file_name()
            .ok_or_else(|| bad_request("输出路径无效"))?,
    );
    if fs::symlink_metadata(&path).is_ok() {
        return Err(bad_request("输出路径已存在，请选择新路径，避免覆盖原有数据"));
    }
    Ok(path)
}
fn private_file(path: &FsPath) -> ApiResult<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path).map_err(internal)
}
fn line(writer: &mut impl Write, value: &Value) -> ApiResult<()> {
    let bytes = Zeroizing::new(serde_json::to_vec(value).map_err(internal)?);
    if bytes.len() as u64 + 1 > MAX_LINE {
        return Err(bad_request("单条备份数据超过 16 MiB 限制"));
    }
    writer.write_all(&bytes).map_err(internal)?;
    writer.write_all(b"\n").map_err(internal)
}
fn write_logical(connection: &Connection, keys: &KeySet, writer: &mut impl Write) -> ApiResult<()> {
    line(
        writer,
        &json!({"type":"header","format":"securevault-logical","version":1,"producer":env!("CARGO_PKG_VERSION"),"created_at":unix_now()}),
    )?;
    let mut counts = serde_json::Map::new();
    let has_description: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('datasets') WHERE name='description')", [], |row| row.get(0)).map_err(internal)?;
    for &(table, columns) in TABLES {
        let selected = columns.iter().map(|column| {
            if table == "datasets" && *column == "description" && !has_description { "'' AS description" } else { *column }
        }).collect::<Vec<_>>().join(",");
        let mut statement = connection
            .prepare(&format!(
                "SELECT {} FROM {table} ORDER BY {}",
                selected,
                columns[0]
            ))
            .map_err(internal)?;
        let mut rows = statement.query([]).map_err(internal)?;
        let mut count = 0u64;
        while let Some(row) = rows.next().map_err(internal)? {
            let mut data = serde_json::Map::new();
            for (i, column) in columns.iter().enumerate() {
                if table == "datasets" && *column == "description" && row.get::<_, String>(i).map_err(internal)?.is_empty() { continue; }
                let value = match row.get_ref(i).map_err(internal)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Text(text) => {
                        let text = std::str::from_utf8(text).map_err(internal)?;
                        if column.ends_with("_json") {
                            serde_json::from_str(text).map_err(internal)?
                        } else {
                            json!(text)
                        }
                    }
                    _ => return Err(internal("unsupported logical value")),
                };
                data.insert(
                    column.strip_suffix("_json").unwrap_or(column).to_string(),
                    value,
                );
            }
            if table == "protected_fields" {
                let record = data["record_id"]
                    .as_str()
                    .ok_or_else(|| internal("invalid record id"))?;
                let field = data["source_key"]
                    .as_str()
                    .ok_or_else(|| internal("invalid field"))?;
                let (nonce,ciphertext):(Vec<u8>,Vec<u8>)=connection.query_row("SELECT nonce,ciphertext FROM protected_fields WHERE record_id=?1 AND source_key=?2",params![record,field],|r|Ok((r.get(0)?,r.get(1)?))).map_err(internal)?;
                data.insert(
                    "value".into(),
                    open_field(&keys.field, record, field, &nonce, &ciphertext)?,
                );
            }
            line(writer, &json!({"type":table,"data":data}))?;
            count += 1;
        }
        counts.insert(table.into(), json!(count));
    }
    line(writer, &json!({"type":"end","counts":counts}))
}
fn backup(source: &FsPath, output: &FsPath, master: &str, password: &str) -> ApiResult<bool> {
    let source = backup_source(source)?;
    let _lock = lock_data_directory(&source)?;
    let state = state_for(source);
    let keys = unwrap_keys(master, &read_meta(&state)?)?;
    let db = open_database(&database_path(&state), &keys.db)?;
    db.execute_batch("PRAGMA temp_store=MEMORY; BEGIN")
        .map_err(internal)?;
    check_integrity(&db)?;
    let output = destination(output)?;
    let parent = output.parent().unwrap();
    let temp = parent.join(format!(".backup-{}.tmp", Uuid::new_v4().simple()));
    let result = (|| {
        let file = private_file(&temp)?;
        let mut recipient =
            age::scrypt::Recipient::new(age::secrecy::SecretString::from(password.to_owned()));
        recipient.set_work_factor(18);
        let encryptor =
            age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
                .map_err(internal)?;
        let encrypted = encryptor.wrap_output(file).map_err(internal)?;
        let mut compressed =
            flate2::write::GzEncoder::new(encrypted, flate2::Compression::default());
        write_logical(&db, &keys, &mut compressed)?;
        let encrypted = compressed.finish().map_err(internal)?;
        let file = encrypted.finish().map_err(internal)?;
        file.sync_all().map_err(internal)?;
        drop(file);
        // Re-read the entire authenticated stream before publishing; no plaintext file.
        let mut verify = decrypted_gzip(&temp, password)?;
        let length = std::io::copy(
            &mut verify.by_ref().take(MAX_EXPANDED + 1),
            &mut std::io::sink(),
        )
        .map_err(internal)?;
        if length > MAX_EXPANDED {
            return Err(bad_request("备份解压后的数据超过 16 GiB 限制"));
        }
        fs::hard_link(&temp, &output).map_err(internal)?;
        let _ = fs::remove_file(&temp);
        Ok(sync_directory(parent).is_err())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn decrypted_gzip(path: &FsPath, password: &str) -> ApiResult<impl Read> {
    let decryptor =
        age::Decryptor::new_buffered(BufReader::new(fs::File::open(path).map_err(internal)?))
            .map_err(|_| bad_request("备份文件的 age 格式无效"))?;
    if !decryptor.is_scrypt() {
        return Err(bad_request("备份文件必须使用 age 密码加密"));
    }
    let mut identity =
        age::scrypt::Identity::new(age::secrecy::SecretString::from(password.to_owned()));
    identity.set_max_work_factor(20);
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| bad_request("备份密码错误或备份文件已损坏"))?;
    // MultiGzDecoder reads to authenticated EOF, including the final age chunk.
    Ok(flate2::read::MultiGzDecoder::new(reader))
}

fn restore(input: &FsPath, output: &FsPath, password: &str, master: &str) -> ApiResult<bool> {
    let output = destination(output)?;
    let parent = output.parent().unwrap();
    let temp = parent.join(format!(".vault-restore-{}", Uuid::new_v4().simple()));
    private_dir(&temp)?;
    let result = (|| {
        let _lock = lock_data_directory(&temp)?;
        let state = state_for(temp.clone());
        let (keys, warning) = initialize_vault(&state, master)?;
        if warning {
            return Err(internal("initialization durability failed"));
        }
        let mut db = open_database(&database_path(&state), &keys.db)?;
        db.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;")
            .map_err(internal)?;
        let tx = db.transaction().map_err(internal)?;
        read_logical(decrypted_gzip(input, password)?, &tx, &keys)?;
        rebuild_identities(&tx, &keys)?;
        validate_relations(&tx)?;
        tx.execute("INSERT INTO audit_events(event,field_name) VALUES('logical_backup_restored','offline_cli')",[]).map_err(internal)?;
        tx.commit().map_err(internal)?;
        check_integrity(&db)?;
        drop(db);
        let checked = unwrap_keys(master, &read_meta(&state)?)?;
        let reopened = open_database(&database_path(&state), &checked.db)?;
        check_integrity(&reopened)?;
        validate_relations(&reopened)?;
        drop(reopened);
        fs::File::open(database_path(&state))
            .map_err(internal)?
            .sync_all()
            .map_err(internal)?;
        sync_directory(&temp.join("vault")).map_err(internal)?;
        sync_directory(&temp).map_err(internal)?;
        publish_directory(&temp, &output)?;
        Ok(sync_directory(parent).is_err())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    result
}
fn read_logical(reader: impl Read, db: &Connection, keys: &KeySet) -> ApiResult<()> {
    let mut reader = BufReader::new(reader);
    let mut bytes = Zeroizing::new(Vec::new());
    let mut total = 0u64;
    let mut header = false;
    let mut ended = false;
    let mut counts = serde_json::Map::new();
    for &(table, _) in TABLES {
        counts.insert(table.into(), json!(0));
    }
    let mut current_table = 0usize;
    loop {
        bytes.zeroize();
        bytes.clear();
        let length = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| bad_request("备份认证、解压或读取失败，文件可能已损坏"))?;
        if length == 0 {
            break;
        }
        total += length as u64;
        if length as u64 > MAX_LINE || total > MAX_EXPANDED {
            return Err(bad_request("备份解压后的数据超过容量限制"));
        }
        if !bytes.ends_with(b"\n") {
            return Err(bad_request("逻辑备份被截断，数据不完整"));
        }
        if ended {
            return Err(bad_request("备份结束标记后存在多余数据"));
        }
        let item: Value =
            serde_json::from_slice(&bytes).map_err(|_| bad_request("备份 JSONL 格式无效"))?;
        let object = item
            .as_object()
            .ok_or_else(|| bad_request("备份的每行数据必须是 JSON 对象"))?;
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_request("备份数据行缺少 type 字段"))?;
        if !header {
            if kind != "header"
                || item["format"] != "securevault-logical"
                || item["version"] != 1
                || object.len() != 5
                || !item["producer"].is_string()
                || !item["created_at"].is_i64()
            {
                return Err(bad_request("不支持该逻辑备份格式或版本"));
            }
            header = true;
            continue;
        }
        if kind == "end" {
            if object.len() != 2 || item["counts"] != Value::Object(counts.clone()) {
                return Err(bad_request("备份数据行数与声明数量不一致"));
            }
            ended = true;
            continue;
        }
        if object.len() != 2 {
            return Err(bad_request("备份数据行包含未知属性"));
        }
        let index = TABLES
            .iter()
            .position(|(t, _)| *t == kind)
            .ok_or_else(|| bad_request("备份数据行类型未知"))?;
        if index < current_table {
            return Err(bad_request("备份数据表未按规定顺序排列"));
        }
        current_table = index;
        insert_row(db, keys, kind, TABLES[index].1, &item["data"])?;
        let count = counts[kind].as_u64().unwrap() + 1;
        if count > 10_000_000 {
            return Err(bad_request("备份数据行数超过限制"));
        }
        counts.insert(kind.into(), json!(count));
    }
    if !header || !ended {
        return Err(bad_request("逻辑备份不完整"));
    }
    Ok(())
}
fn insert_row(
    db: &Connection,
    keys: &KeySet,
    table: &str,
    columns: &[&str],
    data: &Value,
) -> ApiResult<()> {
    // Description is an optional v1 extension; older backups default to empty.
    let normalized = if table == "datasets" && data.get("description").is_none() {
        let mut value = data.clone();
        value.as_object_mut().ok_or_else(|| bad_request("备份的 data 字段必须是 JSON 对象"))?.insert("description".into(), json!(""));
        Some(value)
    } else { None };
    let data = normalized.as_ref().unwrap_or(data);
    let map = data
        .as_object()
        .ok_or_else(|| bad_request("备份的 data 字段必须是 JSON 对象"))?;
    if map.len() != columns.len() + usize::from(table == "protected_fields")
        || columns
            .iter()
            .any(|c| !map.contains_key(c.strip_suffix("_json").unwrap_or(c)))
    {
        return Err(bad_request("备份数据行结构与格式定义不一致"));
    }
    let text = |name: &str| -> ApiResult<&str> {
        data[name]
            .as_str()
            .ok_or_else(|| bad_request(format!("文本字段无效：{name}")))
    };
    if table == "datasets" {
        normalize_category(text("category_path")?)?;
        let fields: Vec<FieldDefinition> = serde_json::from_value(data["fields"].clone())
            .map_err(|_| bad_request("数据集字段定义无效"))?;
        let identity: Vec<String> = serde_json::from_value(data["identity_fields"].clone())
            .map_err(|_| bad_request("唯一标识字段定义无效"))?;
        let list: Vec<ListFieldDefinition> = serde_json::from_value(data["list_fields"].clone())
            .map_err(|_| bad_request("列表展示字段定义无效"))?;
        validate_schema(&fields, &identity, &list)?;
        if !matches!(text("conflict_strategy")?, "allow_mark") {
            return Err(bad_request("重复记录处理策略无效"));
        }
    }
    if table == "records"
        && (!data["indexes"].is_object()
            || !data["display"].is_object()
            || !matches!(data["expired"].as_i64(), Some(0 | 1)))
    {
        return Err(bad_request("记录结构无效"));
    }
    if table == "import_templates" {
        let _: Vec<FieldMapping> = serde_json::from_value(data["mappings"].clone())
            .map_err(|_| bad_request("导入字段映射无效"))?;
    }
    if table == "api_apps" {
        if !validate_permission(text("permission")?)
            || !matches!(data["disabled"].as_i64(), Some(0 | 1))
        {
            return Err(bad_request("应用配置无效"));
        }
        let _: Vec<String> = serde_json::from_value(data["datasets"].clone())
            .map_err(|_| bad_request("应用的数据集权限范围无效"))?;
    }
    if table == "protected_fields" {
        if !matches!(text("zone")?, "hidden" | "secrets") || !map.contains_key("value") {
            return Err(bad_request("受保护字段无效"));
        }
        let (nonce, ciphertext) = seal_field(
            &keys.field,
            text("record_id")?,
            text("source_key")?,
            &data["value"],
        )?;
        db.execute("INSERT INTO protected_fields(record_id,source_key,zone,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5)",params![text("record_id")?,text("source_key")?,text("zone")?,nonce,ciphertext]).map_err(|_|bad_request("受保护字段无效或重复"))?;
        return Ok(());
    }
    let mut values = Vec::<rusqlite::types::Value>::new();
    for column in columns {
        let value = &data[column.strip_suffix("_json").unwrap_or(column)];
        if column.ends_with("_json") {
            values.push(value.to_string().into());
            continue;
        }
        let integer = matches!(*column, "expired" | "disabled" | "access_expires_at")
            || (table == "audit_events" && *column == "id");
        let nullable = matches!(
            *column,
            "environment" | "duplicate_of" | "access_expires_at"
        ) || (table == "audit_events"
            && matches!(*column, "record_id" | "field_name"));
        values.push(if value.is_null() && nullable {
            rusqlite::types::Value::Null
        } else if integer {
            value
                .as_i64()
                .ok_or_else(|| bad_request("整数列的值无效"))?
                .into()
        } else {
            value
                .as_str()
                .ok_or_else(|| bad_request("文本列的值无效"))?
                .to_string()
                .into()
        });
    }
    let mut columns = columns.to_vec();
    if table == "records" {
        columns.extend(["search_blob"]);
        let definitions = dataset_definitions(db, text("dataset_id")?)?;
        let (display, _) = split_display_fields(&data["display"], &definitions);
        values.push(
            search_blob(
                text("category_path")?,
                data["environment"].as_str(),
                &data["indexes"],
                &display,
            )
            .into(),
        );
    }
    if table == "api_apps" {
        let index = columns.iter().position(|c| *c == "disabled").unwrap();
        values[index] = 1i64.into();
        columns.push("key_hash");
        values.push(app_key_hash(&Uuid::new_v4().to_string()).into());
    }
    let placeholders = (1..=columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    db.execute(
        &format!(
            "INSERT INTO {table}({}) VALUES({placeholders})",
            columns.join(",")
        ),
        rusqlite::params_from_iter(values),
    )
    .map_err(|_| bad_request("备份数据行无效、重复或关联关系错误"))?;
    Ok(())
}
fn rebuild_identities(db: &Connection, keys: &KeySet) -> ApiResult<()> {
    let mut statement=db.prepare("SELECT r.id,r.dataset_id,r.indexes_json,r.display_json,d.identity_fields_json FROM records r JOIN datasets d ON d.id=r.dataset_id").map_err(internal)?;
    let mut rows = statement.query([]).map_err(internal)?;
    while let Some(row) = rows.next().map_err(internal)? {
        let id: String = row.get(0).map_err(internal)?;
        let dataset: String = row.get(1).map_err(internal)?;
        let mut input = serde_json::Map::new();
        for column in [2, 3] {
            let values: serde_json::Map<String, Value> =
                serde_json::from_str(&row.get::<_, String>(column).map_err(internal)?)
                    .map_err(internal)?;
            for (field, value) in values {
                insert_nested_value(&mut input, &field, value);
            }
        }
        let fields: Vec<String> =
            serde_json::from_str(&row.get::<_, String>(4).map_err(internal)?).map_err(internal)?;
        let mut statement = db
            .prepare("SELECT source_key,nonce,ciphertext FROM protected_fields WHERE record_id=?1")
            .map_err(internal)?;
        let mut protected = statement.query([&id]).map_err(internal)?;
        while let Some(row) = protected.next().map_err(internal)? {
            let field: String = row.get(0).map_err(internal)?;
            let value = open_field(
                &keys.field,
                &id,
                &field,
                &row.get::<_, Vec<u8>>(1).map_err(internal)?,
                &row.get::<_, Vec<u8>>(2).map_err(internal)?,
            )?;
            insert_nested_value(&mut input, &field, value);
        }
        db.execute(
            "UPDATE records SET identity_hash=?2 WHERE id=?1",
            params![
                id,
                identity_hash(&keys.identity, &dataset, &fields, &Value::Object(input))
            ],
        )
        .map_err(internal)?;
    }
    Ok(())
}
fn validate_relations(db: &Connection) -> ApiResult<()> {
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM records r LEFT JOIN records p ON p.id=r.duplicate_of WHERE r.duplicate_of IS NOT NULL AND (p.id IS NULL OR p.dataset_id<>r.dataset_id))",[],|r|r.get(0)).map_err(internal)?;
    if invalid {
        return Err(bad_request("重复记录的关联关系无效"));
    }
    let mut statement = db
        .prepare("SELECT datasets_json FROM api_apps")
        .map_err(internal)?;
    let mut rows = statement.query([]).map_err(internal)?;
    while let Some(row) = rows.next().map_err(internal)? {
        let ids: Vec<String> =
            serde_json::from_str(&row.get::<_, String>(0).map_err(internal)?).map_err(internal)?;
        normalized_app_datasets(db, &ids)?;
    }
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM import_templates t LEFT JOIN datasets d ON d.id=t.dataset_id WHERE d.id IS NULL)",[],|r|r.get(0)).map_err(internal)?;
    if invalid {
        return Err(bad_request("导入模板的关联关系无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../../samples/fixtures/backup-v1.jsonl");
    #[test]
    fn normal_and_ignored_schema_fields_round_trip_without_creating_search_terms() {
        let keys = random_keys();
        let mut db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let tx = db.transaction().unwrap();
        read_logical(FIXTURE.as_bytes(), &tx, &keys).unwrap();
        tx.commit().unwrap();
        let old = dataset_definitions(&db, "dataset-fixture").unwrap();
        let mut new = old.clone();
        new.iter_mut().find(|field| field.source_key == "name").unwrap().zone = "normal".into();
        new.push(serde_json::from_value(json!({"source_key":"unused","zone":"ignore"})).unwrap());
        migrate_schema_records(&db, &keys, "dataset-fixture", &old, &new, &["account.token".into()], "固定回归", None).unwrap();
        db.execute("UPDATE datasets SET fields_json=?1", [serde_json::to_string(&new).unwrap()]).unwrap();
        let mut output = Zeroizing::new(Vec::new());
        write_logical(&db, &keys, &mut *output).unwrap();
        let mut restored = Connection::open_in_memory().unwrap();
        initialize_schema(&restored).unwrap();
        let tx = restored.transaction().unwrap();
        read_logical(output.as_slice(), &tx, &keys).unwrap();
        tx.commit().unwrap();
        let definitions = dataset_definitions(&restored, "dataset-fixture").unwrap();
        assert_eq!(definitions.iter().find(|field| field.source_key == "unused").unwrap().zone, "ignore");
        let (display, blob): (String, String) = restored.query_row("SELECT display_json,search_blob FROM records WHERE id='record-1'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        let (_, normal) = split_display_fields(&serde_json::from_str(&display).unwrap(), &definitions);
        assert_eq!(normal["name"], "示例");
        assert!(!blob.contains("示例"));
    }
    #[test]
    fn v1_fixed_fixture_preserves_types_and_relations_and_rejects_unknown_format() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("backup-fixture-{}", Uuid::new_v4()));
        private_dir(&path).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let missing = backup_source(&path).unwrap_err();
        assert!(missing.1.contains("尚未初始化"));
        let vault = path.join("vault");
        private_dir(&vault).unwrap();
        fs::write(vault.join("vault.meta.json"), b"{}").unwrap();
        assert!(backup_source(&vault).unwrap_err().1.contains("多传了一层"));
        fs::remove_dir_all(&vault).unwrap();
        fs::write(path.join("vault.meta.json"), b"{}").unwrap();
        assert!(
            backup_source(&path)
                .unwrap_err()
                .1
                .contains("旧开发数据布局")
        );
        fs::remove_file(path.join("vault.meta.json")).unwrap();
        let file = path.join("fixture.db");
        drop(private_file(&file).unwrap());
        let keys = random_keys();
        let mut db = open_database(&file, &keys.db).unwrap();
        initialize_schema(&db).unwrap();
        let tx = db.transaction().unwrap();
        read_logical(FIXTURE.as_bytes(), &tx, &keys).unwrap();
        rebuild_identities(&tx, &keys).unwrap();
        validate_relations(&tx).unwrap();
        tx.commit().unwrap();
        check_integrity(&db).unwrap();
        let mut output = Zeroizing::new(Vec::new());
        write_logical(&db, &keys, &mut *output).unwrap();
        let expected: Vec<Value> = FIXTURE
            .lines()
            .skip(1)
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let actual: Vec<Value> = std::str::from_utf8(&output)
            .unwrap()
            .lines()
            .skip(1)
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(actual, expected);
        let hashes: Vec<String> = {
            let mut s = db
                .prepare("SELECT identity_hash FROM records ORDER BY id")
                .unwrap();
            s.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(hashes.len(), 2);
        assert_eq!(hashes[0], hashes[1]);
        let future = FIXTURE.replacen("\"version\":1", "\"version\":999", 1);
        assert!(read_logical(future.as_bytes(), &db, &keys).is_err());
        assert!(read_logical(FIXTURE.lines().next().unwrap().as_bytes(), &db, &keys).is_err());
        let unknown = format!(
            "{}\n{{\"type\":\"unknown\",\"data\":{{}}}}\n",
            FIXTURE.lines().next().unwrap()
        );
        let tx = db.transaction().unwrap();
        assert!(read_logical(unknown.as_bytes(), &tx, &keys).is_err());
        drop(tx);

        let description = "## 查询说明\n\n```sql\nSELECT * FROM demo WHERE id < 10;\n```\n";
        db.execute("UPDATE datasets SET description=?1", [description]).unwrap();
        output.clear();
        write_logical(&db, &keys, &mut *output).unwrap();
        let mut restored = Connection::open_in_memory().unwrap();
        initialize_schema(&restored).unwrap();
        let tx = restored.transaction().unwrap();
        read_logical(output.as_slice(), &tx, &keys).unwrap();
        validate_relations(&tx).unwrap();
        tx.commit().unwrap();
        let actual: String = restored.query_row("SELECT description FROM datasets", [], |r| r.get(0)).unwrap();
        assert_eq!(actual, description);

        // An older vault can be backed up directly before its first UI unlock.
        db.execute("ALTER TABLE datasets DROP COLUMN description", []).unwrap();
        output.clear();
        write_logical(&db, &keys, &mut *output).unwrap();
        let actual: Vec<Value> = std::str::from_utf8(&output).unwrap().lines().skip(1).map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(actual, expected);
    }
}
