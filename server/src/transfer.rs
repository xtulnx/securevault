use super::*;
use std::collections::{HashMap, HashSet};

// Dataset interchange is independent of the encrypted whole-vault backup.
// Missing values are absent from `values`; null remains an actual JSON value.
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct Package {
    format: String,
    version: u32,
    mode: String,
    #[serde(default = "default_scope")]
    record_scope: String,
    schema: Schema,
    #[serde(default)]
    records: Vec<Record>,
    #[serde(default)]
    supplements: Vec<Extension>,
    #[serde(default)]
    templates: Vec<Template>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Schema {
    #[serde(default, skip_serializing_if="Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    schema_name: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    schema_description: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    customer: Option<String>,
    category_path: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    environments: Option<Vec<String>>,
    #[serde(default)]
    description: String,
    fields: Vec<FieldDefinition>,
    #[serde(default)]
    identity_fields: Vec<String>,
    #[serde(default = "default_conflict")]
    conflict_strategy: String,
    #[serde(default)]
    list_fields: Vec<ListFieldDefinition>,
    #[serde(default)]
    display_config: DisplayConfig,
    #[serde(default)]
    supplement_fields: Vec<FieldDefinition>,
    #[serde(default = "version_one")]
    supplement_link_version: u32,
}
fn version_one() -> u32 {
    1
}
fn default_scope() -> String {
    "all".into()
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Record {
    source_id: String,
    values: serde_json::Map<String, Value>,
    #[serde(default)]
    omitted_fields: Vec<String>,
    #[serde(default)]
    expired: bool,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Extension {
    source_id: String,
    main_source_id: String,
    values: serde_json::Map<String, Value>,
    #[serde(default)]
    omitted_fields: Vec<String>,
    orphan: bool,
    link: Value,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Template {
    name: String,
    mappings: Vec<FieldMapping>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    #[serde(deserialize_with = "deserialize_package")]
    package: Package,
    #[serde(default)]
    dataset_id: Option<String>,
    category_path: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    environments: Option<Vec<String>>,
    #[serde(default)]
    skip_existing: bool,
    #[serde(default)]
    confirm_changes: bool,
    #[serde(default)]
    confirmation_token: Option<String>,
    #[serde(default)]
    template_names: Vec<String>,
}

// The browser passes native files as their original JSON text so integer values
// above JavaScript's exact-number range are not rounded before reaching Rust.
fn deserialize_package<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Package, D::Error> {
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(text) => serde_json::from_str(&text).map_err(serde::de::Error::custom),
        value => serde_json::from_value(value).map_err(serde::de::Error::custom),
    }
}

fn read_schema(db: &Connection, id: &str) -> ApiResult<Schema> {
    let value: Value = db.query_row(
        "SELECT category_path,environment,description,fields_json,identity_fields_json,conflict_strategy,list_fields_json,display_config_json FROM datasets WHERE id=?1", [id],
        |r| Ok(json!({"category_path":r.get::<_,String>(0)?,"environment":r.get::<_,Option<String>>(1)?,"description":r.get::<_,String>(2)?,"fields":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!([])),"identity_fields":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!([])),"conflict_strategy":r.get::<_,String>(5)?,"list_fields":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).unwrap_or(json!([])),"display_config":serde_json::from_str::<Value>(&r.get::<_,String>(7)?).unwrap_or(json!({}))}))
    ).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND,"数据集不存在".into()))?;
    let mut schema: Schema = serde_json::from_value(value).map_err(internal)?;
    schema.supplement_fields = supplement::fields(db, id)?;
    let (schema_name,customer,schema_description):(Option<String>,Option<String>,Option<String>)=db.query_row("SELECT s.name,c.name,s.description FROM datasets d LEFT JOIN shared_schemas s ON s.id=d.schema_id LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(internal)?;
    schema.name=Some(db.query_row("SELECT name FROM datasets WHERE id=?1",[id],|r|r.get(0)).map_err(internal)?);
    schema.schema_name=schema_name;schema.customer=customer;schema.schema_description=schema_description;
    schema.environments=Some(catalog::environments(db,id)?.into_iter().map(|v|v.1).collect());
    Ok(schema)
}

fn exported_values(
    mut values: serde_json::Map<String, Value>,
    fields: &[FieldDefinition],
    secrets: bool,
) -> (serde_json::Map<String, Value>, Vec<String>) {
    let mut omitted = Vec::new();
    values.retain(|key, _| {
        let zone = fields
            .iter()
            .find(|f| f.source_key == *key)
            .map(|f| f.zone.as_str());
        if zone.is_none() || zone == Some("ignore") {
            return false;
        }
        if matches!(zone, Some("hidden" | "secrets")) && !secrets {
            omitted.push(key.clone());
            return false;
        }
        true
    });
    (values, omitted)
}

