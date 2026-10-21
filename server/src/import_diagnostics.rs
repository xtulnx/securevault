//! Read-only import diagnostics. Reports contain coordinates and reasons, never record values.
use super::*;
use std::collections::HashSet;

const ISSUE_LIMIT: usize = 10_000;
#[derive(Serialize)]
pub(super) struct Issue {
    scope: String,
    row: usize,
    severity: String,
    source_key: String,
    target_key: String,
    json_path: String,
    code: String,
    message: String,
}
#[derive(Serialize)]
pub(super) struct Report {
    pub error_count: usize,
    pub warning_count: usize,
    pub checked_rows: usize,
    pub issues: Vec<Issue>,
    pub truncated: bool,
    pub issue_limit: usize,
}
impl Report {
    pub fn new(rows: usize) -> Self { Self { error_count: 0, warning_count: 0, checked_rows: rows, issues: vec![], truncated: false, issue_limit: ISSUE_LIMIT } }
    pub fn add(&mut self, scope: &str, row: usize, error: bool, source: &str, target: &str, path: &str, code: &str, message: &str) {
        if error { self.error_count += 1; } else { self.warning_count += 1; }
        if self.issues.len() < ISSUE_LIMIT {
            self.issues.push(Issue { scope: scope.into(), row, severity: if error { "error" } else { "warning" }.into(), source_key: source.into(), target_key: target.into(), json_path: path.into(), code: code.into(), message: message.into() });
        } else { self.truncated = true; }
    }
    pub fn response(&self, format: Option<&str>) -> ApiResult<Response> {
        let mut response = match format.unwrap_or("json") {
            "json" => Json(self).into_response(),
            "csv" => {
                let mut writer = csv::Writer::from_writer(Vec::new());
                writer.write_record(["scope", "row", "severity", "source_key", "target_key", "json_path", "code", "message"]).map_err(internal)?;
                for item in &self.issues {
                    writer.write_record([item.scope.clone(), item.row.to_string(), item.severity.clone(), item.source_key.clone(), item.target_key.clone(), item.json_path.clone(), item.code.clone(), item.message.clone()].iter().map(|v| csv_safe(v))).map_err(internal)?;
                }
                // Metadata remains in the downloaded report even when the retained issue list is capped.
                writer.write_record(["summary".to_owned(), self.checked_rows.to_string(), format!("errors={};warnings={};truncated={}", self.error_count, self.warning_count, self.truncated), String::new(), String::new(), String::new(), String::new(), format!("issue_limit={ISSUE_LIMIT}")]).map_err(internal)?;
                let mut bytes = vec![0xef, 0xbb, 0xbf]; bytes.extend(writer.into_inner().map_err(internal)?);
                ([(header::CONTENT_TYPE, "text/csv; charset=utf-8"), (header::CONTENT_DISPOSITION, "attachment; filename=\"securevault-import-report.csv\"")], bytes).into_response()
            }
            _ => return Err(bad_request("报告格式仅支持 json 或 csv")),
        };
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    }
}

