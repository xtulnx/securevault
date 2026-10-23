//! Read-only import diagnostics. Reports contain coordinates and reasons, never record values.
use super::*;
use std::collections::HashSet;

const ISSUE_LIMIT: usize = 10_000;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NewDataset {
    category_path: String,
    #[serde(default)] name: String,
    schema_name: String,
    #[serde(default)] schema_description: String,
    #[serde(default)] description: String,
    #[serde(default)] environment_names: Vec<String>,
}

fn prepare_target(db: &Connection, keys: &KeySet, request: &mut ImportRequest) -> ApiResult<Option<Value>> {
    let Some(target) = request.new_dataset.take() else { return Ok(None); };
    if !request.dataset_id.is_empty() || request.delete_missing || request.skip_existing {
        return Err(bad_request("新建导入不能同时指定已有数据集、跳过已有记录或删除缺失记录"));
    }
    let schema_name = target.schema_name.trim();
    if schema_name.is_empty() || schema_name.chars().count() > 120 || schema_name.chars().any(char::is_control) {
        return Err(bad_request("请填写 1 至 120 个字符的数据模型名称"));
    }
    if request.evolved_fields.is_empty() { return Err(bad_request("请根据导入数据定义至少一个模型字段")); }
    let create: DatasetCreateRequest = serde_json::from_value(json!({
        "category_path":target.category_path,"name":target.name,"description":target.description,
        "environment_names":target.environment_names,"fields":request.evolved_fields,"identity_fields":request.evolved_identity_fields
    })).map_err(internal)?;
    let result = create_dataset_in_connection(db, keys, create)?;
    request.dataset_id = result["dataset_id"].as_str().unwrap().to_owned();
    db.execute("UPDATE shared_schemas SET name=?2,description=?3 WHERE id=(SELECT schema_id FROM datasets WHERE id=?1)",params![request.dataset_id,schema_name,target.schema_description]).map_err(internal)?;
    request.evolved_fields.clear(); request.evolved_identity_fields.clear();
    Ok(Some(json!({"schema_name":schema_name,"schema_id":result["schema_id"],"fields":result["fields"],"identity_fields":result["identity_fields"]})))
}
#[derive(Serialize)]
pub(super) struct Issue {
    scope: String,
    row: usize,
    severity: String,
    source_key: String,
    target_key: String,
    json_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    target_path: String,
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
            self.issues.push(Issue { scope: scope.into(), row, severity: if error { "error" } else { "warning" }.into(), source_key: source.into(), target_key: target.into(), json_path: path.into(), target_path: String::new(), code: code.into(), message: message.into() });
        } else { self.truncated = true; }
    }
    fn mapping_issue(&mut self, scope: &str, row: usize, error: bool, mapping: &FieldMapping, code: &str, message: &str) {
        let previous = self.issues.len();
        self.add(scope, row, error, &mapping.source_key, &mapping.target_key, mapping.json_path.as_deref().unwrap_or(""), code, message);
        if self.issues.len() > previous { self.issues.last_mut().unwrap().target_path = mapping.target_path.clone().unwrap_or_default(); }
    }
    pub fn response(&self, format: Option<&str>) -> ApiResult<Response> {
        let mut response = match format.unwrap_or("json") {
            "json" => Json(self).into_response(),
            "csv" => {
                let mut writer = csv::Writer::from_writer(Vec::new());
                writer.write_record(["scope", "row", "severity", "source_key", "target_key", "json_path", "target_path", "code", "message"]).map_err(internal)?;
                for item in &self.issues {
                    writer.write_record([item.scope.clone(), item.row.to_string(), item.severity.clone(), item.source_key.clone(), item.target_key.clone(), item.json_path.clone(), item.target_path.clone(), item.code.clone(), item.message.clone()].iter().map(|v| csv_safe(v))).map_err(internal)?;
                }
                // Metadata remains in the downloaded report even when the retained issue list is capped.
                writer.write_record(["summary".to_owned(), self.checked_rows.to_string(), format!("errors={};warnings={};truncated={}", self.error_count, self.warning_count, self.truncated), String::new(), String::new(), String::new(), String::new(), String::new(), format!("issue_limit={ISSUE_LIMIT}")]).map_err(internal)?;
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
fn extract_value(input: &Value, source: &str, path: Option<&str>) -> Result<Value, &'static str> {
    let Some(mut value) = input.get(source).cloned() else { return Err("source_missing"); };
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        if let Value::String(text) = value { value = serde_json::from_str(&text).map_err(|_| "invalid_json")?; }
        for segment in path.trim_matches('.').split('.') {
            value = if let Value::Array(items) = &value {
                segment.parse::<usize>().ok().and_then(|i| items.get(i)).cloned()
            } else { value.get(segment).cloned() }.ok_or("path_missing")?;
        }
    }
    Ok(value)
}
pub(super) fn extract(input: &Value, source: &str, path: Option<&str>) -> Result<Value, &'static str> {
    extract_value(input, source, path).and_then(|value| if value.is_null() { Err("matched_null") } else { Ok(value) })
}
fn fits_depth(value: &Value, remaining: usize) -> bool {
    match value {
        Value::Array(items) => remaining > 0 && items.iter().all(|value| fits_depth(value, remaining - 1)),
        Value::Object(items) => remaining > 0 && items.values().all(|value| fits_depth(value, remaining - 1)),
        _ => true,
    }
}
fn extract_for_target(input: &Value, source: &str, path: Option<&str>, target_depth: usize) -> Result<Value, &'static str> {
    if target_depth == 0 { return extract(input, source, path); }
    let value = extract_value(input, source, path)?;
    // Leave room for record/export envelopes under the JSON reader's recursion limit.
    if !fits_depth(&value, 64 - target_depth) { return Err("assembled_depth_exceeded"); }
    Ok(value)
}
fn reason(code: &str) -> &'static str {
    match code {
        "source_missing" => "缺少源字段，不写入此字段；更新匹配记录时会清除旧值",
        "invalid_json" => "源字段不是有效 JSON，无法按路径抽取",
        "path_missing" => "路径未命中，不写入此字段；更新匹配记录时会清除旧值",
        "matched_null" => "结果为 null，不写入此字段；更新匹配记录时会清除旧值",
        "assembled_depth_exceeded" => "目标 JSON 组装后超过 64 层，请缩短目标属性路径或简化来源对象",
        _ => "抽取成功",
    }
}
fn target_parts(path: &str) -> ApiResult<Vec<&str>> {
    if path.is_empty() { return Ok(Vec::new()); }
    let parts: Vec<_> = path.split('.').collect();
    if path.len() > 1024 || parts.len() > 32 || parts.iter().any(|part| part.is_empty() || part.trim() != *part || part.chars().any(|c| c.is_control() || "[]*$".contains(c)) || part.chars().all(|c| c.is_ascii_digit())) {
        return Err(bad_request("目标属性路径最多 1024 字节、32 层，仅支持点分隔的对象属性；不支持空段、数组下标或通配符"));
    }
    Ok(parts)
}
fn target_conflicts(a: &FieldMapping, b: &FieldMapping) -> bool {
    if a.target_key != b.target_key { return false; }
    let a = a.target_path.as_deref().unwrap_or("");
    let b = b.target_path.as_deref().unwrap_or("");
    a.is_empty() || b.is_empty() || a == b || a.strip_prefix(b).is_some_and(|suffix| suffix.starts_with('.')) || b.strip_prefix(a).is_some_and(|suffix| suffix.starts_with('.'))
}
fn mapping_report(mappings: &[FieldMapping], report: &mut Report) -> ApiResult<()> {
    if mappings.len() > 256 { return Err(bad_request("单批最多 256 个字段映射")); }
    for (index, m) in mappings.iter().enumerate() {
        if m.source_key.is_empty() || m.target_key.is_empty() || m.source_key.len() > 1024 || m.target_key.len() > 1024 {
            report.mapping_issue("mappings", index + 1, true, m, "invalid_mapping", "来源和目标字段不能为空或超过 1024 字节");
        }
        if let Err(error) = validate_path(m.json_path.as_deref().unwrap_or("")) {
            report.mapping_issue("mappings", index + 1, true, m, "invalid_source_path", &error.1);
        }
        if let Err(error) = target_parts(m.target_path.as_deref().unwrap_or("")) {
            report.mapping_issue("mappings", index + 1, true, m, "invalid_target_path", &error.1);
        }
        if mappings.iter().enumerate().any(|(other, candidate)| other != index && target_conflicts(m, candidate)) {
            report.mapping_issue("mappings", index + 1, true, m, "target_path_conflict", "同一目标字段存在重复或父子路径，或混用整字段赋值和属性写入；请保留互不重叠的目标路径");
        }
    }
    Ok(())
}
pub(super) fn validate_mapping_configuration(mappings: &[FieldMapping]) -> ApiResult<()> {
    let mut report = Report::new(0);
    mapping_report(mappings, &mut report)?;
    if report.error_count > 0 { return Err(bad_request("导入模板包含无效或冲突的字段映射")); }
    Ok(())
}
fn assign_property(object: &mut Value, parts: &[&str], value: Value) {
    // Validated disjoint paths ensure intermediate nodes can only be objects.
    let mut current = object;
    for part in &parts[..parts.len() - 1] {
        current = current.as_object_mut().unwrap().entry((*part).to_owned()).or_insert_with(|| json!({}));
    }
    current.as_object_mut().unwrap().insert(parts.last().unwrap().to_string(), value);
}
pub(super) fn map_and_report(inputs: &[Value], request: &ImportRequest, identity: &[String]) -> ApiResult<(Vec<Value>, Report)> {
    let mut report = Report::new(inputs.len());
    mapping_report(&request.mappings, &mut report)?;
    if report.error_count > 0 { return Ok((vec![], report)); }
    let paths = request.mappings.iter().map(|m| target_parts(m.target_path.as_deref().unwrap_or(""))).collect::<ApiResult<Vec<_>>>()?;
    let mut output = Vec::with_capacity(inputs.len());
    let mut identities = HashSet::new();
    for (index, input) in inputs.iter().enumerate() {
        let mut record = if request.mappings.is_empty() { input.clone() } else { json!({}) };
        for (m, parts) in request.mappings.iter().zip(&paths) {
            if !parts.is_empty() { record.as_object_mut().unwrap().entry(m.target_key.clone()).or_insert_with(|| json!({})); }
            let assembling = !parts.is_empty();
            let result = extract_for_target(input, &m.source_key, m.json_path.as_deref(), parts.len());
            match result {
                Ok(value) => {
                    if assembling {
                        let object = record.as_object_mut().unwrap().entry(m.target_key.clone()).or_insert_with(|| json!({}));
                        assign_property(object, parts, value);
                    } else { record[&m.target_key] = value; }
                }
                Err(code) => report.mapping_issue("records", index + 1, matches!(code, "invalid_json" | "assembled_depth_exceeded"), m, code,
                    if assembling && matches!(code, "source_missing" | "path_missing") { "来源字段或路径缺失，本次不生成该属性；更新时不会保留目标 JSON 的旧属性" } else { reason(code) }),
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
    let (mapped, mut report) = map_and_report(inputs, request, &identity)?;
    let raw_fields: String = db.query_row("SELECT fields_json FROM datasets WHERE id=?1", [&request.dataset_id], |row| row.get(0)).map_err(internal)?;
    let mut fields: Vec<FieldDefinition> = serde_json::from_str(&raw_fields).map_err(internal)?;
    fields.extend(request.evolved_fields.iter().cloned());
    for (index, mapping) in request.mappings.iter().enumerate() {
        if mapping.target_path.as_deref().is_some_and(|p| !p.is_empty()) && !fields.iter().any(|field| field.source_key == mapping.target_key) {
            report.mapping_issue("mappings", index + 1, true, mapping, "undefined_json_target", "请先定义目标 JSON 字段及其用途，或随导入创建该字段");
        }
    }
    Ok((mapped, report))
}
pub(super) async fn run(state: AppState, mut request: ImportRequest, preview: bool) -> ApiResult<Json<Value>> {
    with_batch(&state, &request.batch_id.clone(), |inputs, keys| {
        let db = open_database(&database_path(&state), &keys.db)?;
        let tx = db.unchecked_transaction().map_err(internal)?;
        let created = prepare_target(&tx, keys, &mut request)?;
        let (mapped, report) = scan(&tx, inputs, &request)?;
        if report.error_count > 0 {
            if preview { return Ok(Json(json!({"valid":false,"diagnostics":report}))); }
            return Err(bad_request(format!("导入包含 {} 项错误，请先预检并下载错误报告；未写入任何记录", report.error_count)));
        }
        let mut result = import_records_in_connection(&tx, keys, &request, &mapped)?;
        if let Some(created) = created { result["created_dataset"] = json!(true); result["model"] = created; result["dataset_id"] = json!(request.dataset_id); }
        if preview { tx.rollback().map_err(internal)?; } else { tx.commit().map_err(internal)?; }
        result["diagnostics"] = serde_json::to_value(report).map_err(internal)?;
        result["valid"] = json!(true);
        Ok(Json(result))
    }).await
}
#[derive(Deserialize)]
pub(super) struct Format { pub format: Option<String> }
pub(super) async fn report(State(state): State<AppState>, Query(format): Query<Format>, Json(mut request): Json<ImportRequest>) -> ApiResult<Response> {
    with_batch(&state, &request.batch_id.clone(), |inputs, keys| {
        let db = open_database(&database_path(&state), &keys.db)?;
        let tx = db.unchecked_transaction().map_err(internal)?;
        prepare_target(&tx, keys, &mut request)?;
        let response = scan(&tx, inputs, &request)?.1.response(format.format.as_deref())?;
        tx.rollback().map_err(internal)?;
        Ok(response)
    }).await
}
#[derive(Deserialize)]
pub(super) struct SampleRequest { source_key: String, #[serde(default)] json_path: Option<String>, #[serde(default)] target_path: Option<String>, #[serde(default)] reveal: bool }
fn sample_value(value: Option<&Value>, reveal: bool) -> Value {
    let Some(value) = value else { return json!({"present":false}); };
    let kind = match value { Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number", Value::String(_) => "string", Value::Array(_) => "array", Value::Object(_) => "object" };
    if !reveal { return json!({"present":true,"type":kind,"masked":true}); }
    let text = if let Some(text) = value.as_str() { text.to_owned() } else { value.to_string() };
    json!({"present":true,"type":kind,"masked":false,"text":text.chars().take(2048).collect::<String>(),"truncated":text.chars().count()>2048})
}
pub(super) async fn samples(State(state): State<AppState>, Path(id): Path<String>, Json(request): Json<SampleRequest>) -> ApiResult<Response> {
    validate_path(request.json_path.as_deref().unwrap_or(""))?;
    let target_depth = target_parts(request.target_path.as_deref().unwrap_or(""))?.len();
    if request.source_key.is_empty() || request.source_key.len() > 1024 { return Err(bad_request("源字段无效")); }
    with_batch(&state, &id, |inputs, keys| {
        if request.reveal {
            let db = open_database(&database_path(&state), &keys.db)?;
            db.execute("INSERT INTO audit_events(event,field_name) VALUES('import_samples_reveal',?1)", [&request.source_key]).map_err(internal)?;
        }
        let rows: Vec<Value> = inputs.iter().take(3).enumerate().map(|(i, input)| {
            let result = extract_for_target(input, &request.source_key, request.json_path.as_deref(), target_depth);
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
    #[tokio::test]
    async fn new_import_creates_model_dataset_and_records_atomically_only_on_commit() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("samples/.build"); fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("new-import-{}",Uuid::new_v4()));
        struct Cleanup(PathBuf); impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(directory.clone()); private_dir(&directory).unwrap();
        let state = rotation::state_for(directory); let (keys,_) = initialize_vault(&state,"new-import-test-password-2026").unwrap(); activate(&state,keys,true).await;
        state.batches.lock().await.insert("new".into(),ImportBatch::new(vec![json!({"code":"001","artist_id":"00123"})],None));
        let body = json!({"batch_id":"new","new_dataset":{"category_path":"导入/新建","name":"新建实例","schema_name":"艺人模型","schema_description":"模型说明","environment_names":["测试标签"]},"evolved_fields":[{"source_key":"code","zone":"indexes"},{"source_key":"payload","zone":"secrets"}],"evolved_identity_fields":["code"],"template_name":"new-template","mappings":[{"source_key":"code","target_key":"code"},{"source_key":"artist_id","target_key":"payload","target_path":"artist.id"}]});
        let preview = run(state.clone(),serde_json::from_value(body.clone()).unwrap(),true).await.unwrap().0;
        assert_eq!(preview["valid"],true); assert_eq!(preview["imported"],1); assert_eq!(preview["model"]["schema_name"],"艺人模型");
        report(State(state.clone()),Query(Format {format:Some("csv".into())}),Json(serde_json::from_value(body.clone()).unwrap())).await.unwrap();
        let mut invalid = body.clone(); invalid["mappings"][1]["target_path"] = json!("artist..id");
        assert_eq!(run(state.clone(),serde_json::from_value(invalid.clone()).unwrap(),true).await.unwrap().0["valid"],false);
        assert!(run(state.clone(),serde_json::from_value(invalid).unwrap(),false).await.is_err());
        with_connection(&state,|db,_| {
            for table in ["datasets","shared_schemas","environments","records","import_templates"] {
                assert_eq!(db.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0);
            } Ok(())
        }).await.unwrap();
        let result = run(state.clone(),serde_json::from_value(body.clone()).unwrap(),false).await.unwrap().0;
        assert_eq!(result["created_dataset"],true); assert_eq!(result["imported"],1);
        // A template conflict must roll back the second model, instance, labels and records.
        let mut conflicting = body.clone(); conflicting["new_dataset"]["environment_names"] = json!(["不能残留"]);
        assert!(run(state.clone(),serde_json::from_value(conflicting).unwrap(),false).await.is_err());
        with_connection(&state,|db,_| {
            for table in ["datasets","shared_schemas","environments","records","import_templates","protected_fields"] {
                assert_eq!(db.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),1);
            }
            let (name,description):(String,String) = db.query_row("SELECT name,description FROM shared_schemas",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(name,"艺人模型"); assert_eq!(description,"模型说明"); Ok(())
        }).await.unwrap();
        for property in ["skip_existing","delete_missing"] {
            let mut invalid = body.clone(); invalid[property] = json!(true);
            assert!(run(state.clone(),serde_json::from_value(invalid).unwrap(),true).await.is_err());
        }
    }
    fn request(batch: &str) -> ImportRequest {
        serde_json::from_value(json!({"dataset_id":"test","batch_id":batch,"mappings":[{"source_key":"payload","target_key":"key","json_path":"items.0.id"}]})).unwrap()
    }
    #[test]
    fn json_assembly_keeps_types_nulls_and_missing_attributes_separate() {
        let mappings = json!([
            {"source_key":"key","target_key":"key"},
            {"source_key":"artist_id","target_key":"payload","target_path":"artist.id"},
            {"source_key":"artist_name","target_key":"payload","target_path":"artist.name"},
            {"source_key":"bundle_ids","target_key":"payload","target_path":"bundle_ids"},
            {"source_key":"enabled","target_key":"payload","target_path":"enabled"},
            {"source_key":"count","target_key":"payload","target_path":"count"},
            {"source_key":"empty","target_key":"payload","target_path":"empty"},
            {"source_key":"nil","target_key":"payload","target_path":"nil"},
            {"source_key":"encoded","target_key":"payload","json_path":"detail","target_path":"detail"},
            {"source_key":"missing","target_key":"payload","target_path":"optional.value"}
        ]);
        let req: ImportRequest = serde_json::from_value(json!({"dataset_id":"test","batch_id":"b","mappings":mappings})).unwrap();
        let rows = vec![json!({"key":"one","artist_id":9007199254740993u64,"artist_name":"001","bundle_ids":["one", "two"],"enabled":false,"count":0,"empty":"","nil":null,"encoded":r#"{"detail":{"flag":true,"nil":null}}"#})];
        let (mapped, report) = map_and_report(&rows, &req, &["key".into()]).unwrap();
        assert_eq!(report.error_count, 0); assert_eq!(report.warning_count, 1);
        assert_eq!(mapped, vec![json!({"key":"one","payload":{"artist":{"id":9007199254740993u64,"name":"001"},"bundle_ids":["one","two"],"enabled":false,"count":0,"empty":"","nil":null,"detail":{"flag":true,"nil":null}}})]);
        assert_eq!(report.issues[0].target_path, "optional.value");
        let (mapped, _) = map_and_report(&[json!({"key":"none"})], &req, &[]).unwrap();
        assert_eq!(mapped[0]["payload"], json!({}));
        let mut reversed = req; reversed.mappings.reverse();
        assert_eq!(map_and_report(&rows, &reversed, &[]).unwrap().0[0]["payload"]["artist"]["id"], json!(9007199254740993u64));
    }

    #[test]
    fn conflicting_target_paths_are_reported_before_examining_any_record() {
        for (a, b) in [("artist.id", "artist.id"), ("artist", "artist.id"), ("artist.id", "artist"), ("", "artist.id"), ("artist.id", "")] {
            let req: ImportRequest = serde_json::from_value(json!({"dataset_id":"d","batch_id":"b","mappings":[{"source_key":"a","target_key":"payload","target_path":a},{"source_key":"b","target_key":"payload","target_path":b}]})).unwrap();
            let (mapped, report) = map_and_report(&[json!({"a":"SECRET-TEST"}),json!({})], &req, &[]).unwrap();
            assert!(mapped.is_empty()); assert_eq!(report.error_count, 2); assert_eq!(report.checked_rows, 2);
            assert!(report.issues.iter().all(|issue| issue.scope == "mappings" && issue.code == "target_path_conflict"));
            assert!(!serde_json::to_string(&report).unwrap().contains("SECRET-TEST"));
            assert!(validate_mapping_configuration(&req.mappings).is_err());
        }
        for path in [".artist", "artist.", "artist..id", "items.0.id", "items[0].id", "artist.*", "artist. id"] {
            let mut req = request("b"); req.mappings[0].target_path = Some(path.into());
            assert!(map_and_report(&[json!({})], &req, &[]).unwrap().1.error_count > 0, "{path}");
        }
        let req: ImportRequest = serde_json::from_value(json!({"dataset_id":"d","batch_id":"b","mappings":[{"source_key":"a","target_key":"payload","target_path":"artist.id"},{"source_key":"b","target_key":"payload","target_path":"artist.identifier"}]})).unwrap();
        assert_eq!(map_and_report(&[json!({"a":1,"b":2})], &req, &[]).unwrap().0, vec![json!({"payload":{"artist":{"id":1,"identifier":2}}})]);
        assert!(target_parts(&vec!["a";33].join(".")).is_err());
    }

    #[test]
    fn assembly_rejects_combined_nesting_that_would_break_storage_or_export() {
        let mut nested = json!(false);
        for _ in 0..63 { nested = json!([nested]); }
        let input = json!({"value":nested});
        let mut req: ImportRequest = serde_json::from_value(json!({"dataset_id":"d","batch_id":"b","mappings":[{"source_key":"value","target_key":"payload","target_path":"value"}]})).unwrap();
        let (mapped, report) = map_and_report(&[input.clone()], &req, &[]).unwrap();
        assert_eq!(report.error_count, 0);
        assert!(serde_json::from_str::<Value>(&serde_json::to_string(&mapped).unwrap()).is_ok());
        req.mappings[0].target_path = Some("nested.value".into());
        let (_, report) = map_and_report(&[input], &req, &[]).unwrap();
        assert_eq!(report.error_count, 1); assert_eq!(report.issues[0].code, "assembled_depth_exceeded");
    }

    #[tokio::test]
    async fn assembly_preview_commit_replace_skip_and_protected_fields_use_one_pipeline() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("samples/.build"); fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("json-assembly-{}",Uuid::new_v4()));
        struct Cleanup(PathBuf); impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(directory.clone()); private_dir(&directory).unwrap();
        let state = rotation::state_for(directory); let (keys,_) = initialize_vault(&state,"assembly-test-password-2026").unwrap(); activate(&state,keys,true).await;
        let dataset = create_dataset(State(state.clone()),Json(serde_json::from_value(json!({"category_path":"导入/组装","fields":[{"source_key":"key","zone":"indexes"},{"source_key":"payload","zone":"secrets"}],"identity_fields":["key"],"sample_data":[{"key":"one","payload":{"old":"remove","artist":{"name":"old"}}}]})).unwrap())).await.unwrap().0["dataset_id"].as_str().unwrap().to_owned();
        state.batches.lock().await.insert("assembly".into(),ImportBatch::new(vec![json!({"key":"one","artist_id":"001","nil":null})],None));
        let mut body = json!({"dataset_id":dataset,"batch_id":"assembly","template_name":"assembly","mappings":[{"source_key":"key","target_key":"key"},{"source_key":"artist_id","target_key":"payload","target_path":"artist.id"},{"source_key":"nil","target_key":"payload","target_path":"artist.name"}]});
        async fn export_values(state: &AppState, dataset: &str, secrets: bool) -> Value {
            let mut headers = HeaderMap::new(); headers.insert("x-vault-owner", HeaderValue::from_static("true"));
            let response = export_dataset(State(state.clone()),Path(dataset.to_owned()),Query(serde_json::from_value(json!({"format":"json","include_secrets":secrets})).unwrap()),headers).await.unwrap();
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(),100000).await.unwrap()).unwrap()
        }
        let before = export_values(&state,&dataset,true).await;
        assert_eq!(run(state.clone(),serde_json::from_value(body.clone()).unwrap(),true).await.unwrap().0["updated"],1);
        assert_eq!(export_values(&state,&dataset,true).await,before);
        body["skip_existing"] = json!(true);
        assert_eq!(run(state.clone(),serde_json::from_value(body.clone()).unwrap(),false).await.unwrap().0["skipped"],1);
        assert_eq!(export_values(&state,&dataset,true).await,before);
        body["skip_existing"] = json!(false);
        assert_eq!(run(state.clone(),serde_json::from_value(body.clone()).unwrap(),false).await.unwrap().0["updated"],1);
        let after = export_values(&state,&dataset,true).await;
        assert_eq!(after, json!([{"key":"one","payload":{"artist":{"id":"001","name":null}}}]));
        assert_eq!(export_values(&state,&dataset,false).await,json!([{"key":"one"}]));
        with_connection(&state,|db,_| {
            let public: String = db.query_row("SELECT indexes_json || display_json FROM records", [], |r| r.get(0)).unwrap();
            assert!(!public.contains("artist"));
            let template: String = db.query_row("SELECT mappings_json FROM import_templates WHERE name='assembly'",[],|r|r.get(0)).unwrap();
            assert!(template.contains("target_path")); Ok(())
        }).await.unwrap();
        body["mappings"][2]["target_path"] = json!("artist");
        let preview = run(state.clone(),serde_json::from_value(body.clone()).unwrap(),true).await.unwrap().0;
        assert_eq!(preview["valid"],false); assert_eq!(preview["diagnostics"]["error_count"],2);
        assert!(run(state.clone(),serde_json::from_value(body.clone()).unwrap(),false).await.is_err());
        assert_eq!(export_values(&state,&dataset,true).await,after);
        body["mappings"][2]["target_path"] = json!("artist.name"); body["mappings"][2]["target_key"] = json!("undefined");
        assert_eq!(run(state.clone(),serde_json::from_value(body).unwrap(),true).await.unwrap().0["valid"],false);
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
        req.mappings.push(FieldMapping { source_key:"other".into(),target_key:"key".into(),json_path:None, target_path:None });
        assert!(map_and_report(&rows,&req,&[]).unwrap().1.error_count > 0);
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