fn build_package(
    db: &Connection,
    keys: &KeySet,
    id: &str,
    query: &ExportQuery,
) -> ApiResult<Package> {
    let schema = read_schema(db, id)?;
    let mode = query.content.as_deref().unwrap_or("schema");
    if !matches!(mode, "schema" | "package") {
        return Err(bad_request("导出内容无效"));
    }
    if query.format.as_deref().is_some_and(|f| f != "json") {
        return Err(bad_request("结构与原生数据集包使用 JSON 格式"));
    }
    let mut package = Package {
        format: "securevault-dataset".into(),
        version: 1,
        mode: mode.into(),
        record_scope: if query.include_expired {
            "all".into()
        } else {
            "active".into()
        },
        schema,
        records: Vec::new(),
        supplements: Vec::new(),
        templates: Vec::new(),
    };
    if mode == "package" {
        let mut statement = db.prepare("SELECT id,expired FROM records WHERE dataset_id=?1 AND (?2 OR expired=0) ORDER BY id").map_err(internal)?;
        let rows = statement
            .query_map(params![id, query.include_expired], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
            })
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?;
        for (record_id, expired) in rows {
            let values = supplement::main_values(db, keys, &record_id)?;
            if let Some(key) = values.keys().find(|key| {
                !package
                    .schema
                    .fields
                    .iter()
                    .any(|field| &field.source_key == *key)
            }) {
                return Err(bad_request(format!(
                    "记录包含未定义字段 {key}，请补充字段定义后导出原生包；仅数据导出仍可使用"
                )));
            }
            let (values, omitted_fields) =
                exported_values(values, &package.schema.fields, query.include_secrets);
            package.records.push(Record {
                source_id: record_id,
                values,
                omitted_fields,
                expired,
            });
        }
        if query.include_supplements {
            let selected: HashSet<_> = package
                .records
                .iter()
                .map(|record| record.source_id.as_str())
                .collect();
            for row in supplement::rows(db, keys, id, None)? {
                if row["orphan"] == false
                    && !selected.contains(row["main_record_id"].as_str().unwrap_or_default())
                {
                    continue;
                }
                let source = row["id"]
                    .as_str()
                    .ok_or_else(|| internal("missing supplement ID"))?;
                let values = supplement::values(db, keys, source)?
                    .as_object()
                    .cloned()
                    .ok_or_else(|| internal("invalid supplement values"))?;
                if let Some(key) = values.keys().find(|key| {
                    !package
                        .schema
                        .supplement_fields
                        .iter()
                        .any(|field| &field.source_key == *key)
                }) {
                    return Err(bad_request(format!(
                        "附表包含未定义字段 {key}，请补充字段定义后再导出"
                    )));
                }
                let (values, omitted_fields) = exported_values(
                    values,
                    &package.schema.supplement_fields,
                    query.include_secrets,
                );
                package.supplements.push(Extension {
                    source_id: source.into(),
                    main_source_id: row["main_record_id"].as_str().unwrap_or_default().into(),
                    values,
                    omitted_fields,
                    orphan: row["orphan"].as_bool().unwrap_or(true),
                    link: row["link"].clone(),
                });
            }
        }
    }
    if query.include_templates {
        let mut stmt = db
            .prepare(
                "SELECT name,mappings_json FROM import_templates WHERE dataset_id=?1 ORDER BY name",
            )
            .map_err(internal)?;
        package.templates = stmt
            .query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?
            .into_iter()
            .map(|(name, raw)| {
                Ok(Template {
                    name,
                    mappings: serde_json::from_str(&raw).map_err(internal)?,
                })
            })
            .collect::<ApiResult<_>>()?;
    }
    Ok(package)
}

pub(super) async fn export(
    state: AppState,
    id: String,
    query: ExportQuery,
    headers: HeaderMap,
) -> ApiResult<Response> {
    if !headers.contains_key("x-vault-owner") {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "结构导出需要管理会话".into(),
        ));
    }
    with_connection(&state, |db,keys| {
        let package = build_package(db,keys,&id,&query)?;
        let filename = format!("securevault-{id}.{}.json", if package.mode == "schema" { "schema" } else { "dataset" });
        let bytes = serde_json::to_vec_pretty(&package).map_err(internal)?;
        db.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('dataset_transfer_export',?1,?2)",params![id,package.mode]).map_err(internal)?;
        let mut response = bytes.into_response();
        response.headers_mut().insert(header::CONTENT_TYPE,HeaderValue::from_static("application/json"));
        response.headers_mut().insert(header::CONTENT_DISPOSITION,HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")).map_err(internal)?);
        Ok(response)
    }).await
}