// Dot-separated object keys; decimal segments index arrays. This is deliberately not full JSONPath.
pub(super) fn validate_path(path: &str) -> ApiResult<()> {
    if path.len() > 1024 || (!path.is_empty() && path.trim_matches('.').split('.').any(|p| p.is_empty())) {
        return Err(bad_request("路径最多 1024 字节，使用点分隔字段或数组下标，不能有空段"));
    }
    Ok(())
}
pub(super) fn extract(input: &Value, source: &str, path: Option<&str>) -> Result<Value, &'static str> {
    let Some(mut value) = input.get(source).cloned() else { return Err("source_missing"); };
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        if let Value::String(text) = value { value = serde_json::from_str(&text).map_err(|_| "invalid_json")?; }
        for segment in path.trim_matches('.').split('.') {
            value = if let Value::Array(items) = &value {
                segment.parse::<usize>().ok().and_then(|i| items.get(i)).cloned()
            } else { value.get(segment).cloned() }.ok_or("path_missing")?;
        }
    }
    if value.is_null() { Err("matched_null") } else { Ok(value) }
}
fn reason(code: &str) -> &'static str {
    match code {
        "source_missing" => "缺少源字段，不写入此字段；更新匹配记录时会清除旧值",
        "invalid_json" => "源字段不是有效 JSON，无法按路径抽取",
        "path_missing" => "路径未命中，不写入此字段；更新匹配记录时会清除旧值",
        "matched_null" => "结果为 null，不写入此字段；更新匹配记录时会清除旧值",
        _ => "抽取成功",
    }
}
fn validate_mappings(mappings: &[FieldMapping]) -> ApiResult<()> {
    if mappings.len() > 256 { return Err(bad_request("单批最多 256 个字段映射")); }
    let mut targets = HashSet::new();
    for m in mappings {
        if m.source_key.is_empty() || m.target_key.is_empty() || m.source_key.len() > 1024 || m.target_key.len() > 1024 || !targets.insert(&m.target_key) {
            return Err(bad_request("映射字段不能为空、超过 1024 字节或重复写入同一目标字段"));
        }
        validate_path(m.json_path.as_deref().unwrap_or(""))?;
    }
    Ok(())
}
pub(super) fn map_and_report(inputs: &[Value], request: &ImportRequest, identity: &[String]) -> ApiResult<(Vec<Value>, Report)> {
    validate_mappings(&request.mappings)?;
    let mut report = Report::new(inputs.len());
    let mut output = Vec::with_capacity(inputs.len());
    let mut identities = HashSet::new();
    for (index, input) in inputs.iter().enumerate() {
        let mut record = if request.mappings.is_empty() { input.clone() } else { json!({}) };
        for m in &request.mappings {
            match extract(input, &m.source_key, m.json_path.as_deref()) {
                Ok(value) => { record[&m.target_key] = value; }
                Err(code) => report.add("records", index + 1, code == "invalid_json", &m.source_key, &m.target_key, m.json_path.as_deref().unwrap_or(""), code, reason(code)),
            }
        }
        if !identity.is_empty() {
            if let Some(hash) = identity_hash(&[0; 32], "import-diagnostics", identity, &record) {
                if !identities.insert(hash) {
                    report.add("records", index + 1, false, "", &identity.join(","), "", "duplicate_key", "批次内逻辑 KEY 重复，将按所选策略更新或跳过");
                }
            } else {
                report.add("records", index + 1, request.delete_missing, "", &identity.join(","), "", "incomplete_key", if request.delete_missing { "删除缺失记录要求每条记录具有完整逻辑 KEY" } else { "逻辑 KEY 不完整，将新增记录，无法用于更新或跳过匹配" });
            }
        }
        output.push(record);
    }
    Ok((output, report))
}

