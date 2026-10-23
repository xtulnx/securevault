//! Ordinary record interchange. Native schema/data packages remain JSON-only.
use super::*;

#[derive(Deserialize)]
pub(super) struct TextImport {
    text: String,
    format: Option<String>,
    node_path: Option<String>,
}

pub(super) async fn import_text(State(state): State<AppState>, Json(request): Json<TextImport>) -> ApiResult<Json<Value>> {
    let mut result = stage_import(&state, || {
        let (format, records) = parse_text_at(&request.text, request.format.as_deref().unwrap_or("auto"), request.node_path.as_deref().unwrap_or(""))?;
        Ok((format!("粘贴文本.{format}"), records))
    }).await?;
    let format = result.0["filename"].as_str().unwrap().rsplit('.').next().unwrap().to_owned();
    result.0["format"] = json!(format);
    Ok(result)
}

#[cfg(test)]
fn parse_text(text: &str, format: &str) -> ApiResult<(String, Vec<Value>)> { parse_text_at(text, format, "") }

fn parse_text_at(text: &str, format: &str, node_path: &str) -> ApiResult<(String, Vec<Value>)> {
    if text.len() > 1024 * 1024 { return Err(bad_request("粘贴文本最多支持 1 MiB，请缩小批次或使用文件导入")); }
    if text.trim().is_empty() { return Err(bad_request("请先粘贴需要导入的文本")); }
    validate_node_path(node_path)?;
    let format = format.to_ascii_lowercase();
    if !matches!(format.as_str(), "auto" | "json" | "jsonl" | "csv" | "yaml" | "yml" | "toml") {
        return Err(bad_request("文本格式仅支持 JSON、JSONL、CSV、YAML 和 TOML"));
    }
    let validate = |records: Vec<Value>| -> ApiResult<Vec<Value>> {
        if records.is_empty() || records.iter().all(|row| row.as_object().is_none_or(|map| map.is_empty())) {
            return Err(bad_request("未找到可导入的记录和字段，请检查文本内容"));
        }
        if records.len() > 10_000 { return Err(bad_request("每批最多导入 10000 条记录，请拆分文本")); }
        Ok(records)
    };
    if format != "auto" {
        return Ok((format.clone(), validate(parse_tabular_selected(text.as_bytes(), &format!("text.{format}"), node_path, None)?)?));
    }
    // JSON is also valid YAML. Prefer its unambiguous syntax, preserving JSON numbers.
    for candidate in ["json", "jsonl"] {
        if let Ok(records) = parse_at(text.as_bytes(), candidate, node_path).and_then(&validate) {
            return Ok((candidate.into(), records));
        }
    }
    let mut candidates = Vec::new();
    for candidate in ["yaml", "toml", "csv"] {
        if candidate == "csv" {
            // A malformed JSON/JSONL document must never become a CSV batch.
            if text.trim_start_matches('\u{feff}').trim_start().starts_with(['{', '[']) { continue; }
            // Auto mode requires a real header plus consistent, multi-column rows.
            // Single-column CSV remains available via explicit format selection.
            let mut reader = csv::Reader::from_reader(text.as_bytes());
            let headers = match reader.headers() { Ok(headers) if headers.len() > 1 && headers.iter().all(|key| !key.trim().is_empty()) => headers.clone(), _ => continue };
            if headers.iter().collect::<std::collections::BTreeSet<_>>().len() != headers.len() { continue; }
            if reader.records().any(|row| row.is_err()) { continue; }
        }
        if let Ok(records) = parse_tabular_selected(text.as_bytes(), &format!("text.{candidate}"), node_path, None).and_then(&validate) {
            candidates.push((candidate.to_owned(), records));
        }
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err(bad_request(if node_path.is_empty() { "无法识别文本格式，请手动选择格式并检查语法；CSV 需要表头" } else { "未找到可导入的记录节点，请检查路径或手动指定格式；节点必须是非空对象或对象数组" })),
        _ => Err(bad_request(format!("文本可按多种格式解析（{}），请手动选择格式", candidates.iter().map(|(format, _)| format.to_uppercase()).collect::<Vec<_>>().join(" / ")))),
    }
}

#[cfg(test)]
pub(super) fn parse(bytes: &[u8], format: &str) -> ApiResult<Vec<Value>> { parse_at(bytes, format, "") }