fn validate_package(package: &Package) -> ApiResult<()> {
    if package.format != "securevault-dataset" || package.version != 1 {
        return Err(bad_request("不支持的数据集文件格式或版本"));
    }
    if !matches!(package.mode.as_str(), "schema" | "package")
        || package.schema.supplement_link_version != 1
    {
        return Err(bad_request("不支持的数据集或附表关联版本"));
    }
    if package.mode == "schema" && (!package.records.is_empty() || !package.supplements.is_empty())
    {
        return Err(bad_request("仅结构文件不能包含记录"));
    }
    if !matches!(package.record_scope.as_str(), "all" | "active") {
        return Err(bad_request("记录范围无效"));
    }
    if package.records.len() > 10000 || package.supplements.len() > 10000 {
        return Err(bad_request("单个数据集包最多包含 10000 条主表及附表记录"));
    }
    let schema = &package.schema;
    normalize_category(&schema.category_path)?;
    if let Some(name)=&schema.name {normalize_dataset_name(name)?;}
    if schema.conflict_strategy != "allow_mark" {
        return Err(bad_request("重复处理策略无效"));
    }
    validate_schema(&schema.fields, &schema.identity_fields, &schema.list_fields)?;
    validate_display_config(&schema.display_config, &schema.fields)?;
    validate_schema(&schema.supplement_fields, &[], &[])?;
    if schema
        .fields
        .iter()
        .chain(&schema.supplement_fields)
        .any(|f| f.previous_source_key.is_some())
    {
        return Err(bad_request(
            "交换文件应包含最终字段定义，不能携带未执行的重命名",
        ));
    }
    let validate_values = |values: &serde_json::Map<String, Value>,
                           omitted: &[String],
                           fields: &[FieldDefinition]|
     -> ApiResult<()> {
        for key in values.keys() {
            if !fields
                .iter()
                .any(|f| &f.source_key == key && f.zone != "ignore")
            {
                return Err(bad_request(format!("记录含未定义或忽略字段：{key}")));
            }
        }
        let mut seen = HashSet::new();
        for key in omitted {
            if values.contains_key(key)
                || !seen.insert(key)
                || !fields.iter().any(|f| {
                    &f.source_key == key && matches!(f.zone.as_str(), "hidden" | "secrets")
                })
            {
                return Err(bad_request("未导出字段声明无效"));
            }
        }
        Ok(())
    };
    let mut ids = HashSet::new();
    for row in &package.records {
        if row.source_id.is_empty() || !ids.insert(&row.source_id) {
            return Err(bad_request("来源记录 ID 为空或重复"));
        }
        validate_values(&row.values, &row.omitted_fields, &schema.fields)?;
    }
    let mut extension_ids = HashSet::new();
    let mut parents = HashSet::new();
    for row in &package.supplements {
        if row.source_id.is_empty() || !extension_ids.insert(&row.source_id) {
            return Err(bad_request("附表来源 ID 为空或重复"));
        }
        if !row.orphan
            && (!ids.contains(&row.main_source_id) || !parents.insert(&row.main_source_id))
        {
            return Err(bad_request("附表关联不完整或重复"));
        }
        if !row.link.is_object()
            || !matches!(
                row.link["mode"].as_str(),
                Some("id" | "indexes" | "incomplete")
            )
            || !row.link["fields"].is_array()
            || !row.link["values"].is_object()
        {
            return Err(bad_request("附表关联快照无效"));
        }
        validate_values(&row.values, &row.omitted_fields, &schema.supplement_fields)?;
    }
    let mut templates = HashSet::new();
    for template in &package.templates {
        if template.name.trim().is_empty()
            || !templates.insert(&template.name)
            || template.mappings.iter().any(|m| {
                m.source_key.is_empty()
                    || !schema.fields.iter().any(|f| f.source_key == m.target_key)
            })
        {
            return Err(bad_request("导入模板定义无效"));
        }
    }
    Ok(())
}

fn changes(db: &Connection, request: &Request) -> ApiResult<Vec<String>> {
    let Some(id) = request.dataset_id.as_deref() else {
        return Ok(Vec::new());
    };
    let old = read_schema(db, id)?;
    let mut result = Vec::new();
    for (label, previous, next) in [
        ("主表", &old.fields, &request.package.schema.fields),
        (
            "附表",
            &old.supplement_fields,
            &request.package.schema.supplement_fields,
        ),
    ] {
        for field in next {
            if let Some(old) = previous.iter().find(|f| f.source_key == field.source_key) {
                if old.display_name != field.display_name || old.position != field.position {
                    result.push(format!(
                        "{label}字段 {} 的名称或顺序将更新",
                        field.source_key
                    ));
                }
                if old.zone != field.zone {
                    result.push(format!(
                        "{label}字段 {}：{} → {}{}",
                        field.source_key,
                        old.zone,
                        field.zone,
                        if field.zone == "ignore" {
                            "（清除已有值）"
                        } else {
                            ""
                        }
                    ));
                }
            } else {
                result.push(format!("新增{label}字段 {}", field.source_key));
            }
        }
    }
    if serde_json::to_value(&old.list_fields).map_err(internal)?
        != serde_json::to_value(&request.package.schema.list_fields).map_err(internal)?
        || serde_json::to_value(&old.display_config).map_err(internal)?
            != serde_json::to_value(&request.package.schema.display_config).map_err(internal)?
    {
        result.push("列表展示规则将更新".into());
    }
    if request.package.schema.name.as_ref().is_some_and(|name| old.name.as_ref() != Some(name)) {
        result.push("数据集名称将更新".into());
    }
    if old.description != request.package.schema.description {
        result.push("数据集描述将更新".into());
    }
    if old.identity_fields != request.package.schema.identity_fields {
        result.push("逻辑唯一 KEY 将变更，影响去重与附表关联".into());
    }
    if old.category_path != request.category_path || old.environments.as_deref().unwrap_or_default() != requested_environments(request).as_slice() {
        result.push("目录或环境将变更".into());
    }
    Ok(result)
}