// Lock in the same order as upload. A seal cannot invalidate and then resurrect a cloned batch.
async fn with_batch<T>(state: &AppState, id: &str, operation: impl FnOnce(&[Value], &KeySet) -> ApiResult<T>) -> ApiResult<T> {
    let mut runtime = state.runtime.lock().await;
    expire_runtime(&mut runtime);
    let keys = runtime.keys.as_ref().ok_or_else(locked)?;
    let batches = state.batches.lock().await;
    let batch = batches.get(id).filter(|batch| batch.session_id == runtime.session_id && batch.created.elapsed() < Duration::from_secs(3600))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "导入批次已过期或被替换，请重新上传".into()))?;
    operation(&batch.records, keys)
}
fn scan(db: &Connection, inputs: &[Value], request: &ImportRequest) -> ApiResult<(Vec<Value>, Report)> {
    let raw: String = db.query_row("SELECT identity_fields_json FROM datasets WHERE id=?1", [&request.dataset_id], |r| r.get(0)).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "目标数据集不存在".into()))?;
    let identity = if request.evolved_fields.is_empty() { serde_json::from_str(&raw).map_err(internal)? } else { request.evolved_identity_fields.clone() };
    map_and_report(inputs, request, &identity)
}
pub(super) async fn run(state: AppState, request: ImportRequest, preview: bool) -> ApiResult<Json<Value>> {
    with_batch(&state, &request.batch_id, |inputs, keys| {
        let db = open_database(&database_path(&state), &keys.db)?;
        let (mapped, report) = scan(&db, inputs, &request)?;
        if report.error_count > 0 {
            if preview { return Ok(Json(json!({"valid":false,"diagnostics":report}))); }
            return Err(bad_request(format!("导入包含 {} 项错误，请先预检并下载错误报告；未写入任何记录", report.error_count)));
        }
        let tx = db.unchecked_transaction().map_err(internal)?;
        let mut result = import_records_in_connection(&tx, keys, &request, &mapped)?;
        if preview { tx.rollback().map_err(internal)?; } else { tx.commit().map_err(internal)?; }
        result["diagnostics"] = serde_json::to_value(report).map_err(internal)?;
        result["valid"] = json!(true);
        Ok(Json(result))
    }).await
}
#[derive(Deserialize)]
pub(super) struct Format { pub format: Option<String> }
pub(super) async fn report(State(state): State<AppState>, Query(format): Query<Format>, Json(request): Json<ImportRequest>) -> ApiResult<Response> {
    with_batch(&state, &request.batch_id, |inputs, keys| {
        let db = open_database(&database_path(&state), &keys.db)?;
        scan(&db, inputs, &request)?.1.response(format.format.as_deref())
    }).await
}
#[derive(Deserialize)]
pub(super) struct SampleRequest { source_key: String, #[serde(default)] json_path: Option<String>, #[serde(default)] reveal: bool }
fn sample_value(value: Option<&Value>, reveal: bool) -> Value {
    let Some(value) = value else { return json!({"present":false}); };
    let kind = match value { Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number", Value::String(_) => "string", Value::Array(_) => "array", Value::Object(_) => "object" };
    if !reveal { return json!({"present":true,"type":kind,"masked":true}); }
    let text = if let Some(text) = value.as_str() { text.to_owned() } else { value.to_string() };
    json!({"present":true,"type":kind,"masked":false,"text":text.chars().take(2048).collect::<String>(),"truncated":text.chars().count()>2048})
}
pub(super) async fn samples(State(state): State<AppState>, Path(id): Path<String>, Json(request): Json<SampleRequest>) -> ApiResult<Response> {
    validate_path(request.json_path.as_deref().unwrap_or(""))?;
    if request.source_key.is_empty() || request.source_key.len() > 1024 { return Err(bad_request("源字段无效")); }
    with_batch(&state, &id, |inputs, keys| {
        if request.reveal {
            let db = open_database(&database_path(&state), &keys.db)?;
            db.execute("INSERT INTO audit_events(event,field_name) VALUES('import_samples_reveal',?1)", [&request.source_key]).map_err(internal)?;
        }
        let rows: Vec<Value> = inputs.iter().take(3).enumerate().map(|(i, input)| {
            let result = extract(input, &request.source_key, request.json_path.as_deref());
            let code = result.as_ref().err().copied().unwrap_or("matched");
            json!({"row":i+1,"status":code,"message":reason(code),"before":sample_value(input.get(&request.source_key),request.reveal),"after":sample_value(result.as_ref().ok().or_else(|| if code=="matched_null" { Some(&Value::Null) } else { None }),request.reveal)})
        }).collect();
        let mut response = Json(json!({"rows":rows,"sample_limit":3,"record_count":inputs.len(),"revealed":request.reveal,"expires_in_seconds":if request.reveal {30} else {0}})).into_response();
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(batch: &str) -> ImportRequest {
        serde_json::from_value(json!({"dataset_id":"test","batch_id":batch,"mappings":[{"source_key":"payload","target_key":"key","json_path":"items.0.id"}]})).unwrap()
    }
    #[test]
    fn extraction_matches_write_semantics_for_falsy_null_and_arrays() {
        for value in [json!(0), json!(false), json!("")] {
            let input = json!({"payload":json!({"items":[{"id":value}]}).to_string()});
            assert_eq!(extract(&input,"payload",Some(".items.0.id.")), Ok(value.clone()));
            let (mapped, report) = map_and_report(&[input], &request("b"), &["key".into()]).unwrap();
            assert_eq!(mapped[0]["key"], value); assert_eq!(report.warning_count, 0);
        }
        for (input, path, code) in [(json!({}), "id", "source_missing"), (json!({"payload":"SYNTHETIC-SECRET"}), "id", "invalid_json"), (json!({"payload":{}}), "id", "path_missing"), (json!({"payload":{"id":null}}), "id", "matched_null")] {
            assert_eq!(extract(&input,"payload",Some(path)),Err(code));
        }
        assert!(validate_path("items..id").is_err()); assert!(validate_path("...").is_err());
    }
    #[test]
    fn scan_collects_errors_warnings_duplicate_keys_and_caps_only_retained_details() {
        let mut req = request("b");
        let rows = vec![json!({"payload":"SYNTHETIC-SECRET"}),json!({"payload":"invalid two"}),json!({}),json!({"payload":{"items":[{"id":false}]}}),json!({"payload":{"items":[{"id":false}]}})];
        let (_, report) = map_and_report(&rows, &req, &["key".into()]).unwrap();
        assert_eq!(report.error_count, 2); assert_eq!(report.checked_rows, 5); assert_eq!(report.warning_count, 5);
        assert!(!serde_json::to_string(&report).unwrap().contains("SYNTHETIC-SECRET"));
        req.delete_missing = true;
        assert_eq!(map_and_report(&rows,&req,&["key".into()]).unwrap().1.error_count, 5);
        let mut capped = Report::new(10000);
        for i in 0..10002 { capped.add("records",i,true,"x","y","","invalid_json","invalid JSON"); }
        assert_eq!(capped.error_count,10002); assert_eq!(capped.issues.len(),10000); assert!(capped.truncated);
        req.mappings.push(FieldMapping { source_key:"other".into(),target_key:"key".into(),json_path:None });
        assert!(map_and_report(&rows,&req,&[]).is_err());
    }
    #[tokio::test]
    async fn csv_is_formula_safe_and_contains_summary_not_record_values() {
        let mut report = Report::new(2); report.add("records",2,true,"=CMD()","+x","@path","invalid_json","无法抽取");
        let response = report.response(Some("csv")).unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let text = String::from_utf8(axum::body::to_bytes(response.into_body(), 100000).await.unwrap().to_vec()).unwrap();
        assert!(text.starts_with('\u{feff}')); assert!(text.contains("'=CMD()")); assert!(text.contains("'+x")); assert!(text.contains("'@path")); assert!(text.contains("errors=1;warnings=0;truncated=false"));
        assert!(report.response(Some("html")).is_err());
    }
    #[test]
    fn sample_values_are_masked_by_default_and_unicode_truncation_is_bounded() {
        let value = json!("🔐".repeat(3000));
        let masked = sample_value(Some(&value),false);
        assert!(masked.get("text").is_none()); assert_eq!(masked["masked"],true);
        let revealed = sample_value(Some(&value),true);
        assert_eq!(revealed["text"].as_str().unwrap().chars().count(),2048); assert_eq!(revealed["truncated"],true);
        assert_eq!(sample_value(None,true)["present"],false);
    }
    #[tokio::test]
    async fn preview_and_reports_never_write_commit_rechecks_and_batches_expire_and_seal() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("samples/.build"); fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("import-diagnostics-{}",Uuid::new_v4()));
        struct Cleanup(PathBuf); impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(directory.clone()); private_dir(&directory).unwrap();
        let state = rotation::state_for(directory); let (keys,_) = initialize_vault(&state,"import-test-password-2026").unwrap(); activate(&state,keys,true).await;
        let dataset = create_dataset(State(state.clone()),Json(serde_json::from_value(json!({"category_path":"导入/诊断","fields":[{"source_key":"key","zone":"indexes"}],"identity_fields":["key"],"sample_data":[{"key":"old"}]})).unwrap())).await.unwrap().0["dataset_id"].as_str().unwrap().to_owned();
        let mut req = request("batch"); req.dataset_id=dataset;
        let rows = vec![json!({"payload":"invalid one"}),json!({"payload":"invalid two"})];
        state.batches.lock().await.insert("batch".into(),ImportBatch::new(rows, None));
        let body = serde_json::to_value(&req).unwrap();
        let req_for = || serde_json::from_value::<ImportRequest>(body.clone()).unwrap();
        let preview = run(state.clone(),req_for(),true).await.unwrap().0;
        assert_eq!(preview["valid"],false); assert_eq!(preview["diagnostics"]["error_count"],2);
        assert!(run(state.clone(),req_for(),false).await.is_err());
        let report_response = report(State(state.clone()),Query(Format{format:None}),Json(req_for())).await.unwrap();
        assert_eq!(report_response.status(),StatusCode::OK);
        with_connection(&state,|db,_| { assert_eq!(db.query_row("SELECT COUNT(*) FROM records",[],|r|r.get::<_,i64>(0)).unwrap(),1); Ok(()) }).await.unwrap();
        state.batches.lock().await.insert("batch".into(),ImportBatch::new(vec![json!({"payload":{"items":[{"id":0}]}})], None));
        assert_eq!(run(state.clone(),req_for(),true).await.unwrap().0["imported"],1);
        with_connection(&state,|db,_| { assert_eq!(db.query_row("SELECT COUNT(*) FROM records",[],|r|r.get::<_,i64>(0)).unwrap(),1); Ok(()) }).await.unwrap();
        assert_eq!(run(state.clone(),req_for(),false).await.unwrap().0["imported"],1);
        state.batches.lock().await.insert("batch".into(),ImportBatch { created: Instant::now()-Duration::from_secs(3601), session_id: None, records:vec![] });
        assert_eq!(run(state.clone(),req_for(),true).await.unwrap_err().0,StatusCode::NOT_FOUND);
        state.batches.lock().await.insert("batch".into(),ImportBatch::new(vec![],None));
        state.runtime.lock().await.session_id = Some("new-owner-session".into());
        assert_eq!(run(state.clone(),req_for(),true).await.unwrap_err().0,StatusCode::NOT_FOUND);
        let _ = vault_seal(State(state.clone())).await;
        assert_eq!(run(state,req_for(),true).await.unwrap_err().0,StatusCode::LOCKED);
    }
}