// Record selection happens before flattening fields. No expressions or wildcards execute.
fn validate_node_path(path: &str) -> ApiResult<()> {
    if path.len() > 1024 || (!path.is_empty() && path != "$" && !path.starts_with('/') && path.strip_prefix("$.").unwrap_or(path).split('.').any(str::is_empty)) {
        return Err(bad_request("记录节点路径无效：使用点分隔字段、数字下标或 JSON Pointer，最多 1024 字节"));
    }
    if path.starts_with('/') {
        let bytes = path.as_bytes();
        for (i, byte) in bytes.iter().enumerate() {
            if *byte == b'~' && !matches!(bytes.get(i + 1), Some(b'0' | b'1')) { return Err(bad_request("JSON Pointer 转义只支持 ~0 和 ~1")); }
        }
    }
    Ok(())
}

fn select_node(value: &Value, path: &str) -> ApiResult<Vec<Value>> {
    let selected = if path.is_empty() || path == "$" { Some(value) }
        else if path.starts_with('/') { value.pointer(path) }
        else { path.strip_prefix("$.").unwrap_or(path).split('.').try_fold(value, |node, key| {
            if let Some(array) = node.as_array() { key.parse::<usize>().ok().and_then(|i| array.get(i)) } else { node.get(key) }
        }) };
    let selected = selected.ok_or_else(|| bad_request("记录节点不存在，请检查路径；数组下标从 0 开始"))?;
    if !selected.is_object() && !selected.is_array() { return Err(bad_request("记录节点必须是对象或对象数组")); }
    Ok(flatten_sample(selected))
}

pub(super) fn parse_at(bytes: &[u8], format: &str, node_path: &str) -> ApiResult<Vec<Value>> {
    validate_node_path(node_path)?;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| bad_request("导入文件必须使用 UTF-8 编码"))?
        .trim_start_matches('\u{feff}');
    let records = match format {
        "json" => {
            let value = serde_json::from_str(text)
                .map_err(|e| bad_request(format!("invalid JSON: {e}")))?;
            select_node(&value, node_path)?
        }
        "jsonl" => text.lines().enumerate().filter(|(_, line)| !line.trim().is_empty())
            .map(|(line, text)| {
                let record: Value = serde_json::from_str(text)
                    .map_err(|_| bad_request(format!("JSONL 第 {} 行格式无效", line + 1)))?;
                if !record.is_object() {
                    return Err(bad_request(format!("JSONL 第 {} 行必须是对象", line + 1)));
                }
                select_node(&record, node_path)
            }).collect::<ApiResult<Vec<_>>>()?.into_iter().flatten().collect(),
        "yaml" | "yml" => {
            let mut options = serde_saphyr::Options::default();
            options.budget = Some(serde_saphyr::Budget::default());
            options.reject_unsupported_tags = true;
            options.duplicate_keys = serde_saphyr::DuplicateKeyPolicy::Error;
            options.strict_booleans = true;
            options.with_snippet = false;
            let documents: Vec<Value> = serde_saphyr::from_multiple_with_options(text, options)
                .map_err(|_| bad_request("YAML 格式无效或超过解析限制，请检查语法、重复键及字段类型"))?;
            documents.iter().map(|document| select_node(document, node_path)).collect::<ApiResult<Vec<_>>>()?.into_iter().flatten().collect()
        }
        "toml" => {
            let value: toml::Value = toml::from_str(text)
                .map_err(|_| bad_request("TOML 格式无效，请检查语法及重复键"))?;
            let mut value = toml_to_json(value)?;
            // A root array is not valid TOML. Exports use a records array of tables.
            if node_path.is_empty() && value.as_object().is_some_and(|map| map.len() == 1 && map.get("records").is_some_and(Value::is_array)) {
                value = value.get_mut("records").unwrap().take();
            }
            select_node(&value, node_path)?
        }
        _ => return Err(bad_request("unsupported record format")),
    };
    if records.len() > 10_000 {
        return Err(bad_request("import capacity exceeded (10000 rows per batch)"));
    }
    if records.iter().any(|record| !record.is_object()) {
        return Err(bad_request("导入数据必须是对象或对象数组"));
    }
    if records.iter().any(|record| record.get("format").and_then(Value::as_str) == Some("securevault-dataset") && record.get("schema").is_some()) {
        return Err(bad_request("这是原生数据集包，请使用 JSON 文件或选择 JSON 文本格式导入结构与数据"));
    }
    records.into_iter().map(|record| {
        let mut flattened = Vec::new();
        flatten_fields(&record, "", &mut flattened);
        let mut fields = serde_json::Map::new();
        for (key, value) in flattened {
            if fields.insert(key, value).is_some() {
                return Err(bad_request("嵌套字段展开后出现重名，请调整点分隔字段名后重新导入"));
            }
        }
        Ok(Value::Object(fields))
    }).collect()
}