fn confirmation_token(db: &Connection, request: &Request) -> ApiResult<String> {
    let mut value = serde_json::to_value(request).map_err(internal)?;
    value.as_object_mut().unwrap().remove("confirmation_token");
    value.as_object_mut().unwrap().remove("confirm_changes");
    let mut hash = Sha256::new();
    hash.update(value.to_string());
    if let Some(id) = request.dataset_id.as_deref() {
        hash.update(serde_json::to_vec(&read_schema(db, id)?).map_err(internal)?);
        for sql in [
            "SELECT id || indexes_json || display_json || expired || updated_at FROM records WHERE dataset_id=?1 ORDER BY id",
            "SELECT r.id || p.source_key || hex(p.nonce) || hex(p.ciphertext) FROM records r JOIN protected_fields p ON p.record_id=r.id WHERE r.dataset_id=?1 ORDER BY r.id,p.source_key",
            "SELECT id || main_record_id || link_json || hex(ciphertext) || orphan FROM supplement_records WHERE dataset_id=?1 ORDER BY id",
        ] {
            let mut stmt = db.prepare(sql).map_err(internal)?;
            for row in stmt
                .query_map([id], |r| r.get::<_, String>(0))
                .map_err(internal)?
            {
                hash.update(row.map_err(internal)?);
            }
        }
    }
    Ok(hex::encode(hash.finalize()))
}

fn requested_environments(request:&Request) -> Vec<String> {
    if let Some(labels)=&request.environments {return labels.clone();}
    // New exports provide all labels. An unchanged compatibility field preserves them.
    if request.environment==request.package.schema.environment {
        if let Some(labels)=&request.package.schema.environments {return labels.clone();}
    }
    request.environment.iter().cloned().collect()
}

fn apply(db: &Connection, keys: &KeySet, request: &Request) -> ApiResult<Value> {
    validate_package(&request.package)?;
    let category = normalize_category(&request.category_path)?;
    let schema = &request.package.schema;
    let environment_names=requested_environments(request);
    let id = if let Some(id) = request.dataset_id.as_deref() {
        let old = read_schema(db, id)?;
        let mut merged = schema.fields.clone();
        for field in old.fields {
            if !merged.iter().any(|f| f.source_key == field.source_key) {
                merged.push(field);
            }
        }
        let update:DatasetUpdate=serde_json::from_value(json!({"name":schema.name,"category_path":category,"environment_names":environment_names,"description":schema.description,"fields":merged,"identity_fields":schema.identity_fields,"list_fields":schema.list_fields,"display_config":schema.display_config})).map_err(internal)?;
        update_dataset_in_connection(db, keys, id, update)?;
        id.to_owned()
    } else {
        let id = format!("ds_{}", Uuid::new_v4().simple());
        db.execute("INSERT INTO datasets(id,category_path,environment,description,fields_json,identity_fields_json,conflict_strategy,list_fields_json,display_config_json,name) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,category,request.environment,schema.description,serde_json::to_string(&schema.fields).map_err(internal)?,serde_json::to_string(&schema.identity_fields).map_err(internal)?,schema.conflict_strategy,serde_json::to_string(&schema.list_fields).map_err(internal)?,serde_json::to_string(&schema.display_config).map_err(internal)?,normalize_dataset_name(schema.name.as_deref().unwrap_or(""))?]).map_err(internal)?;
        id
    };
    let environment_ids=catalog::resolve_environments(db,None,Some(&environment_names),None,None,false)?.unwrap_or_default();
    catalog::set_environments(db,&id,&environment_ids)?;
    let old_extensions = supplement::fields(db, &id)?;
    let mut extensions = schema.supplement_fields.clone();
    for field in &old_extensions {
        if !extensions.iter().any(|f| f.source_key == field.source_key) {
            extensions.push(field.clone());
        }
    }
    let mut proposed=catalog::read_instance(db,&id)?;
    proposed.supplement_fields=extensions.clone();
    catalog::require_local_edit(db,&id,&proposed)?;
    // Keep fields absent from the source; clear only explicitly ignored values.
    let rows = supplement::rows(db, keys, &id, None)?;
    for row in rows {
        let source = row["id"].as_str().unwrap();
        let mut values = supplement::values(db, keys, source)?
            .as_object()
            .cloned()
            .unwrap_or_default();
        values.retain(|key, _| {
            !extensions
                .iter()
                .any(|f| f.source_key == *key && f.zone == "ignore")
        });
        let (nonce, ciphertext) =
            seal_field(&keys.field, source, "supplement", &Value::Object(values))?;
        db.execute(
            "UPDATE supplement_records SET nonce=?2,ciphertext=?3 WHERE id=?1",
            params![source, nonce, ciphertext],
        )
        .map_err(internal)?;
    }
    db.execute("INSERT INTO supplement_schemas(dataset_id,fields_json) VALUES(?1,?2) ON CONFLICT(dataset_id) DO UPDATE SET fields_json=excluded.fields_json",params![id,serde_json::to_string(&extensions).map_err(internal)?]).map_err(internal)?;
    let mut mapping = HashMap::new();
    let mut skipped_sources = HashSet::new();
    let (mut inserted, mut updated, mut skipped) = (0, 0, 0);
    for row in &request.package.records {
        let mut nested = serde_json::Map::new();
        for (key, value) in &row.values {
            insert_nested_value(&mut nested, key, value.clone());
        }
        let hash = identity_hash(
            &keys.identity,
            &id,
            &schema.identity_fields,
            &Value::Object(nested),
        );
        let existing: Option<String> = if hash.is_some() {
            db.query_row("SELECT id FROM records WHERE dataset_id=?1 AND identity_hash=?2 ORDER BY updated_at,id LIMIT 1",params![id,hash],|r|r.get(0)).optional().map_err(internal)?
        } else {
            None
        };
        if let Some(ref existing) = existing {
            if request.skip_existing {
                mapping.insert(row.source_id.clone(), existing.clone());
                skipped_sources.insert(row.source_id.clone());
                skipped += 1;
                continue;
            }
        }
        let write: supplement::WriteRequest =
            serde_json::from_value(json!({"values":row.values})).map_err(internal)?;
        let result = supplement::write_main(db, keys, &id, existing.as_deref(), &write)?;
        let target = result["id"].as_str().unwrap().to_owned();
        db.execute(
            "UPDATE records SET expired=?2 WHERE id=?1",
            params![target, row.expired],
        )
        .map_err(internal)?;
        mapping.insert(row.source_id.clone(), target);
        if existing.is_some() {
            updated += 1;
        } else {
            inserted += 1;
        }
    }
    let mut extension_count = 0;
    for row in &request.package.supplements {
        if skipped_sources.contains(&row.main_source_id) {
            continue;
        }
        if let Some(parent) = mapping.get(&row.main_source_id).filter(|_| !row.orphan) {
            let existing:Option<String>=db.query_row("SELECT id FROM supplement_records WHERE dataset_id=?1 AND main_record_id=?2 AND orphan=0",params![id,parent],|r|r.get(0)).optional().map_err(internal)?;
            let write: supplement::WriteRequest =
                serde_json::from_value(json!({"main_record_id":parent,"values":row.values}))
                    .map_err(internal)?;
            supplement::write_row(db, keys, &id, existing.as_deref(), &write)?;
        } else {
            let source = format!("sup_{}", Uuid::new_v4().simple());
            let parent = format!("unlinked_{}", Uuid::new_v4().simple());
            let mut link = row.link.clone();
            if link["mode"] == "id" {
                link["values"] = json!({"id":parent});
            }
            let (nonce, ciphertext) = seal_field(
                &keys.field,
                &source,
                "supplement",
                &Value::Object(row.values.clone()),
            )?;
            db.execute("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext,orphan) VALUES(?1,?2,?3,?4,?5,?6,1)",params![source,id,parent,link.to_string(),nonce,ciphertext]).map_err(internal)?;
        }
        extension_count += 1;
    }
    if !request.template_names.is_empty()
        && request.template_names.len() != request.package.templates.len()
    {
        return Err(bad_request("映射模板名称数量不一致"));
    }
    let mut imported_names = HashSet::new();
    for (index, template) in request.package.templates.iter().enumerate() {
        let name = request
            .template_names
            .get(index)
            .unwrap_or(&template.name)
            .trim();
        if name.is_empty() || !imported_names.insert(name) {
            return Err(bad_request("导入模板名称不能为空或重复"));
        }
        let existing: Option<(String, String)> = db
            .query_row(
                "SELECT dataset_id,mappings_json FROM import_templates WHERE name=?1",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(internal)?;
        let serialized = serde_json::to_string(&template.mappings).map_err(internal)?;
        if let Some((dataset, mappings)) = existing {
            if dataset != id || mappings != serialized {
                return Err(bad_request(format!(
                    "映射模板名称冲突：{name}，请重命名后再导入"
                )));
            }
        } else {
            db.execute(
                "INSERT INTO import_templates(name,dataset_id,mappings_json) VALUES(?1,?2,?3)",
                params![name, id, serialized],
            )
            .map_err(internal)?;
        }
    }
    supplement::sync(db, &id)?;
    catalog::sync_local(db,&id)?;
    if request.dataset_id.is_none() {
        if let Some(title)=schema.schema_name.as_deref() {
            if title.trim().is_empty() || title.chars().count()>120 {return Err(bad_request("数据模型名称无效"));}
            db.execute("UPDATE shared_schemas SET name=?2 WHERE id=(SELECT schema_id FROM datasets WHERE id=?1)",params![id,title]).map_err(internal)?;
        }
        if let Some(description)=schema.schema_description.as_deref() {
            db.execute("UPDATE shared_schemas SET description=?2 WHERE id=(SELECT schema_id FROM datasets WHERE id=?1)",params![id,description]).map_err(internal)?;
        }
        // Older native files carried a separate customer; preserve it as a label.
        if let Some(customer)=schema.customer.as_deref() {
            let mut ids=catalog::environments(db,&id)?.into_iter().map(|v|v.0).collect::<Vec<_>>();
            let label=catalog::environment_named(db,customer)?;
            if !ids.contains(&label) {ids.push(label);}
            catalog::set_environments(db,&id,&ids)?;
        }
        catalog::assign_metadata(db,&id)?;
    } else {catalog::assign_metadata(db,&id)?;}

    db.execute(
        "INSERT INTO audit_events(event,record_id) VALUES('dataset_transfer_import',?1)",
        [&id],
    )
    .map_err(internal)?;
    Ok(
        json!({"dataset_id":id,"category_path":category,"imported":inserted,"updated":updated,"skipped":skipped,"supplements":extension_count}),
    )
}

pub(super) async fn preview(
    State(state): State<AppState>,
    Json(request): Json<Request>,
) -> ApiResult<Json<Value>> {
    validate_package(&request.package)?;
    with_connection(&state,|db,keys|{
        let token=confirmation_token(db,&request)?;
        let diff=changes(db,&request)?;
        let tx=db.unchecked_transaction().map_err(internal)?;
        let result=apply(&tx,keys,&request)?;
        tx.rollback().map_err(internal)?;
        Ok(Json(json!({"changes":diff,"confirmation_token":token,"result":result,"field_count":request.package.schema.fields.len(),"record_count":request.package.records.len()})))
    }).await
}
pub(super) async fn import(
    State(state): State<AppState>,
    Json(request): Json<Request>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| {
        let token = confirmation_token(db, &request)?;
        if request.confirmation_token.as_deref() != Some(token.as_str()) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "文件或目标数据已变化，请重新预览并确认".into(),
            ));
        }
        if !changes(db, &request)?.is_empty() && !request.confirm_changes {
            return Err(bad_request("请确认结构变更的影响"));
        }
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = apply(&tx, keys, &request)?;
        tx.commit().map_err(internal)?;
        Ok(Json(result))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Connection, KeySet, Request) {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = KeySet {
            db: Zeroizing::new([1; 32]),
            field: Zeroizing::new([2; 32]),
            identity: Zeroizing::new([3; 32]),
        };
        let request:Request=serde_json::from_value(json!({"category_path":"测试/结构","environment":"stage","package":{
            "format":"securevault-dataset","version":1,"mode":"schema","schema":{
                "category_path":"来源/结构","environment":"prod","description":"## 多行\n\n```sql\nSELECT 1;\n```",
                "fields":[{"source_key":"code","zone":"indexes"},{"source_key":"id","zone":"display"},{"source_key":"notes","zone":"normal"},{"source_key":"secret","zone":"secrets"},{"source_key":"private","zone":"hidden"},{"source_key":"unused","zone":"ignore"}],
                "identity_fields":["code"],"list_fields":[{"source_key":"id","format":"multiline"}],"display_config":{"identifier_fields":["code"],"density":"full"},
                "supplement_fields":[{"source_key":"memo","zone":"normal"},{"source_key":"token","zone":"secrets"}]
            }
        }})).unwrap();
        (db, keys, request)
    }
    fn commit(db: &Connection, keys: &KeySet, request: &Request) -> Value {
        let tx = db.unchecked_transaction().unwrap();
        let result = apply(&tx, keys, request).unwrap();
        tx.commit().unwrap();
        result
    }

    #[test]
    fn dataset_names_round_trip_and_missing_legacy_names_preserve_existing_targets() {
        let (db,keys,mut request)=fixture();request.package.schema.name=Some("产品凭据".into());
        let id=commit(&db,&keys,&request)["dataset_id"].as_str().unwrap().to_owned();
        assert_eq!(read_schema(&db,&id).unwrap().name.as_deref(),Some("产品凭据"));
        let query:ExportQuery=serde_json::from_value(json!({"content":"schema"})).unwrap();
        let package=build_package(&db,&keys,&id,&query).unwrap();assert_eq!(package.schema.name.as_deref(),Some("产品凭据"));
        request.package=package;request.dataset_id=None;
        let second=commit(&db,&keys,&request)["dataset_id"].as_str().unwrap().to_owned();
        assert_eq!(read_schema(&db,&second).unwrap().name.as_deref(),Some("产品凭据"));
        request.dataset_id=Some(id.clone());request.package.schema.name=None;commit(&db,&keys,&request);
        assert_eq!(read_schema(&db,&id).unwrap().name.as_deref(),Some("产品凭据"));
        request.package.schema.name=Some("新的名称".into());assert!(changes(&db,&request).unwrap().iter().any(|c|c.contains("数据集名称")));commit(&db,&keys,&request);
        assert_eq!(read_schema(&db,&id).unwrap().name.as_deref(),Some("新的名称"));
        request.package.schema.name=Some(String::new());commit(&db,&keys,&request);
        assert_eq!(read_schema(&db,&id).unwrap().name.as_deref(),Some(""));
    }
    #[test]
    fn model_notes_survive_native_exchange_without_overwriting_existing_target_notes() {
        let (db,keys,mut request)=fixture();
        let description="## 数据来源\n\n```sql\nSELECT code FROM demo_products;\n```\n";
        request.package.schema.schema_description=Some(description.into());
        let first=commit(&db,&keys,&request);let id=first["dataset_id"].as_str().unwrap();
        let query:ExportQuery=serde_json::from_value(json!({"content":"schema"})).unwrap();
        let package=build_package(&db,&keys,id,&query).unwrap();assert_eq!(package.schema.schema_description.as_deref(),Some(description));
        request.package=package;request.dataset_id=None;let second=commit(&db,&keys,&request);
        assert_eq!(read_schema(&db,second["dataset_id"].as_str().unwrap()).unwrap().schema_description.as_deref(),Some(description));
        request.dataset_id=Some(id.into());request.package.schema.schema_description=Some("来源文件中的其他说明".into());commit(&db,&keys,&request);
        assert_eq!(read_schema(&db,id).unwrap().schema_description.as_deref(),Some(description));
    }
    #[test]
    fn empty_schema_round_trip_preserves_all_zones_description_display_and_supplement() {
        let (db, keys, request) = fixture();
        let result = commit(&db, &keys, &request);
        let id = result["dataset_id"].as_str().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM records", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            0
        );
        let query: ExportQuery = serde_json::from_value(json!({"content":"schema"})).unwrap();
        let package = build_package(&db, &keys, id, &query).unwrap();
        assert_eq!(
            serde_json::to_value(&package.schema.fields).unwrap(),
            serde_json::to_value(&request.package.schema.fields).unwrap()
        );
        assert_eq!(
            package.schema.description,
            request.package.schema.description
        );
        assert_eq!(
            package.schema.display_config.identifier_fields,
            vec!["code"]
        );
        assert_eq!(package.schema.display_config.density, "full");
        assert_eq!(package.schema.supplement_fields.len(), 2);
        assert!(package.records.is_empty());
        let mut target = request;
        target.package = package;
        target.category_path = "新环境/结构".into();
        let next = commit(&db, &keys, &target);
        assert_ne!(next["dataset_id"], result["dataset_id"]);
    }

    #[test]
    fn native_records_preserve_types_business_id_and_omitted_secret_on_update() {
        let (db, keys, mut request) = fixture();
        request.package.mode = "package".into();
        request.package.records=serde_json::from_value(json!([{"source_id":"source-1","values":{"code":"001","id":"business-id","notes":{"zero":0,"flag":false,"null":null},"secret":"DEMO_ONLY_ORIGINAL","private":false}}])).unwrap();
        let result = commit(&db, &keys, &request);
        let id = result["dataset_id"].as_str().unwrap();
        let system_id: String = db
            .query_row("SELECT id FROM records WHERE dataset_id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_ne!(system_id, "business-id");
        let query: ExportQuery = serde_json::from_value(json!({"content":"package"})).unwrap();
        let mut package = build_package(&db, &keys, id, &query).unwrap();
        assert!(!package.records[0].values.contains_key("secret"));
        assert!(package.records[0].omitted_fields.contains(&"secret".into()));
        assert!(
            package.records[0]
                .omitted_fields
                .contains(&"private".into())
        );
        package.records[0]
            .values
            .insert("notes".into(), Value::Null);
        request.package = package;
        request.dataset_id = Some(id.into());
        let result = commit(&db, &keys, &request);
        assert_eq!(result["updated"], 1);
        let values = supplement::main_values(&db, &keys, &system_id).unwrap();
        assert_eq!(values["notes"], Value::Null);
        assert_eq!(values["secret"], "DEMO_ONLY_ORIGINAL");
        assert_eq!(values["private"], false);
        assert_eq!(values["id"], "business-id");
    }

    #[test]
    fn preview_transaction_and_failed_package_leave_no_partial_schema_or_records() {
        let (db, keys, mut request) = fixture();
        let tx = db.unchecked_transaction().unwrap();
        apply(&tx, &keys, &request).unwrap();
        tx.rollback().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM datasets", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            0
        );
        request.package.mode = "package".into();
        request.package.records=serde_json::from_value(json!([{"source_id":"good","values":{"code":"001"}},{"source_id":"bad","values":{"notes":"no KEY"}}])).unwrap();
        {
            let tx = db.unchecked_transaction().unwrap();
            assert!(apply(&tx, &keys, &request).is_err());
        }
        for table in ["datasets", "records", "supplement_schemas", "audit_events"] {
            assert_eq!(
                db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, u32>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn supplement_links_remap_to_new_system_ids_and_keep_unlinked_rows() {
        let (db, keys, mut request) = fixture();
        request.package.mode = "package".into();
        request.package.records =
            serde_json::from_value(json!([{"source_id":"old-parent","values":{"code":"001"}}]))
                .unwrap();
        request.package.supplements=serde_json::from_value(json!([
            {"source_id":"old-linked","main_source_id":"old-parent","values":{"memo":"independent"},"orphan":false,"link":{"mode":"indexes","fields":["code"],"values":{"code":"001"}}},
            {"source_id":"old-orphan","main_source_id":"deleted","values":{"memo":"keep me"},"orphan":true,"link":{"mode":"indexes","fields":["code"],"values":{"code":"gone"}}}
        ])).unwrap();
        let result = commit(&db, &keys, &request);
        let id = result["dataset_id"].as_str().unwrap();
        let rows = supplement::rows(&db, &keys, id, None).unwrap();
        assert_eq!(rows.len(), 2);
        let linked = rows.iter().find(|row| row["orphan"] == false).unwrap();
        assert_ne!(linked["main_record_id"], "old-parent");
        assert_eq!(linked["values"]["memo"], "independent");
        assert!(
            rows.iter()
                .any(|row| row["orphan"] == true && row["values"]["memo"] == "keep me")
        );
    }

    #[test]
    fn existing_schema_keeps_target_only_fields_and_rejects_unknown_versions_and_unsafe_identifiers()
     {
        let (db, keys, mut request) = fixture();
        let result = commit(&db, &keys, &request);
        request.dataset_id = Some(result["dataset_id"].as_str().unwrap().into());
        request
            .package
            .schema
            .fields
            .retain(|field| field.source_key != "notes");
        commit(&db, &keys, &request);
        assert!(
            read_schema(&db, request.dataset_id.as_deref().unwrap())
                .unwrap()
                .fields
                .iter()
                .any(|field| field.source_key == "notes")
        );
        request.package.version = 2;
        assert!(validate_package(&request.package).is_err());
        request.package.version = 1;
        request.package.schema.display_config.identifier_fields = vec!["secret".into()];
        assert!(validate_package(&request.package).is_err());
    }

    #[test]
    fn confirmation_detects_record_and_schema_changes_after_preview() {
        let (db, keys, mut request) = fixture();
        let result = commit(&db, &keys, &request);
        request.dataset_id = Some(result["dataset_id"].as_str().unwrap().into());
        let before = confirmation_token(&db, &request).unwrap();
        let write: supplement::WriteRequest =
            serde_json::from_value(json!({"values":{"code":"new"}})).unwrap();
        supplement::write_main(
            &db,
            &keys,
            request.dataset_id.as_deref().unwrap(),
            None,
            &write,
        )
        .unwrap();
        assert_ne!(before, confirmation_token(&db, &request).unwrap());
        let before = confirmation_token(&db, &request).unwrap();
        db.execute("UPDATE datasets SET description='changed'", [])
            .unwrap();
        assert_ne!(before, confirmation_token(&db, &request).unwrap());
    }

    #[test]
    fn raw_native_json_keeps_large_integer_values_exact() {
        let (db, keys, mut request) = fixture();
        request.package.mode = "package".into();
        request.package.records = serde_json::from_value(
            json!([{"source_id":"large","values":{"code":"LARGE","notes":9007199254740993u64}}]),
        )
        .unwrap();
        let mut body = serde_json::to_value(&request).unwrap();
        body["package"] = Value::String(serde_json::to_string(&request.package).unwrap());
        let request: Request = serde_json::from_value(body).unwrap();
        let result = commit(&db, &keys, &request);
        let record_id: String = db
            .query_row(
                "SELECT id FROM records WHERE dataset_id=?1",
                [result["dataset_id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            supplement::main_values(&db, &keys, &record_id).unwrap()["notes"].as_u64(),
            Some(9007199254740993)
        );
    }

    #[test]
    fn active_export_keeps_only_supplements_of_exported_parents() {
        let (db, keys, mut request) = fixture();
        request.package.mode = "package".into();
        request.package.records = serde_json::from_value(json!([
            {"source_id":"active","values":{"code":"A"}},
            {"source_id":"expired","values":{"code":"B"},"expired":true}
        ]))
        .unwrap();
        request.package.supplements=serde_json::from_value(json!([
            {"source_id":"sa","main_source_id":"active","values":{"memo":"active"},"orphan":false,"link":{"mode":"indexes","fields":["code"],"values":{"code":"A"}}},
            {"source_id":"sb","main_source_id":"expired","values":{"memo":"expired"},"orphan":false,"link":{"mode":"indexes","fields":["code"],"values":{"code":"B"}}}
        ])).unwrap();
        let result = commit(&db, &keys, &request);
        let query: ExportQuery = serde_json::from_value(
            json!({"content":"package","include_supplements":true,"include_expired":false}),
        )
        .unwrap();
        let package =
            build_package(&db, &keys, result["dataset_id"].as_str().unwrap(), &query).unwrap();
        assert_eq!(package.record_scope, "active");
        assert_eq!(package.records.len(), 1);
        assert_eq!(package.supplements.len(), 1);
        assert_eq!(
            package.records[0].source_id,
            package.supplements[0].main_source_id
        );
        validate_package(&package).unwrap();
    }

    #[test]
    fn template_conflicts_roll_back_and_explicit_renaming_allows_import() {
        let (db, keys, mut request) = fixture();
        request.package.templates = serde_json::from_value(
            json!([{"name":"fixture","mappings":[{"source_key":"source","target_key":"code"}]}]),
        )
        .unwrap();
        commit(&db, &keys, &request);
        {
            let tx = db.unchecked_transaction().unwrap();
            assert!(apply(&tx, &keys, &request).is_err());
        }
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM datasets", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            1
        );
        request.template_names = vec!["fixture-copy".into()];
        commit(&db, &keys, &request);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM import_templates", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            2
        );
    }
}