fn toml_to_json(value: toml::Value) -> ApiResult<Value> {
    Ok(match value {
        toml::Value::String(value) => Value::String(value),
        toml::Value::Integer(value) => json!(value),
        toml::Value::Float(value) => Value::Number(serde_json::Number::from_f64(value)
            .ok_or_else(|| bad_request("TOML 不支持导入 nan / inf 非有限数值"))?),
        toml::Value::Boolean(value) => Value::Bool(value),
        // Preserve dates as strings, rather than Serde's internal datetime object.
        toml::Value::Datetime(value) => Value::String(value.to_string()),
        toml::Value::Array(values) => Value::Array(values.into_iter().map(toml_to_json).collect::<ApiResult<_>>()?),
        toml::Value::Table(values) => Value::Object(values.into_iter()
            .map(|(key, value)| Ok((key, toml_to_json(value)?))).collect::<ApiResult<_>>()?),
    })
}

fn json_to_toml(value: &Value) -> ApiResult<toml::Value> {
    Ok(match value {
        Value::Null => return Err(bad_request("TOML 无法表示 null，请选择 JSON、JSONL 或 YAML 导出")),
        Value::Bool(value) => toml::Value::Boolean(*value),
        Value::String(value) => toml::Value::String(value.clone()),
        Value::Number(value) => {
            if value.is_f64() { toml::Value::Float(value.as_f64().unwrap()) }
            else { toml::Value::Integer(value.as_i64().ok_or_else(|| bad_request("TOML 整数超出 64 位有符号范围，请选择 JSON、JSONL 或 YAML 导出"))?) }
        }
        Value::Array(values) => toml::Value::Array(values.iter().map(json_to_toml).collect::<ApiResult<_>>()?),
        Value::Object(values) => toml::Value::Table(values.iter()
            .map(|(key, value)| Ok((key.clone(), json_to_toml(value)?))).collect::<ApiResult<_>>()?),
    })
}

pub(super) fn export(records: &[Value], format: &str) -> ApiResult<(&'static str, Vec<u8>)> {
    match format {
        "json" => Ok(("application/json", serde_json::to_vec_pretty(records).map_err(internal)?)),
        "jsonl" => {
            let mut bytes = Vec::new();
            for record in records {
                serde_json::to_writer(&mut bytes, record).map_err(internal)?;
                bytes.push(b'\n');
            }
            Ok(("application/x-ndjson; charset=utf-8", bytes))
        }
        "yaml" | "yml" => Ok(("application/yaml; charset=utf-8", serde_saphyr::to_string(&records).map_err(internal)?.into_bytes())),
        "toml" => {
            let value = json_to_toml(&json!({"records": records}))?;
            Ok(("application/toml; charset=utf-8", toml::to_string_pretty(&value).map_err(internal)?.into_bytes()))
        }
        _ => Err(bad_request("unsupported record format")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_nested_records_before_flattening_and_preserves_array_fields() {
        let toml = r#"[[private_key.keys]]
id="KEY-TEST"
#invalid = true
issuer_id="issuer-test"
private_key="""-----BEGIN PRIVATE KEY-----
TEST-ONLY
-----END PRIVATE KEY-----
"""
artistName="示例"
bundle_ids=["com.example.one", "com.example.two"]
[[private_key.keys]]
id="SECOND"
bundle_ids=[]
"#;
        let expected = parse_at(toml.as_bytes(), "toml", "private_key.keys").unwrap();
        assert_eq!(expected.len(), 2);
        assert_eq!(expected[0]["bundle_ids"], json!(["com.example.one", "com.example.two"]));
        assert_eq!(expected[1]["bundle_ids"], json!([]));
        assert!(expected[0].get("invalid").is_none());
        assert!(expected[0]["private_key"].as_str().unwrap().contains("\nTEST-ONLY\n"));
        for path in ["private_key.keys", "$.private_key.keys", "/private_key/keys"] {
            assert_eq!(parse_text_at(toml, "auto", path).unwrap(), ("toml".into(), expected.clone()));
        }
        assert_eq!(parse_at(toml.as_bytes(), "toml", "private_key.keys.0").unwrap(), expected[..1]);
        for path in ["missing", "private_key.keys.0.id", "private_key..keys", "/private_key/~2", "private_key.keys.9", "private_key.keys.0.bundle_ids"] {
            assert!(parse_at(toml.as_bytes(), "toml", path).is_err(), "{path}");
        }
        let yaml = "private_key:\n  keys:\n    - id: KEY-TEST\n      bundle_ids: [com.example.one, com.example.two]\n---\nprivate_key:\n  keys:\n    - id: SECOND\n      bundle_ids: []";
        let records = parse_text_at(yaml, "yaml", "private_key.keys").unwrap().1;
        assert_eq!(records.len(), 2); assert_eq!(records[0]["bundle_ids"], expected[0]["bundle_ids"]);
        assert!(parse_text_at("private_key: {}\n---\nother: []", "yaml", "private_key").is_err());
        assert_eq!(parse_at(br#"{"a.b":{"c/d":[{"id":1}]}}"#, "json", "/a.b/c~1d").unwrap(), vec![json!({"id":1})]);
        assert!(parse_tabular_selected(b"id\n1", "data.csv", "items", None).is_err());
        assert!(parse_text_at("{\"items\":[]}", "json", "items").is_err());
    }

    #[test]
    fn spreadsheets_require_explicit_choice_and_validate_the_selected_sheet() {
        let mut workbook = rust_xlsxwriter::Workbook::new();
        workbook.add_worksheet().set_name("说明").unwrap().write_string(0, 0, "只作说明").unwrap();
        let sheet = workbook.add_worksheet(); sheet.set_name("数据 & <2>").unwrap();
        sheet.write_string(0, 0, "id").unwrap(); sheet.write_string(0, 1, "bundle_ids").unwrap();
        sheet.write_string(1, 0, "KEY").unwrap(); sheet.write_string(1, 1, r#"["com.example.one","com.example.two"]"#).unwrap();
        workbook.add_worksheet().set_name("空表").unwrap();
        let bytes = workbook.save_to_buffer().unwrap();
        assert!(parse_tabular(&bytes, "data.xlsx").unwrap_err().1.contains("多个工作表"));
        assert_eq!(parse_tabular_selected(&bytes, "data.xlsx", "", Some("数据 & <2>")).unwrap(), vec![json!({"id":"KEY","bundle_ids":["com.example.one","com.example.two"]})]);
        for name in ["空表", "不存在"] { assert!(parse_tabular_selected(&bytes, "data.xlsx", "", Some(name)).is_err()); }
    }

    #[test]
    fn malformed_tables_and_colliding_fields_never_silently_drop_values() {
        for input in ["code,code\n001,002", "code,\n001,Alice", "code,name\n001,Alice,extra", "code,name\n001"] {
            assert!(parse_tabular(input.as_bytes(), "bad.csv").is_err(), "{input}");
        }
        assert!(parse_text("{\"code\":\"001\",\"name\":\"one\"}\n{\"code\":\"002\",\"name\":}", "auto").is_err());
        for (format, input) in [
            ("json", "{\"a.b\":1,\"a\":{\"b\":2}}"),
            ("yaml", "a.b: 1\na:\n  b: 2"),
            ("toml", "'a.b'=1\n[a]\nb=2"),
        ] { assert!(parse(input.as_bytes(), format).unwrap_err().1.contains("重名")); }
        let mut workbook = rust_xlsxwriter::Workbook::new();
        let sheet = workbook.add_worksheet();
        sheet.write_string(0, 0, "code").unwrap(); sheet.write_string(0, 1, "code").unwrap();
        sheet.write_string(1, 0, "001").unwrap(); sheet.write_string(1, 1, "002").unwrap();
        assert!(parse_tabular(&workbook.save_to_buffer().unwrap(), "bad.xlsx").is_err());
        let package = br#"{"format":"securevault-dataset","schema":{"fields":[]},"version":1}"#;
        assert!(parse(package, "json").unwrap_err().1.contains("原生数据集包"));
    }

    #[test]
    fn text_auto_detection_and_explicit_formats_are_bounded_and_require_records() {
        for (text, expected) in [
            ("[{\"code\":\"001\"}]", "json"),
            ("{\"code\":\"001\"}\n{\"code\":\"002\"}", "jsonl"),
            ("- code: '001'", "yaml"),
            ("[[records]]\ncode='001'", "toml"),
            ("code,name\n001,Alice", "csv"),
        ] {
            let (format, rows) = parse_text(text, "auto").unwrap();
            assert_eq!(format, expected);
            assert_eq!(rows[0]["code"], "001");
        }
        assert_eq!(parse_text("code\n001", "csv").unwrap().1, vec![json!({"code":"001"})]);
        assert!(parse_text("code\n001", "auto").is_err());
        assert!(parse_text("a: b,c\nx: y,z", "auto").unwrap_err().1.contains("多种格式"));
        assert!(parse_text("a: b,c\nx: y,z", "yaml").is_ok());
        for (text, format) in [("  ", "auto"), ("[]", "json"), ("{}", "json"), ("[{}]", "json"), ("key", "csv"), ("hello", "xlsx"), ("not json", "json")] {
            assert!(parse_text(text, format).is_err(), "{format}: {text}");
        }
        assert!(parse_text(&"x".repeat(1024 * 1024 + 1), "json").unwrap_err().1.contains("1 MiB"));
        assert!(parse_text(&"- code: 1\n".repeat(10_001), "yaml").is_err());
    }

    #[tokio::test]
    async fn export_and_upload_preserve_types_secret_selection_and_download_headers() {
        use tower::ServiceExt;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("record-formats-{}", Uuid::new_v4()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(directory.clone());
        private_dir(&directory).unwrap();
        let state = rotation::state_for(directory);
        let (keys, _) = initialize_vault(&state, "format-test-password-123").unwrap();
        activate(&state, keys, true).await;
        let request = serde_json::from_value(json!({
            "category_path":"格式/测试", "fields":[
                {"source_key":"code","zone":"indexes"},
                {"source_key":"enabled","zone":"display"},
                {"source_key":"secret","zone":"secrets"}
            ], "sample_data":[{"code":"001","enabled":false,"secret":"test-secret"}]
        })).unwrap();
        let created = create_dataset(State(state.clone()), Json(request)).await.unwrap().0;
        let dataset = created["dataset_id"].as_str().unwrap().to_owned();
        let mut headers = HeaderMap::new();
        headers.insert("x-vault-owner", HeaderValue::from_static("true"));
        let router = Router::new().route("/upload", post(upload_import)).with_state(state.clone());
        for records in [vec![], vec![json!({})]] {
            assert!(stage_import(&state, || Ok(("empty.json".into(), records))).await.is_err());
        }
        let parsed = import_text(State(state.clone()), Json(TextImport { text: "- code: '002'".into(), format: None, node_path: None })).await.unwrap().0;
        assert_eq!(parsed["format"], "yaml");
        assert_eq!(parsed["record_count"], 1);
        assert_eq!(state.batches.lock().await[parsed["batch_id"].as_str().unwrap()].records, vec![json!({"code":"002"})]);
        with_connection(&state, |db, _| {
            assert_eq!(db.query_row("SELECT COUNT(*) FROM records", [], |row| row.get::<_, i64>(0)).unwrap(), 1, "parsing must not commit records");
            Ok(())
        }).await.unwrap();
        for (format, mime) in [("jsonl", "application/x-ndjson"), ("yaml", "application/yaml"), ("yml", "application/yaml"), ("toml", "application/toml")] {
            for include_secrets in [false, true] {
                let query = serde_json::from_value(json!({"format":format,"include_secrets":include_secrets})).unwrap();
                let response = export_dataset(State(state.clone()), Path(dataset.clone()), Query(query), headers.clone()).await.unwrap();
                assert!(response.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with(mime));
                assert_eq!(response.headers()[header::CONTENT_DISPOSITION], format!("attachment; filename=\"securevault-{dataset}.{format}\""));
                let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let mut expected = json!({"code":"001","enabled":false});
                if include_secrets { expected["secret"] = json!("test-secret"); }
                assert_eq!(parse(&bytes, format).unwrap(), vec![expected.clone()]);
                let body = format!("--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"records.{format}\"\r\nContent-Type: {mime}\r\n\r\n{}\r\n--boundary--\r\n", std::str::from_utf8(&bytes).unwrap());
                let response = router.clone().oneshot(Request::builder().method("POST").uri("/upload")
                    .header(header::CONTENT_TYPE, "multipart/form-data; boundary=boundary")
                    .body(axum::body::Body::from(body)).unwrap()).await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let batch: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(batch["record_count"], 1);
                let batches = state.batches.lock().await;
                assert_eq!(batches[batch["batch_id"].as_str().unwrap()].records, vec![expected]);
            }
        }
    }

    #[test]
    fn structured_formats_round_trip_record_types_and_empty_datasets() {
        let records = vec![json!({
            "code": "001", "中文": "第一行\n第二行", "enabled": false, "count": 0,
            "float": 1.25, "long_id": 9007199254740993i64, "empty": "", "empty_object": {},
            "tags": ["a", "b"], "mixed": [1, "two", false], "objects": [{"key": "value"}],
            "quoted.key": "literal", "bool_string": "true", "date_string": "2026-10-23",
            "yes_string": "yes", "null_string": "null"
        }), json!({"code": "002", "tags": [], "count": -1})];
        for format in ["json", "jsonl", "yaml", "yml", "toml"] {
            let (_, bytes) = export(&records, format).unwrap();
            assert_eq!(parse_tabular(&bytes, &format!("records.{}", format.to_uppercase())).unwrap(), records, "{format}");
            let (_, empty) = export(&[], format).unwrap();
            assert!(parse(&empty, format).unwrap().is_empty(), "{format}");
        }
    }

    #[test]
    fn yaml_supports_documents_aliases_and_the_existing_nested_field_mapping() {
        let input = "---\ncode: '001'\nconfig: &config\n  enabled: false\ncopy: *config\n---\n- code: '002'\n  count: 0\n";
        assert_eq!(parse(input.as_bytes(), "yaml").unwrap(), vec![
            json!({"code":"001","config.enabled":false,"copy.enabled":false}),
            json!({"code":"002","count":0})
        ]);
        assert_eq!(parse("\u{feff}- code: '001'".as_bytes(), "yml").unwrap(), vec![json!({"code":"001"})]);
        for format in ["json", "jsonl", "yaml", "yml"] {
            let records = vec![json!({"value":null, "array":[null], "large":u64::MAX})];
            let (_, bytes) = export(&records, format).unwrap();
            assert_eq!(parse(&bytes, format).unwrap(), records);
        }
    }

    #[test]
    fn toml_supports_root_tables_nested_tables_dates_and_record_arrays() {
        let input = "code = '001'\ndate = 2026-10-23\ntime = 12:34:56\nstamp = 2026-10-23T12:34:56Z\n[config]\nenabled = false\n";
        assert_eq!(parse(input.as_bytes(), "toml").unwrap(), vec![json!({
            "code":"001", "date":"2026-10-23", "time":"12:34:56",
            "stamp":"2026-10-23T12:34:56Z", "config.enabled":false
        })]);
        assert_eq!(parse(b"[[records]]\ncode='001'\n[records.config]\ncount=0\n[[records]]\ncode='002'", "toml").unwrap(), vec![
            json!({"code":"001","config.count":0}), json!({"code":"002"})
        ]);
        // A business field named records is only a container when it is the sole root key.
        assert_eq!(parse(b"code='001'\nrecords=[1, 2]", "toml").unwrap(), vec![json!({"code":"001","records":[1,2]})]);
        for record in [json!({"x":null}), json!({"x":[null]}), json!({"x":{"y":null}}), json!({"x":u64::MAX})] {
            let error = export(&[record], "toml").unwrap_err();
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
            assert!(error.1.contains("JSON"));
        }
    }

    #[test]
    fn rejects_invalid_shapes_syntax_nonfinite_values_and_unsafe_yaml() {
        for (format, input) in [
            ("yaml", "- 1\n- 2"), ("yaml", "scalar"), ("yaml", "key: ["),
            ("yaml", "key: one\nkey: two"), ("yaml", "key: .nan"), ("yaml", "key: .inf"),
            ("yaml", "key: !include /etc/passwd"), ("yaml", "key: !custom value"),
            ("yaml", "key: &loop [*loop]"), ("yaml", "? [a, b]\n: value"),
            ("toml", "key = ["), ("toml", "key = 1\nkey = 2"),
            ("toml", "key = nan"), ("toml", "key = inf"), ("toml", "records=[1]"),
            ("jsonl", "{\"code\":1}\n[2]"), ("jsonl", "{\"code\":1}\n{"),
        ] {
            assert!(parse(input.as_bytes(), format).is_err(), "{format}: {input}");
        }
        assert!(parse(&[0xff], "yaml").is_err());
        let nested = format!("key: {}0{}", "[".repeat(300), "]".repeat(300));
        assert!(parse(nested.as_bytes(), "yaml").is_err());
        let too_many = "- code: 1\n".repeat(10_001);
        assert!(parse(too_many.as_bytes(), "yaml").is_err());
        let error = parse(b"{\"code\":1}\n\nfalse", "jsonl").unwrap_err();
        assert!(error.1.contains("第 3 行"));
        assert_eq!(parse(b"\n{\"code\":1}\r\n\n{\"code\":2}\n", "jsonl").unwrap(), vec![json!({"code":1}),json!({"code":2})]);
    }
}
