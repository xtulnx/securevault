use super::*;

// Shared schemas are authoritative; the existing dataset columns are materialized
// copies for the search, interchange and client APIs. All definition writes pass
// through this module and run in the caller's transaction.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Definition {
    pub fields: Vec<FieldDefinition>,
    pub identity_fields: Vec<String>,
    pub list_fields: Vec<ListFieldDefinition>,
    pub display_config: DisplayConfig,
    pub supplement_fields: Vec<FieldDefinition>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PublishRequest {
    #[serde(default)]
    schema_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    definition: Option<Definition>,
    #[serde(default)]
    dataset_ids: Vec<String>,
    #[serde(default)]
    confirmation_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NamedRequest {
    name: String,
}

fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "数据模型、标签或数据集不存在".into())
}
fn name(value: &str) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err(bad_request("名称需为 1 至 120 个字符，不能包含控制字符"));
    }
    Ok(value.to_owned())
}
fn table(kind: &str) -> ApiResult<&'static str> {
    match kind {
        "environments" => Ok("environments"),
        _ => Err(not_found()),
    }
}
fn exists(db: &Connection, table: &str, id: &str) -> ApiResult<()> {
    if !db
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
            [id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(internal)?
    {
        return Err(not_found());
    }
    Ok(())
}

pub(super) fn initialize(db: &Connection) -> ApiResult<()> {
    let tx = db;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS shared_schemas(id TEXT PRIMARY KEY,name TEXT NOT NULL,definition_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS environments(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS dataset_environments(dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,environment_id TEXT NOT NULL REFERENCES environments(id),position INTEGER NOT NULL CHECK(position>=0),PRIMARY KEY(dataset_id,environment_id),UNIQUE(dataset_id,position));
      CREATE INDEX IF NOT EXISTS ix_dataset_environments_environment ON dataset_environments(environment_id,dataset_id);").map_err(internal)?;
    for (column, target) in [
        ("schema_id", "shared_schemas"),
        ("customer_id", "customers"),
        ("environment_id", "environments"),
    ] {
        let present: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('datasets') WHERE name=?1)",
                [column],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if !present {
            tx.execute(
                &format!("ALTER TABLE datasets ADD COLUMN {column} TEXT REFERENCES {target}(id)"),
                [],
            )
            .map_err(internal)?;
        }
        tx.execute(
            &format!("CREATE INDEX IF NOT EXISTS ix_datasets_{column} ON datasets({column})"),
            [],
        )
        .map_err(internal)?;
    }
    let has_description:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('shared_schemas') WHERE name='description')",[],|r|r.get(0)).map_err(internal)?;
    if !has_description {
        tx.execute(
            "ALTER TABLE shared_schemas ADD COLUMN description TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(internal)?;
    }
    upgrade_rows(&tx)?;
    tx.execute_batch("PRAGMA user_version=4")
        .map_err(internal)?;
    Ok(())
}

// Idempotent and metadata-only: no record ids, ciphertext, keys or grants change.
// Never infer customers from directory names or merge schemas by similarity.
pub(super) fn upgrade_rows(db: &Connection) -> ApiResult<()> {
    let ids = dataset_ids(
        db,
        "SELECT id FROM datasets WHERE schema_id IS NULL ORDER BY id",
        None,
    )?;
    for id in ids {
        ensure_dataset(db, &id)?;
    }
    let rows: Vec<(String, String)> = {
        let mut s = db.prepare("SELECT id,environment FROM datasets WHERE environment_id IS NULL AND environment IS NOT NULL AND environment<>''").map_err(internal)?;
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(internal)?
            .collect::<Result<_, _>>()
            .map_err(internal)?
    };
    for (id, environment) in rows {
        let env = environment_named(db, &environment)?;
        db.execute(
            "UPDATE datasets SET environment_id=?2 WHERE id=?1",
            params![id, env],
        )
        .map_err(internal)?;
    }
    db.execute("INSERT INTO dataset_environments(dataset_id,environment_id,position) SELECT d.id,d.environment_id,0 FROM datasets d WHERE d.environment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_environments de WHERE de.dataset_id=d.id)",[]).map_err(internal)?;
    let legacy: Vec<(String, String)> = {
        let mut q = db
            .prepare("SELECT d.id,c.name FROM datasets d JOIN customers c ON c.id=d.customer_id")
            .map_err(internal)?;
        let rows = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(internal)?;
        rows.collect::<Result<_, _>>().map_err(internal)?
    };
    for (id, customer) in legacy {
        let label = environment_named(db, &customer)?;
        let mut ids = environments(db, &id)?
            .into_iter()
            .map(|v| v.0)
            .collect::<Vec<_>>();
        if !ids.contains(&label) {
            ids.push(label);
        }
        set_environments(db, &id, &ids)?;
        db.execute("UPDATE datasets SET customer_id=NULL WHERE id=?1", [&id])
            .map_err(internal)?;
    }
    Ok(())
}

fn dataset_ids(db: &Connection, sql: &str, id: Option<&str>) -> ApiResult<Vec<String>> {
    let mut s = db.prepare(sql).map_err(internal)?;
    let values: Vec<&str> = id.into_iter().collect();
    s.query_map(rusqlite::params_from_iter(values), |r| r.get(0))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)
}
pub(super) fn read_instance(db: &Connection, id: &str) -> ApiResult<Definition> {
    let (fields,identity,list,config): (String,String,String,String) = db.query_row(
        "SELECT fields_json,identity_fields_json,list_fields_json,display_config_json FROM datasets WHERE id=?1",[id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(internal)?.ok_or_else(not_found)?;
    Ok(Definition {
        fields: serde_json::from_str(&fields).map_err(internal)?,
        identity_fields: serde_json::from_str(&identity).map_err(internal)?,
        list_fields: serde_json::from_str(&list).map_err(internal)?,
        display_config: serde_json::from_str(&config).map_err(internal)?,
        supplement_fields: supplement::fields(db, id)?,
    })
}
pub(super) fn read(db: &Connection, id: &str) -> ApiResult<Definition> {
    let raw: String = db
        .query_row(
            "SELECT definition_json FROM shared_schemas WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(not_found)?;
    serde_json::from_str(&raw).map_err(internal)
}
fn clean(mut definition: Definition) -> Definition {
    for field in definition
        .fields
        .iter_mut()
        .chain(definition.supplement_fields.iter_mut())
    {
        field.previous_source_key = None;
    }
    definition
}
fn same(a: &Definition, b: &Definition) -> ApiResult<bool> {
    Ok(serde_json::to_value(clean(a.clone())).map_err(internal)?
        == serde_json::to_value(clean(b.clone())).map_err(internal)?)
}
fn validate(d: &Definition) -> ApiResult<()> {
    validate_schema(&d.fields, &d.identity_fields, &d.list_fields)?;
    validate_display_config(&d.display_config, &d.fields)?;
    validate_schema(&d.supplement_fields, &[], &[])
}
pub(super) fn ensure_dataset(db: &Connection, id: &str) -> ApiResult<String> {
    let (schema, category): (Option<String>, String) = db
        .query_row(
            "SELECT schema_id,category_path FROM datasets WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(not_found)?;
    if let Some(schema) = schema {
        return Ok(schema);
    }
    let schema = format!("schema_{}", Uuid::new_v4().simple());
    let d = read_instance(db, id)?;
    db.execute(
        "INSERT INTO shared_schemas(id,name,definition_json) VALUES(?1,?2,?3)",
        params![
            schema,
            category,
            serde_json::to_string(&clean(d)).map_err(internal)?
        ],
    )
    .map_err(internal)?;
    db.execute(
        "UPDATE datasets SET schema_id=?2 WHERE id=?1",
        params![id, schema],
    )
    .map_err(internal)?;
    Ok(schema)
}
pub(super) fn linked(db: &Connection, schema: &str) -> ApiResult<Vec<String>> {
    dataset_ids(
        db,
        "SELECT id FROM datasets WHERE schema_id=?1 ORDER BY id",
        Some(schema),
    )
}
pub(super) fn require_local_edit(db: &Connection, id: &str, next: &Definition) -> ApiResult<()> {
    let schema = ensure_dataset(db, id)?;
    if linked(db, &schema)?.len() > 1 && !same(&read(db, &schema)?, next)? {
        return Err(bad_request(
            "该模型由多个数据集使用，请在数据模型中预览并发布变更",
        ));
    }
    Ok(())
}
pub(super) fn sync_local(db: &Connection, id: &str) -> ApiResult<()> {
    let schema = ensure_dataset(db, id)?;
    let next = read_instance(db, id)?;
    require_local_edit(db, id, &next)?;
    let old = read(db, &schema)?;
    if !same(&old, &next)? {
        db.execute(
            "UPDATE shared_schemas SET definition_json=?2,version=version+1 WHERE id=?1",
            params![
                schema,
                serde_json::to_string(&clean(next)).map_err(internal)?
            ],
        )
        .map_err(internal)?;
    }
    Ok(())
}
pub(super) fn environment_named(db: &Connection, value: &str) -> ApiResult<String> {
    // Preserve legacy spelling verbatim during upgrade and compatibility imports.
    if let Some(id) = db
        .query_row("SELECT id FROM environments WHERE name=?1", [value], |r| {
            r.get(0)
        })
        .optional()
        .map_err(internal)?
    {
        return Ok(id);
    }
    let id = format!("env_{}", Uuid::new_v4().simple());
    db.execute(
        "INSERT INTO environments(id,name) VALUES(?1,?2)",
        params![id, value],
    )
    .map_err(internal)?;
    Ok(id)
}
pub(super) fn assign_metadata(db: &Connection, id: &str) -> ApiResult<()> {
    // Compatibility for older internal imports that only populated the first label.
    if environments(db, id)?.is_empty() {
        let environment: Option<String> = db
            .query_row("SELECT environment FROM datasets WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(internal)?;
        if let Some(value) = environment.filter(|e| !e.is_empty()) {
            let env_id = environment_named(db, &value)?;
            set_environments(db, id, &[env_id])?;
        }
    }
    Ok(())
}

// None leaves an existing dataset untouched; Some([]) explicitly clears labels.
// New names and associations are resolved inside the dataset save transaction.
pub(super) fn resolve_environments(
    db: &Connection,
    ids: Option<&[String]>,
    names: Option<&[String]>,
    legacy_id: Option<&str>,
    legacy_name: Option<&str>,
    clear: bool,
) -> ApiResult<Option<Vec<String>>> {
    let multiple = ids.is_some() || names.is_some();
    if multiple && (legacy_id.is_some() || legacy_name.is_some() || clear)
        || clear && legacy_id.is_some()
    {
        return Err(bad_request("不能同时指定环境列表和旧环境或清除选项"));
    }
    if multiple {
        if ids.map_or(0, |v| v.len()) + names.map_or(0, |v| v.len()) > 64 {
            return Err(bad_request("最多关联 64 个环境"));
        }
        let mut result = Vec::new();
        for id in ids.unwrap_or_default() {
            exists(db, "environments", id)?;
            if !result.contains(id) {
                result.push(id.clone());
            }
        }
        for value in names.unwrap_or_default() {
            // Preserve an existing legacy name verbatim; validation/trim applies only to new names.
            let existing: Option<String> = db.query_row("SELECT id FROM environments WHERE name=?1", [value], |r| r.get(0)).optional().map_err(internal)?;
            let id = if let Some(id) = existing { id } else { environment_named(db, &name(value)?)? };
            if !result.contains(&id) {
                result.push(id);
            }
        }
        return Ok(Some(result));
    }
    if clear {
        return Ok(Some(Vec::new()));
    }
    if let Some(id) = legacy_id {
        exists(db, "environments", id)?;
        return Ok(Some(vec![id.to_owned()]));
    }
    legacy_name
        .map(|value| {
            if value.trim().is_empty() {
                Ok(Vec::new())
            } else {
                Ok(vec![environment_named(db, value.trim())?])
            }
        })
        .transpose()
}

pub(super) fn environments(db: &Connection, dataset: &str) -> ApiResult<Vec<(String, String)>> {
    let mut s=db.prepare("SELECT e.id,e.name FROM dataset_environments de JOIN environments e ON e.id=de.environment_id WHERE de.dataset_id=?1 ORDER BY de.position").map_err(internal)?;
    let rows = s
        .query_map([dataset], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(internal)?;
    rows.collect::<Result<_, _>>().map_err(internal)
}
pub(super) fn environment_map(
    db: &Connection,
) -> ApiResult<std::collections::HashMap<String, Vec<String>>> {
    let mut result = std::collections::HashMap::new();
    let mut s=db.prepare("SELECT de.dataset_id,e.name FROM dataset_environments de JOIN environments e ON e.id=de.environment_id ORDER BY de.dataset_id,de.position").map_err(internal)?;
    for row in s
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?
    {
        let (dataset, name) = row.map_err(internal)?;
        result.entry(dataset).or_insert_with(Vec::new).push(name);
    }
    Ok(result)
}
pub(super) fn set_environments(db: &Connection, dataset: &str, ids: &[String]) -> ApiResult<()> {
    let first = ids.first();
    let first_name = first.map(|id| environment_name(db, id)).transpose()?;
    db.execute(
        "DELETE FROM dataset_environments WHERE dataset_id=?1",
        [dataset],
    )
    .map_err(internal)?;
    for (position, id) in ids.iter().enumerate() {
        db.execute(
            "INSERT INTO dataset_environments(dataset_id,environment_id,position) VALUES(?1,?2,?3)",
            params![dataset, id, position as i64],
        )
        .map_err(internal)?;
    }
    // Keep old readers working with the first label. Identity and grants use the dataset id.
    db.execute(
        "UPDATE datasets SET environment_id=?2,environment=?3 WHERE id=?1",
        params![dataset, first, first_name],
    )
    .map_err(internal)?;
    db.execute(
        "UPDATE records SET environment=?2 WHERE dataset_id=?1",
        params![dataset, first_name],
    )
    .map_err(internal)?;
    Ok(())
}

pub(super) fn environment_name(db: &Connection, id: &str) -> ApiResult<String> {
    db.query_row("SELECT name FROM environments WHERE id=?1", [id], |r| {
        r.get(0)
    })
    .optional()
    .map_err(internal)?
    .ok_or_else(not_found)
}

pub(super) fn enrich(db: &Connection, value: &mut Value) -> ApiResult<()> {
    let id = value
        .get("id")
        .or_else(|| value.get("dataset_id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let row: (Option<String>,Option<String>,Option<String>,Option<i64>,String) = db.query_row(
        "SELECT d.schema_id,d.environment_id,s.name,s.version,d.name FROM datasets d LEFT JOIN shared_schemas s ON s.id=d.schema_id WHERE d.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(internal)?;
    let environments = environments(db, id)?;
    value["name"] = json!(row.4);
    value["schema_id"] = json!(row.0);
    value["environment_id"] = json!(row.1);
    value["schema_name"] = json!(row.2);
    value["schema_version"] = json!(row.3);
    value["environment_ids"] = json!(environments.iter().map(|v| &v.0).collect::<Vec<_>>());
    value["environments"] = json!(environments.iter().map(|v| &v.1).collect::<Vec<_>>());
    Ok(())
}

pub(super) async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    with_connection(&state,|db,_| {
        let named = |table: &str| -> ApiResult<Vec<Value>> {
            let mut s = db.prepare(&format!("SELECT id,name FROM {table} ORDER BY name,id")).map_err(internal)?;
            s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?}))).map_err(internal)?.collect::<Result<_,_>>().map_err(internal)
        };
        let mut s = db.prepare("SELECT id,name,definition_json,version,description FROM shared_schemas ORDER BY name,id").map_err(internal)?;
        let rows: Vec<(String,String,String,i64,String)> = s.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(internal)?.collect::<Result<_,_>>().map_err(internal)?;
        let schemas = rows.into_iter().map(|(id,name,raw,version,description)|Ok(json!({"dataset_ids":linked(db,&id)?,"id":id,"name":name,"description":description,"version":version,"definition":serde_json::from_str::<Value>(&raw).map_err(internal)?}))).collect::<ApiResult<Vec<_>>>()?;
        Ok(Json(json!({"schemas":schemas,"environments":named("environments")?})))
    }).await
}
pub(super) async fn create_named(
    State(state): State<AppState>,
    Path(kind): Path<String>,
    Json(request): Json<NamedRequest>,
) -> ApiResult<Json<Value>> {
    let table = table(&kind)?;
    let name = name(&request.name)?;
    with_connection(&state, |db, _| {
        let id = format!("env_{}", Uuid::new_v4().simple());
        db.execute(
            &format!("INSERT INTO {table}(id,name) VALUES(?1,?2)"),
            params![id, name],
        )
        .map_err(|_| bad_request("名称已存在"))?;
        Ok(Json(json!({"id":id,"name":name})))
    })
    .await
}
pub(super) async fn rename_named(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    Json(request): Json<NamedRequest>,
) -> ApiResult<Json<Value>> {
    let table = table(&kind)?;
    let name = name(&request.name)?;
    with_connection(&state, |db, _| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        exists(&tx, table, &id)?;
        tx.execute(
            &format!("UPDATE {table} SET name=?2 WHERE id=?1"),
            params![id, name],
        )
        .map_err(|_| bad_request("名称已存在"))?;
        if table == "environments" {
            tx.execute("UPDATE datasets SET environment=?2 WHERE environment_id=?1",params![id,name]).map_err(internal)?;
            tx.execute("UPDATE records SET environment=?2 WHERE dataset_id IN (SELECT id FROM datasets WHERE environment_id=?1)",params![id,name]).map_err(internal)?;
        }
        tx.commit().map_err(internal)?;
        Ok(Json(json!({"saved":true})))
    })
    .await
}
pub(super) async fn delete_named(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let table = table(&kind)?;
    with_connection(&state, |db, _| {
        exists(db, table, &id)?;
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM dataset_environments WHERE environment_id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if count > 0 {
            return Err(bad_request("标签仍被数据集引用，请先移除关联"));
        }
        db.execute(&format!("DELETE FROM {table} WHERE id=?1"), [&id])
            .map_err(internal)?;
        Ok(Json(json!({"deleted":true})))
    })
    .await
}
fn request_definition(db: &Connection, request: &PublishRequest) -> ApiResult<Definition> {
    let definition = if let Some(d) = &request.definition {
        d.clone()
    } else if let Some(id) = &request.schema_id {
        read(db, id)?
    } else if let Some(id) = request.dataset_ids.first() {
        read_instance(db, id)?
    } else {
        Definition::default()
    };
    validate(&definition)?;
    Ok(definition)
}
fn participants(db: &Connection, request: &PublishRequest) -> ApiResult<Vec<String>> {
    let mut ids = if let Some(id) = &request.schema_id {
        exists(db, "shared_schemas", id)?;
        linked(db, id)?
    } else {
        Vec::new()
    };
    if request.dataset_ids.len() > 1024 {
        return Err(bad_request("一次最多合并 1024 个数据集"));
    }
    for id in &request.dataset_ids {
        exists(db, "datasets", id)?;
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    ids.sort();
    Ok(ids)
}
fn check_kept(old: &[FieldDefinition], next: &[FieldDefinition]) -> ApiResult<()> {
    let mut consumed = std::collections::HashSet::new();
    for field in next {
        let source = field
            .previous_source_key
            .as_deref()
            .filter(|source| old.iter().any(|f| f.source_key == *source))
            .unwrap_or(&field.source_key);
        if !consumed.insert(source) {
            return Err(bad_request("多个字段不能引用同一个原字段"));
        }
    }
    for field in old {
        if !consumed.contains(field.source_key.as_str()) {
            return Err(bad_request(format!(
                "目标模型缺少字段 {}，请先补齐字段；需要清除值时显式改为忽略",
                field.source_key
            )));
        }
    }
    Ok(())
}

fn field_changes(old: &[FieldDefinition], next: &[FieldDefinition], prefix: &str) -> Vec<String> {
    let mut result = Vec::new();
    for f in next {
        let source = f.previous_source_key.as_deref().unwrap_or(&f.source_key);
        if let Some(previous) = old.iter().find(|p| p.source_key == source) {
            if source != f.source_key {
                result.push(format!("{prefix}{source} → {}（重命名）", f.source_key));
            }
            if previous.zone != f.zone {
                result.push(format!(
                    "{prefix}{}：{} → {}{}",
                    f.source_key,
                    previous.zone,
                    f.zone,
                    if f.zone == "ignore" {
                        "（清除已有值）"
                    } else {
                        ""
                    }
                ));
            }
        } else {
            result.push(format!("{prefix}新增字段 {}（{}）", f.source_key, f.zone));
        }
    }
    result
}
fn describe(
    db: &Connection,
    request: &PublishRequest,
    definition: &Definition,
) -> ApiResult<Vec<Value>> {
    participants(db,request)?.into_iter().map(|id|{
        let old=read_instance(db,&id)?; check_kept(&old.fields,&definition.fields)?; check_kept(&old.supplement_fields,&definition.supplement_fields)?;
        let mut changes=field_changes(&old.fields,&definition.fields,"");
        if let (Some(description),Some(schema))=(&request.description,&request.schema_id) {
            let previous:String=db.query_row("SELECT description FROM shared_schemas WHERE id=?1",[schema],|r|r.get(0)).map_err(internal)?;
            if previous!=*description {changes.push("更新模型说明（用途、提取方法等共用备注）".into());}
        } changes.extend(field_changes(&old.supplement_fields,&definition.supplement_fields,"附表."));
        if old.identity_fields!=definition.identity_fields {changes.push("逻辑 KEY 变化，重新计算去重标识与附表关联".into());}
        if serde_json::to_value(&old.list_fields).map_err(internal)?!=serde_json::to_value(&definition.list_fields).map_err(internal)? || serde_json::to_value(&old.display_config).map_err(internal)?!=serde_json::to_value(&definition.display_config).map_err(internal)? {changes.push("更新列表展示与记录标识".into());}
        if serde_json::to_value(clean(old.clone())).map_err(internal)?!=serde_json::to_value(clean(definition.clone())).map_err(internal)? && changes.is_empty() {changes.push("更新字段名称、顺序或用途配置".into());}
        let mut value=json!({"id":id,"changes":changes,"record_count":db.query_row("SELECT COUNT(*) FROM records WHERE dataset_id=?1",[&id],|r|r.get::<_,i64>(0)).map_err(internal)?,"supplement_count":db.query_row("SELECT COUNT(*) FROM supplement_records WHERE dataset_id=?1",[&id],|r|r.get::<_,i64>(0)).map_err(internal)?});
        let (category,env):(String,Option<String>)=db.query_row("SELECT category_path,environment FROM datasets WHERE id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(internal)?;
        value["category_path"]=json!(category);value["environment"]=json!(env);enrich(db,&mut value)?;Ok(value)
    }).collect()
}
// Bind preview to the exact request and all relevant metadata and encrypted data.
// Values use length-delimited SQLite types, avoiding concatenation ambiguities.
fn token(db: &Connection, keys: &KeySet, request: &PublishRequest) -> ApiResult<String> {
    let mut payload = serde_json::to_value(request).map_err(internal)?;
    payload["confirmation_token"] = Value::Null;
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&keys.identity[..]).map_err(internal)?;
    mac.update(b"shared-schema-publish-v1");
    mac.update(&serde_json::to_vec(&payload).map_err(internal)?);
    for (table, order) in [
        ("shared_schemas", "id"),
        ("datasets", "id"),
        ("customers", "id"),
        ("environments", "id"),
        ("dataset_environments", "dataset_id,position"),
        ("records", "id"),
        ("protected_fields", "record_id,source_key"),
        ("supplement_schemas", "dataset_id"),
        ("supplement_records", "id"),
    ] {
        mac.update(table.as_bytes());
        let mut s = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
            .map_err(internal)?;
        let count = s.column_count();
        let mut rows = s.query([]).map_err(internal)?;
        while let Some(row) = rows.next().map_err(internal)? {
            mac.update(b"row");
            for i in 0..count {
                let value = row.get_ref(i).map_err(internal)?;
                let bytes = match value {
                    rusqlite::types::ValueRef::Null => vec![0],
                    rusqlite::types::ValueRef::Integer(n) => {
                        [vec![1], n.to_le_bytes().to_vec()].concat()
                    }
                    rusqlite::types::ValueRef::Real(n) => {
                        [vec![2], n.to_le_bytes().to_vec()].concat()
                    }
                    rusqlite::types::ValueRef::Text(t) => [vec![3], t.to_vec()].concat(),
                    rusqlite::types::ValueRef::Blob(b) => [vec![4], b.to_vec()].concat(),
                };
                mac.update(&(bytes.len() as u64).to_le_bytes());
                mac.update(&bytes);
            }
        }
    }
    Ok(hex::encode(mac.finalize().into_bytes()))
}
fn apply_publish(
    db: &Connection,
    keys: &KeySet,
    request: &PublishRequest,
    d: &Definition,
) -> ApiResult<Value> {
    let ids = participants(db, request)?;
    let schema = if let Some(id) = &request.schema_id {
        id.clone()
    } else {
        format!("schema_{}", Uuid::new_v4().simple())
    };
    let title = if let Some(title) = &request.name {
        name(title)?
    } else if request.schema_id.is_some() {
        db.query_row(
            "SELECT name FROM shared_schemas WHERE id=?1",
            [&schema],
            |r| r.get(0),
        )
        .map_err(internal)?
    } else {
        return Err(bad_request("请填写数据模型名称"));
    };
    let description = if let Some(description) = &request.description {
        description.clone()
    } else if request.schema_id.is_some() {
        db.query_row(
            "SELECT description FROM shared_schemas WHERE id=?1",
            [&schema],
            |r| r.get(0),
        )
        .map_err(internal)?
    } else {
        String::new()
    };
    // Check every instance before changing anything, then migrate within one transaction.
    describe(db, request, d)?;
    if request.schema_id.is_none() {
        db.execute(
            "INSERT INTO shared_schemas(id,name,definition_json,description) VALUES(?1,?2,?3,?4)",
            params![
                schema,
                title,
                serde_json::to_string(&clean(d.clone())).map_err(internal)?,
                description
            ],
        )
        .map_err(internal)?;
    }
    for id in &ids {
        let old = read_instance(db, id)?;
        let renames = |before: &[FieldDefinition], after: &[FieldDefinition]| {
            after.iter().any(|field| {
                field.previous_source_key.as_deref().is_some_and(|source| {
                    source != field.source_key && before.iter().any(|f| f.source_key == source)
                })
            })
        };
        if !same(&old, d)?
            || renames(&old.fields, &d.fields)
            || renames(&old.supplement_fields, &d.supplement_fields)
        {
            let update:DatasetUpdate=serde_json::from_value(json!({"fields":d.fields,"identity_fields":d.identity_fields,"list_fields":d.list_fields,"display_config":d.display_config})).map_err(internal)?;
            update_dataset_instance(db, keys, id, update)?;
            supplement::save_schema_in_connection(db, keys, id, &d.supplement_fields)?;
        }
        db.execute(
            "UPDATE datasets SET schema_id=?2 WHERE id=?1",
            params![id, schema],
        )
        .map_err(internal)?;
    }
    if request.schema_id.is_some() {
        db.execute(
            "UPDATE shared_schemas SET name=?2,definition_json=?3,description=?4,version=version+1 WHERE id=?1",
            params![
                schema,
                title,
                serde_json::to_string(&clean(d.clone())).map_err(internal)?,
                description
            ],
        )
        .map_err(internal)?;
    }
    db.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('shared_schema_published',?1,?2)",params![schema,ids.join(",")]).map_err(internal)?;
    Ok(json!({"schema_id":schema,"dataset_ids":ids,"saved":true}))
}
pub(super) async fn preview(
    State(state): State<AppState>,
    Json(request): Json<PublishRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| {
        let d = request_definition(db, &request)?;
        let changes = describe(db, &request, &d)?;
        let token = token(db, keys, &request)?;
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = apply_publish(&tx, keys, &request, &d)?;
        tx.rollback().map_err(internal)?;
        Ok(Json(
            json!({"changes":changes,"confirmation_token":token,"result":result}),
        ))
    })
    .await
}
pub(super) async fn publish(
    State(state): State<AppState>,
    Json(request): Json<PublishRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| Ok(Json(commit(db, keys, &request)?))).await
}

// Reject inconsistent logical backups instead of silently choosing one definition.
pub(super) fn validate_relations(db: &Connection) -> ApiResult<()> {
    for id in dataset_ids(db, "SELECT id FROM datasets ORDER BY id", None)? {
        let schema = ensure_dataset(db, &id)?;
        if !same(&read(db, &schema)?, &read_instance(db, &id)?)? {
            return Err(bad_request("数据模型与数据集定义不一致"));
        }
        let (env, env_id, customer): (Option<String>, Option<String>, Option<String>) = db
            .query_row(
                "SELECT environment,environment_id,customer_id FROM datasets WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(internal)?;
        if let Some(env_id) = env_id {
            if env.as_deref() != Some(environment_name(db, &env_id)?.as_str()) {
                return Err(bad_request("环境关联不一致"));
            }
        }
        let labels = environments(db, &id)?;
        let primary: Option<String> = db
            .query_row(
                "SELECT environment_id FROM datasets WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if labels.first().map(|v| v.0.as_str()) != primary.as_deref() {
            return Err(bad_request("环境列表与兼容字段不一致"));
        }
        if let Some(customer) = customer {
            exists(db, "customers", &customer)?;
        }
    }
    Ok(())
}

fn commit(db: &Connection, keys: &KeySet, request: &PublishRequest) -> ApiResult<Value> {
    let tx = db.unchecked_transaction().map_err(internal)?;
    let expected = token(&tx, keys, request)?;
    if request.confirmation_token.as_deref() != Some(expected.as_str()) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "数据或结构已变化，请重新预览后发布".into(),
        ));
    }
    let d = request_definition(&tx, request)?;
    let result = apply_publish(&tx, keys, request, &d)?;
    tx.commit().map_err(internal)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seed(db: &Connection, keys: &KeySet, id: &str, env: &str) -> String {
        let fields = json!([{"source_key":"merchant_id","zone":"indexes"},{"source_key":"token","zone":"secrets"},{"source_key":"note","zone":"normal"}]);
        db.execute("INSERT INTO datasets(id,category_path,environment,fields_json,identity_fields_json,conflict_strategy) VALUES(?1,'支付/商户',?2,?3,'[\"merchant_id\"]','allow_mark')",params![id,env,fields.to_string()]).unwrap();
        let definitions = dataset_definitions(db, id).unwrap();
        let result = insert_records(
            db,
            keys,
            id,
            "支付/商户",
            Some(env),
            &definitions,
            &["merchant_id".into()],
            &[json!({"merchant_id":"00123","token":format!("DEMO_ONLY_{id}"),"note":"保留说明"})],
            false,
        )
        .unwrap();
        result["record_ids"][0].as_str().unwrap().to_owned()
    }
    fn request(value: Value) -> PublishRequest {
        serde_json::from_value(value).unwrap()
    }
    fn sign(db: &Connection, keys: &KeySet, r: &mut PublishRequest) {
        r.confirmation_token = Some(token(db, keys, r).unwrap());
    }
    fn schema_id(db: &Connection, id: &str) -> String {
        db.query_row("SELECT schema_id FROM datasets WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
    }
    fn cipher(db: &Connection, id: &str) -> Vec<u8> {
        db.query_row(
            "SELECT ciphertext FROM protected_fields WHERE record_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }
    fn merge(db: &Connection, keys: &KeySet) -> String {
        upgrade_rows(db).unwrap();
        let schema = schema_id(db, "a");
        let mut r = request(json!({"schema_id":schema,"dataset_ids":["b"]}));
        sign(db, keys, &mut r);
        commit(db, keys, &r).unwrap();
        schema
    }
    #[test]
    fn upgrade_is_idempotent_keeps_legacy_ciphertext_ids_and_grants_and_never_guesses_customers() {
        let db = Connection::open_in_memory().unwrap();
        // Actual pre-catalog layout, including a database predating descriptions.
        db.execute_batch("CREATE TABLE datasets(id TEXT PRIMARY KEY,category_path TEXT NOT NULL,environment TEXT,fields_json TEXT NOT NULL,identity_fields_json TEXT NOT NULL,conflict_strategy TEXT NOT NULL);").unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "生产");
        let b = seed(&db, &keys, "b", "测试");
        db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json,access_expires_at) VALUES('app','原应用',?1,'secrets','[\"a\"]',4102444800)",[app_key_hash("existing-key")]).unwrap();
        let before = (cipher(&db, &a), cipher(&db, &b));
        // Drop the newly added columns/tables to exercise the same upgrade as an old vault.
        for column in ["schema_id", "customer_id", "environment_id"] {
            db.execute(&format!("DROP INDEX ix_datasets_{column}"), [])
                .unwrap();
            db.execute(&format!("ALTER TABLE datasets DROP COLUMN {column}"), [])
                .unwrap();
        }
        db.execute_batch(
            "DROP TABLE dataset_environments; DROP TABLE shared_schemas; DROP TABLE customers; DROP TABLE environments;",
        )
        .unwrap();
        initialize_schema(&db).unwrap();
        let sa = schema_id(&db, "a");
        let sb = schema_id(&db, "b");
        assert_ne!(sa, sb);
        initialize_schema(&db).unwrap();
        assert_eq!(schema_id(&db, "a"), sa);
        assert_eq!(schema_id(&db, "b"), sb);
        assert_eq!((cipher(&db, &a), cipher(&db, &b)), before);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM environments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM customers", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let row: (String, String, i64) = db
            .query_row(
                "SELECT key_hash,datasets_json,access_expires_at FROM api_apps WHERE id='app'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (app_key_hash("existing-key"), "[\"a\"]".into(), 4102444800)
        );
        validate_relations(&db).unwrap();
    }
    #[test]
    fn manual_merge_preserves_records_secrets_grants_and_instance_key_scope() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "测试");
        let b = seed(&db, &keys, "b", "生产");
        upgrade_rows(&db).unwrap();
        db.execute(
            "INSERT INTO customers(id,name) VALUES('ca','客户A'),('cb','客户B')",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE datasets SET customer_id=CASE id WHEN 'a' THEN 'ca' ELSE 'cb' END",
            [],
        )
        .unwrap();
        upgrade_rows(&db).unwrap();
        db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('app','应用',?1,'secrets','[\"a\"]')",[app_key_hash("original-key")]).unwrap();
        let before = (cipher(&db, &a), cipher(&db, &b));
        let schema = merge(&db, &keys);
        assert_eq!(schema_id(&db, "b"), schema);
        assert_eq!((cipher(&db, &a), cipher(&db, &b)), before);
        let mut headers = HeaderMap::new();
        headers.insert("x-app-id", HeaderValue::from_static("app"));
        headers.insert("x-app-key", HeaderValue::from_static("original-key"));
        authorize_app_dataset(&db, &headers, "a", "secrets").unwrap();
        assert_eq!(
            authorize_app_dataset(&db, &headers, "b", "search")
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        let old = read_instance(&db, "a").unwrap();
        insert_records(
            &db,
            &keys,
            "a",
            "支付/商户",
            Some("测试"),
            &old.fields,
            &old.identity_fields,
            &[json!({"merchant_id":"00123","note":"仅更新A"})],
            false,
        )
        .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT json_extract(display_json,'$.note') FROM records WHERE id=?1",
                [&b],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "保留说明"
        );
        assert!(environments(&db, "b")
            .unwrap()
            .iter()
            .any(|v| v.1 == "客户B"));
        validate_relations(&db).unwrap();
    }
    #[test]
    fn merge_keeps_application_grants_permissions_disabled_expiry_and_credentials_exactly() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "测试");
        seed(&db, &keys, "b", "生产");
        for (id, permission, disabled, expiry, scope) in [
            ("active", "secrets", false, None, json!(["a"])),
            ("readonly", "search", false, None, json!(["a"])),
            ("disabled", "secrets", true, None, json!(["b"])),
            ("expired", "secrets", false, Some(1_i64), json!(["a", "b"])),
        ] {
            db.execute("INSERT INTO api_apps(id,name,key_hash,permission,disabled,datasets_json,access_expires_at) VALUES(?1,?1,?2,?3,?4,?5,?6)",params![id,app_key_hash(id),permission,disabled,scope.to_string(),expiry]).unwrap();
        }
        let before = snapshot(&db, None)
            .into_iter()
            .find(|table| table.0 == "api_apps")
            .unwrap();
        merge(&db, &keys);
        assert_eq!(
            snapshot(&db, None)
                .into_iter()
                .find(|table| table.0 == "api_apps")
                .unwrap(),
            before
        );
        for (id, dataset, permission, allowed) in [
            ("active", "a", "secrets", true),
            ("active", "b", "search", false),
            ("readonly", "a", "search", true),
            ("readonly", "a", "secrets", false),
            ("disabled", "b", "search", false),
            ("expired", "a", "search", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("x-app-id", HeaderValue::from_str(id).unwrap());
            headers.insert("x-app-key", HeaderValue::from_str(id).unwrap());
            assert_eq!(
                authorize_app_dataset(&db, &headers, dataset, permission).is_ok(),
                allowed,
                "app {id}, dataset {dataset}, permission {permission}"
            );
        }
    }
    #[test]
    fn publication_preview_rolls_back_stale_or_tampered_requests_fail_and_changes_reach_every_instance(
    ) {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "测试");
        let b = seed(&db, &keys, "b", "生产");
        let schema = merge(&db, &keys);
        let mut d = read(&db, &schema).unwrap();
        d.fields[1].source_key = "credential".into();
        d.fields[1].previous_source_key = Some("token".into());
        d.fields[1].zone = "hidden".into();
        let mut r = request(json!({"schema_id":schema,"name":"商户统一结构","definition":d}));
        sign(&db, &keys, &mut r);
        let before = (cipher(&db, &a), cipher(&db, &b));
        let tx = db.unchecked_transaction().unwrap();
        let d = request_definition(&tx, &r).unwrap();
        apply_publish(&tx, &keys, &r, &d).unwrap();
        tx.rollback().unwrap();
        assert_eq!((cipher(&db, &a), cipher(&db, &b)), before);
        assert_eq!(
            token(&db, &keys, &r).unwrap(),
            r.confirmation_token.clone().unwrap()
        );
        r.name = Some("篡改的名称".into());
        assert_eq!(commit(&db, &keys, &r).unwrap_err().0, StatusCode::CONFLICT);
        r.name = Some("商户统一结构".into());
        db.execute("UPDATE records SET expired=1 WHERE id=?1", [&a])
            .unwrap();
        assert_eq!(commit(&db, &keys, &r).unwrap_err().0, StatusCode::CONFLICT);
        sign(&db, &keys, &mut r);
        commit(&db, &keys, &r).unwrap();
        for (id, expected) in [(&a, "DEMO_ONLY_a"), (&b, "DEMO_ONLY_b")] {
            let (n,c,z):(Vec<u8>,Vec<u8>,String)=db.query_row("SELECT nonce,ciphertext,zone FROM protected_fields WHERE record_id=?1 AND source_key='credential'",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
            assert_eq!(z, "hidden");
            assert_eq!(
                open_field(&keys.field, id, "credential", &n, &c).unwrap(),
                json!(expected)
            );
        }
        assert_eq!(commit(&db, &keys, &r).unwrap_err().0, StatusCode::CONFLICT);
        validate_relations(&db).unwrap();
    }
    #[test]
    fn incompatible_merge_is_rejected_and_legacy_writes_cannot_fork_shared_definitions() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "测试");
        seed(&db, &keys, "b", "生产");
        let schema = merge(&db, &keys);
        let before = token(&db, &keys, &request(json!({}))).unwrap();
        let update: DatasetUpdate = serde_json::from_value(
            json!({"fields":[{"source_key":"merchant_id","zone":"indexes"}]}),
        )
        .unwrap();
        assert!(update_dataset_in_connection(&db, &keys, "b", update).is_err());
        assert_eq!(token(&db, &keys, &request(json!({}))).unwrap(), before);
        let mut d = read(&db, &schema).unwrap();
        d.fields.pop();
        let mut r = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut r);
        assert!(commit(&db, &keys, &r).unwrap_err().1.contains("缺少字段"));
        assert_eq!(token(&db, &keys, &request(json!({}))).unwrap(), before);
        let import:ImportRequest=serde_json::from_value(json!({"dataset_id":"a","batch_id":"none","evolved_fields":[{"source_key":"new","zone":"indexes"}]})).unwrap();
        let tx = db.unchecked_transaction().unwrap();
        assert!(import_records_in_connection(&tx, &keys, &import, &[]).is_err());
        tx.rollback().unwrap();
        validate_relations(&db).unwrap();
    }
    #[test]
    fn shared_supplement_rename_migrates_values_and_preserves_orphan_rows() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "测试");
        let b = seed(&db, &keys, "b", "生产");
        let fields: Vec<FieldDefinition> = serde_json::from_value(
            json!([{"source_key":"memo","zone":"normal"},{"source_key":"secret","zone":"secrets"}]),
        )
        .unwrap();
        let mut rows = Vec::new();
        for (dataset, parent) in [("a", &a), ("b", &b)] {
            supplement::save_schema_in_connection(&db, &keys, dataset, &fields).unwrap();
            let write: supplement::WriteRequest=serde_json::from_value(json!({"main_record_id":parent,"values":{"memo":"手工备注","secret":"DEMO_ONLY_supplement"}})).unwrap();
            rows.push(
                supplement::write_row(&db, &keys, dataset, None, &write).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        let (nonce, ciphertext) = seal_field(
            &keys.field,
            "orphan",
            "supplement",
            &json!({"memo":"失联备注","secret":"DEMO_ONLY_orphan"}),
        )
        .unwrap();
        db.execute("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext,orphan) VALUES('orphan','a','deleted',?1,?2,?3,1)",params![json!({"mode":"id","fields":[],"values":{"id":"deleted"}}).to_string(),nonce,ciphertext]).unwrap();
        let schema = merge(&db, &keys);
        let mut d = read(&db, &schema).unwrap();
        d.supplement_fields[0].source_key = "remarks".into();
        d.supplement_fields[0].previous_source_key = Some("memo".into());
        d.supplement_fields[1].zone = "ignore".into();
        let mut r = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut r);
        commit(&db, &keys, &r).unwrap();
        for id in rows {
            assert_eq!(
                supplement::values(&db, &keys, &id).unwrap(),
                json!({"remarks":"手工备注"})
            );
        }
        assert_eq!(
            supplement::values(&db, &keys, "orphan").unwrap(),
            json!({"remarks":"失联备注"})
        );
        assert_eq!(
            db.query_row(
                "SELECT orphan FROM supplement_records WHERE id='orphan'",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap(),
            true
        );
        validate_relations(&db).unwrap();
    }

    pub(super) type Snapshot = Vec<(String, Vec<String>, Vec<Vec<rusqlite::types::Value>>)>;
    pub(super) fn snapshot(db: &Connection, columns: Option<&Snapshot>) -> Snapshot {
        let tables = [
            "datasets",
            "records",
            "protected_fields",
            "import_templates",
            "api_apps",
            "audit_events",
            "supplement_schemas",
            "supplement_records",
        ];
        tables
            .into_iter()
            .map(|table| {
                let names = if let Some(snapshot) = columns {
                    snapshot
                        .iter()
                        .find(|row| row.0 == table)
                        .unwrap()
                        .1
                        .clone()
                } else {
                    let mut q = db.prepare(&format!("PRAGMA table_info({table})")).unwrap();
                    q.query_map([], |row| row.get::<_, String>(1))
                        .unwrap()
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap()
                };
                let mut q = db
                    .prepare(&format!(
                        "SELECT {} FROM {table} ORDER BY rowid",
                        names.join(",")
                    ))
                    .unwrap();
                let rows = q
                    .query_map([], |row| {
                        (0..names.len())
                            .map(|i| row.get(i))
                            .collect::<Result<Vec<rusqlite::types::Value>, _>>()
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                (table.into(), names, rows)
            })
            .collect()
    }
    pub(super) fn remove_catalog(db: &Connection) {
        for column in ["schema_id", "customer_id", "environment_id"] {
            db.execute(&format!("DROP INDEX ix_datasets_{column}"), [])
                .unwrap();
            db.execute(&format!("ALTER TABLE datasets DROP COLUMN {column}"), [])
                .unwrap();
        }
        db.execute_batch("DROP TABLE dataset_environments; DROP TABLE shared_schemas; DROP TABLE customers; DROP TABLE environments; PRAGMA user_version=0;").unwrap();
    }
    fn database_layout(db: &Connection) -> Vec<(String, String, Option<String>)> {
        let mut q = db
            .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
            .unwrap();
        q.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    #[test]
    fn upgrade_preserves_every_existing_business_table_including_supplements_templates_and_app_states(
    ) {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "生产");
        seed(&db, &keys, "b", "测试");
        db.execute("UPDATE records SET display_json=?1,expired=1,updated_at='2026-10-01' WHERE id=?2",params![json!({"note":{"zero":0,"flag":false,"nil":null,"list":["001",9007199254740993_u64]}}).to_string(),a]).unwrap();
        let fields: Vec<FieldDefinition> = serde_json::from_value(
            json!([{"source_key":"memo","zone":"normal"},{"source_key":"token","zone":"secrets"}]),
        )
        .unwrap();
        supplement::save_schema_in_connection(&db, &keys, "a", &fields).unwrap();
        let row: supplement::WriteRequest = serde_json::from_value(
            json!({"main_record_id":a,"values":{"memo":"手工备注","token":"DEMO_ONLY_supplement"}}),
        )
        .unwrap();
        supplement::write_row(&db, &keys, "a", None, &row).unwrap();
        let (nonce, ciphertext) = seal_field(
            &keys.field,
            "orphan-old",
            "supplement",
            &json!({"memo":"失联也保留"}),
        )
        .unwrap();
        db.execute("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext,orphan) VALUES('orphan-old','a','deleted',?1,?2,?3,1)",params![json!({"mode":"id","fields":[],"values":{"id":"deleted"}}).to_string(),nonce,ciphertext]).unwrap();
        db.execute(
            "INSERT INTO import_templates VALUES('原模板','a','[]','2026-10-01')",
            [],
        )
        .unwrap();
        for (id, disabled, expiry, scope) in [
            ("active", false, None, json!(["a"])),
            ("disabled", true, None, json!(["b"])),
            ("expired", false, Some(1_i64), json!(["a", "b"])),
        ] {
            db.execute("INSERT INTO api_apps(id,name,key_hash,permission,disabled,datasets_json,access_expires_at) VALUES(?1,?1,?2,'secrets',?3,?4,?5)",params![id,app_key_hash(id),disabled,scope.to_string(),expiry]).unwrap();
        }
        remove_catalog(&db);
        let before = snapshot(&db, None);
        initialize_schema(&db).unwrap();
        initialize_schema(&db).unwrap();
        assert_eq!(snapshot(&db, Some(&before)), before);
        validate_relations(&db).unwrap();
        assert_ne!(schema_id(&db, "a"), schema_id(&db, "b"));
    }
    #[test]
    fn failed_upgrade_rolls_back_legacy_columns_catalog_backfill_and_link_repairs_and_is_retryable()
    {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "生产");
        seed(&db, &keys, "b", "测试");
        remove_catalog(&db);
        db.execute_batch("ALTER TABLE datasets DROP COLUMN description; ALTER TABLE datasets DROP COLUMN name;
            CREATE TABLE environments(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
            CREATE TRIGGER fail_upgrade BEFORE INSERT ON environments BEGIN SELECT RAISE(ABORT,'simulated full disk'); END;").unwrap();
        let before = snapshot(&db, None);
        let layout = database_layout(&db);
        assert!(initialize_schema(&db).is_err());
        assert!(db.is_autocommit());
        assert_eq!(database_layout(&db), layout);
        assert_eq!(snapshot(&db, Some(&before)), before);
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.execute("DROP TRIGGER fail_upgrade", []).unwrap();
        initialize_schema(&db).unwrap();
        assert_eq!(snapshot(&db, Some(&before)), before);
        validate_relations(&db).unwrap();
    }
    #[test]
    fn version_one_customer_and_environment_become_labels_atomically_and_removed_labels_stay_removed(
    ) {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let record = seed(&db, &keys, "legacy", "测试");
        upgrade_rows(&db).unwrap();
        db.execute(
            "INSERT INTO customers(id,name) VALUES('legacy-customer','客户A')",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE datasets SET customer_id='legacy-customer' WHERE id='legacy'",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('legacy-app','原应用',?1,'secrets','[\"legacy\"]')",[app_key_hash("DEMO_ONLY_legacy")]).unwrap();
        db.execute_batch("DROP TABLE dataset_environments; PRAGMA user_version=1; CREATE TRIGGER fail_labels BEFORE INSERT ON environments BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").unwrap();
        let before = snapshot(&db, None);
        let layout = database_layout(&db);
        let encrypted = cipher(&db, &record);
        assert!(initialize_schema(&db).is_err());
        assert_eq!(snapshot(&db, Some(&before)), before);
        assert_eq!(database_layout(&db), layout);
        db.execute("DROP TRIGGER fail_labels", []).unwrap();
        initialize_schema(&db).unwrap();
        initialize_schema(&db).unwrap();
        let labels = environments(&db, "legacy").unwrap();
        assert_eq!(
            labels.iter().map(|v| v.1.as_str()).collect::<Vec<_>>(),
            vec!["测试", "客户A"]
        );
        assert_eq!(cipher(&db, &record), encrypted);
        assert_eq!(
            db.query_row(
                "SELECT key_hash FROM api_apps WHERE id='legacy-app'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            app_key_hash("DEMO_ONLY_legacy")
        );
        assert!(db
            .query_row(
                "SELECT customer_id FROM datasets WHERE id='legacy'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none());
        set_environments(&db, "legacy", &[labels[0].0.clone()]).unwrap();
        initialize_schema(&db).unwrap();
        assert_eq!(environments(&db, "legacy").unwrap().len(), 1);
        validate_relations(&db).unwrap();
    }

    #[test]
    fn version_two_model_notes_upgrade_preserves_every_record_and_is_idempotent() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "测试");
        upgrade_rows(&db).unwrap();
        db.execute_batch(
            "ALTER TABLE shared_schemas DROP COLUMN description; PRAGMA user_version=2;",
        )
        .unwrap();
        let before = snapshot(&db, None);
        initialize_schema(&db).unwrap();
        initialize_schema(&db).unwrap();
        assert_eq!(snapshot(&db, Some(&before)), before);
        assert_eq!(
            db.query_row("SELECT description FROM shared_schemas", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            ""
        );
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        validate_relations(&db).unwrap();
    }
    #[test]
    fn model_notes_publish_preview_clear_and_merge_never_change_records_or_grants() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "测试");
        seed(&db, &keys, "b", "生产");
        let schema = merge(&db, &keys);
        db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('notes-app','说明测试',?1,'search','[\"a\"]')",[app_key_hash("DEMO_ONLY_notes")]).unwrap();
        let before = snapshot(&db, None)
            .into_iter()
            .filter(|row| row.0 != "audit_events")
            .collect::<Vec<_>>();
        let description="  ## 提取方法\n\n```sql\nSELECT code, name FROM demo_products WHERE enabled = 1;\n```\n";
        let mut request: PublishRequest =
            serde_json::from_value(json!({"schema_id":schema,"description":description})).unwrap();
        let tx = db.unchecked_transaction().unwrap();
        apply_publish(&tx, &keys, &request, &read(&tx, &schema).unwrap()).unwrap();
        tx.rollback().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT description FROM shared_schemas WHERE id=?1",
                [&schema],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            ""
        );
        sign(&db, &keys, &mut request);
        request.description = Some("预览后修改".into());
        assert_eq!(
            commit(&db, &keys, &request).unwrap_err().0,
            StatusCode::CONFLICT
        );
        request.description = Some(description.into());
        sign(&db, &keys, &mut request);
        commit(&db, &keys, &request).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT description FROM shared_schemas WHERE id=?1",
                [&schema],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            description
        );
        assert_eq!(
            snapshot(&db, None)
                .into_iter()
                .filter(|row| row.0 != "audit_events")
                .collect::<Vec<_>>(),
            before
        );
        seed(&db, &keys, "c", "预发布");
        let mut merge_request: PublishRequest =
            serde_json::from_value(json!({"schema_id":schema,"dataset_ids":["c"]})).unwrap();
        sign(&db, &keys, &mut merge_request);
        commit(&db, &keys, &merge_request).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT description FROM shared_schemas WHERE id=?1",
                [&schema],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            description
        );
        request.description = Some(String::new());
        sign(&db, &keys, &mut request);
        commit(&db, &keys, &request).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT description FROM shared_schemas WHERE id=?1",
                [&schema],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn dataset_name_upgrade_is_idempotent_and_preserves_all_existing_data() {
        let db=Connection::open_in_memory().unwrap(); initialize_schema(&db).unwrap(); let keys=random_keys();
        seed(&db,&keys,"a","测试"); ensure_dataset(&db,"a").unwrap(); assign_metadata(&db,"a").unwrap();
        db.execute_batch("ALTER TABLE datasets DROP COLUMN name; PRAGMA user_version=3").unwrap();
        let before=snapshot(&db,None);
        initialize_schema(&db).unwrap(); initialize_schema(&db).unwrap();
        assert_eq!(snapshot(&db,Some(&before)),before);
        assert_eq!(db.query_row("SELECT name FROM datasets WHERE id='a'",[],|r|r.get::<_,String>(0)).unwrap(),"");
        assert_eq!(db.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),4);
    }

    #[test]
    fn legacy_label_names_round_trip_verbatim_and_new_names_use_unicode_limits() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let label = " 客户A,区域 / 主站;备站 ";
        seed(&db, &keys, "legacy-label", label);
        initialize_schema(&db).unwrap();
        let before = snapshot(&db, None);
        let names = vec![label.to_owned()];
        let ids = resolve_environments(&db, None, Some(&names), None, None, false).unwrap().unwrap();
        set_environments(&db, "legacy-label", &ids).unwrap();
        assert_eq!(environments(&db, "legacy-label").unwrap()[0].1, label);
        assert_eq!(snapshot(&db, Some(&before)), before);
        assert!(name(&"🌱".repeat(120)).is_ok());
        assert!(name(&"🌱".repeat(121)).is_err());
        assert!(name("新\u{0085}标签").is_err());
        validate_relations(&db).unwrap();
    }

    #[test]
    fn dataset_names_are_optional_instance_metadata_and_never_rewrite_ciphertext_or_grants() {
        let db=Connection::open_in_memory().unwrap(); initialize_schema(&db).unwrap(); let keys=random_keys();
        for id in ["a","b"] { seed(&db,&keys,id,"测试"); ensure_dataset(&db,id).unwrap(); assign_metadata(&db,id).unwrap(); }
        db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('app','测试应用','hash','search','[\"a\"]')",[]).unwrap();
        let before=snapshot(&db,None); let preserved=before.iter().filter(|v|v.0!="datasets").cloned().collect::<Vec<_>>();
        let schema_before: (String,String,i64)=db.query_row("SELECT s.name,s.definition_json,s.version FROM shared_schemas s JOIN datasets d ON d.schema_id=s.id WHERE d.id='a'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        let update=|value:Value| update_dataset_in_connection(&db,&keys,"a",serde_json::from_value(value).unwrap());
        assert_eq!(update(json!({"name":"  商户凭据  "})).unwrap()["name"],"商户凭据");
        assert_eq!(snapshot(&db,None).into_iter().filter(|v|v.0!="datasets").collect::<Vec<_>>(),preserved);
        assert_eq!(db.query_row("SELECT name FROM datasets WHERE id='b'",[],|r|r.get::<_,String>(0)).unwrap(),"");
        let schema_after: (String,String,i64)=db.query_row("SELECT s.name,s.definition_json,s.version FROM shared_schemas s JOIN datasets d ON d.schema_id=s.id WHERE d.id='a'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(schema_before,schema_after);
        assert_eq!(update(json!({"description":"独立备注"})).unwrap()["name"],"商户凭据");
        update_dataset_in_connection(&db,&keys,"b",serde_json::from_value(json!({"name":"商户凭据"})).unwrap()).unwrap();
        let before_invalid=snapshot(&db,None);
        for value in ["x".repeat(121),"无效\n名称".into()] {
            assert_eq!(update(json!({"name":value})).unwrap_err().0,StatusCode::BAD_REQUEST);
            assert_eq!(snapshot(&db,None),before_invalid);
        }
        assert_eq!(update(json!({"name":"  "})).unwrap()["name"],"");
    }

    #[test]
    fn newer_database_is_rejected_without_downgrading_or_changing_data() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "生产");
        db.execute_batch("PRAGMA user_version=5").unwrap();
        let before = snapshot(&db, None);
        let layout = database_layout(&db);
        assert_eq!(initialize_schema(&db).unwrap_err().0, StatusCode::CONFLICT);
        assert_eq!(snapshot(&db, Some(&before)), before);
        assert_eq!(database_layout(&db), layout);
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            5
        );
    }
    #[test]
    fn malformed_or_undeclared_legacy_values_cannot_be_silently_lost_during_model_changes() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "测试");
        seed(&db, &keys, "b", "生产");
        let schema = merge(&db, &keys);
        // An undeclared old value must not overwrite a renamed value.
        db.execute("UPDATE records SET indexes_json=json_set(indexes_json,'$.new_id','older-value') WHERE id=?1",[&a]).unwrap();
        let mut d = read(&db, &schema).unwrap();
        d.fields[0].source_key = "new_id".into();
        d.fields[0].previous_source_key = Some("merchant_id".into());
        d.identity_fields = vec!["new_id".into()];
        let mut r = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut r);
        let before = snapshot(&db, None);
        assert!(commit(&db, &keys, &r).is_err());
        assert_eq!(snapshot(&db, Some(&before)), before);
        db.execute(
            "UPDATE records SET display_json='not-json' WHERE id=?1",
            [&a],
        )
        .unwrap();
        let mut d = read(&db, &schema).unwrap();
        d.fields[2].zone = "display".into();
        let mut r = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut r);
        let before = snapshot(&db, None);
        assert!(commit(&db, &keys, &r).is_err());
        assert_eq!(snapshot(&db, Some(&before)), before);
        // Main-table valid; encrypted supplementary extras are also never dropped.
        db.execute("UPDATE records SET display_json='{}' WHERE id=?1", [&a])
            .unwrap();
        let (nonce, ciphertext) = seal_field(
            &keys.field,
            "legacy-supplement",
            "supplement",
            &json!({"undocumented":"DEMO_ONLY_keep"}),
        )
        .unwrap();
        db.execute("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext) VALUES('legacy-supplement','a',?1,?2,?3,?4)",params![a,json!({"mode":"id","fields":[],"values":{"id":a}}).to_string(),nonce,ciphertext]).unwrap();
        sign(&db, &keys, &mut r);
        let before = snapshot(&db, None);
        assert!(commit(&db, &keys, &r).is_err());
        assert_eq!(snapshot(&db, Some(&before)), before);
    }
    #[test]
    fn same_field_set_with_explicit_swapped_names_still_migrates_values() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "测试");
        seed(&db, &keys, "b", "生产");
        let schema = merge(&db, &keys);
        let mut d = read(&db, &schema).unwrap();
        d.fields
            .push(serde_json::from_value(json!({"source_key":"other","zone":"normal"})).unwrap());
        let mut add = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut add);
        commit(&db, &keys, &add).unwrap();
        db.execute(
            "UPDATE records SET display_json=json_set(display_json,'$.other','第二个值')",
            [],
        )
        .unwrap();
        let mut d = read(&db, &schema).unwrap();
        d.fields
            .iter_mut()
            .find(|f| f.source_key == "note")
            .unwrap()
            .previous_source_key = Some("other".into());
        d.fields
            .iter_mut()
            .find(|f| f.source_key == "other")
            .unwrap()
            .previous_source_key = Some("note".into());
        let mut swap = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut swap);
        commit(&db, &keys, &swap).unwrap();
        let values = {
            let raw: String = db
                .query_row(
                    "SELECT display_json FROM records WHERE id=?1",
                    [&a],
                    |row| row.get(0),
                )
                .unwrap();
            serde_json::from_str::<Value>(&raw).unwrap()
        };
        assert_eq!(values["note"], "第二个值");
        assert_eq!(values["other"], "保留说明");
    }
    #[test]
    fn same_business_id_in_customer_environment_matrix_and_full_batch_deletion_are_isolated() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let fields: Vec<FieldDefinition> = serde_json::from_value(
            json!([{"source_key":"id","zone":"indexes"},{"source_key":"value","zone":"display"}]),
        )
        .unwrap();
        db.execute(
            "INSERT INTO customers VALUES('ca','客户A'),('cb','客户B')",
            [],
        )
        .unwrap();
        let mut all = Vec::new();
        for (id, customer, env) in [
            ("at", "ca", "测试"),
            ("ap", "ca", "生产"),
            ("bt", "cb", "测试"),
            ("bp", "cb", "生产"),
        ] {
            db.execute("INSERT INTO datasets(id,category_path,environment,fields_json,identity_fields_json,conflict_strategy,customer_id) VALUES(?1,'商户',?2,?3,'[\"id\"]','allow_mark',?4)",params![id,env,serde_json::to_string(&fields).unwrap(),customer]).unwrap();
            let result = insert_records(
                &db,
                &keys,
                id,
                "商户",
                Some(env),
                &fields,
                &["id".into()],
                &[
                    json!({"id":"00123","value":id}),
                    json!({"id":"00999","value":"extra"}),
                ],
                false,
            )
            .unwrap();
            all.extend(
                result["record_ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned()),
            );
        }
        assert_eq!(
            all.iter().collect::<std::collections::HashSet<_>>().len(),
            8
        );
        upgrade_rows(&db).unwrap();
        let schema = schema_id(&db, "at");
        let mut merge = request(json!({"schema_id":schema,"dataset_ids":["ap","bt","bp"]}));
        sign(&db, &keys, &mut merge);
        commit(&db, &keys, &merge).unwrap();
        let input: ImportRequest = serde_json::from_value(
            json!({"dataset_id":"at","batch_id":"test","delete_missing":true}),
        )
        .unwrap();
        let tx = db.unchecked_transaction().unwrap();
        import_records_in_connection(
            &tx,
            &keys,
            &input,
            &[json!({"id":"00123","value":"updated"})],
        )
        .unwrap();
        tx.commit().unwrap();
        for (id, count, value) in [
            ("at", 1, "updated"),
            ("ap", 2, "ap"),
            ("bt", 2, "bt"),
            ("bp", 2, "bp"),
        ] {
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM records WHERE dataset_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                count
            );
            assert_eq!(db.query_row("SELECT json_extract(display_json,'$.value') FROM records WHERE dataset_id=?1 AND json_extract(indexes_json,'$.id')='00123'",[id],|r|r.get::<_,String>(0)).unwrap(),value);
        }
        // Internal helpers reject a mismatched instance even if a caller passes a valid record id.
        let other: String = db
            .query_row(
                "SELECT id FROM records WHERE dataset_id='bp' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let write: supplement::WriteRequest =
            serde_json::from_value(json!({"values":{"value":"must-not-write"}})).unwrap();
        let before = snapshot(&db, None);
        assert!(supplement::write_main(&db, &keys, "at", Some(&other), &write).is_err());
        assert_eq!(snapshot(&db, Some(&before)), before);
    }
    #[test]
    fn reusing_another_instances_template_name_cannot_move_template_or_change_records() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        seed(&db, &keys, "a", "测试");
        seed(&db, &keys, "b", "生产");
        merge(&db, &keys);
        db.execute(
            "INSERT INTO import_templates VALUES('商户导入','a','[]','2026-10-01')",
            [],
        )
        .unwrap();
        let before = snapshot(&db, None);
        let input: ImportRequest = serde_json::from_value(
            json!({"dataset_id":"b","batch_id":"test","template_name":"商户导入"}),
        )
        .unwrap();
        assert!(import_records_in_connection(
            &db,
            &keys,
            &input,
            &[json!({"merchant_id":"00123","note":"must-not-write"})]
        )
        .is_err());
        assert_eq!(snapshot(&db, Some(&before)), before);
    }
    #[test]
    fn failed_multi_instance_migration_rolls_back_all_records_and_schema_versions() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let a = seed(&db, &keys, "a", "测试");
        let b = seed(&db, &keys, "b", "生产");
        let schema = merge(&db, &keys);
        // Last instance fails authenticated decryption after the first was migrated.
        db.execute(
            "UPDATE protected_fields SET ciphertext=x'00' WHERE record_id=?1",
            [&b],
        )
        .unwrap();
        let mut d = read(&db, &schema).unwrap();
        d.fields[2].zone = "secrets".into();
        let mut r = request(json!({"schema_id":schema,"definition":d}));
        sign(&db, &keys, &mut r);
        let before = cipher(&db, &a);
        let original = serde_json::to_value(read(&db, &schema).unwrap()).unwrap();
        assert!(commit(&db, &keys, &r).is_err());
        assert_eq!(cipher(&db, &a), before);
        assert_eq!(
            serde_json::to_value(read(&db, &schema).unwrap()).unwrap(),
            original
        );
        assert_eq!(
            db.query_row(
                "SELECT json_extract(display_json,'$.note') FROM records WHERE id=?1",
                [a],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "保留说明"
        );
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    async fn state() -> (AppState, Cleanup) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples/.build")
            .join(format!("catalog-runtime-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        private_dir(&dir).unwrap();
        let cleanup = Cleanup(dir.clone());
        let state = rotation::state_for(dir);
        let (keys, _) = initialize_vault(&state, "catalog-runtime-test-password").unwrap();
        activate(&state, keys, true).await;
        (state, cleanup)
    }
    async fn create(state: &AppState, value: Value) -> Value {
        create_dataset(
            State(state.clone()),
            Json(serde_json::from_value(value).unwrap()),
        )
        .await
        .unwrap()
        .0
    }
    #[tokio::test]
    async fn inline_labels_reuse_existing_names_and_failed_dataset_save_rolls_back_everything() {
        let (state, _cleanup) = state().await;
        let a=create(&state,json!({"category_path":"支付/商户","environment_names":[" 客户A ","测试"],"fields":[{"source_key":"code","zone":"indexes"}],"identity_fields":["code"],"sample_data":[{"code":"001"}]})).await;
        assert_eq!(a["environments"], json!(["客户A", "测试"]));
        assert!(a.get("customer").is_none());
        let b=create(&state,json!({"category_path":"支付/商户","environment_ids":a["environment_ids"],"environment_names":["客户A"],"schema_id":a["schema_id"]})).await;
        assert_eq!(a["environment_ids"], b["environment_ids"]);
        let update:DatasetUpdate=serde_json::from_value(json!({"environment_names":["不应残留的标签"],"fields":[{"source_key":"code","zone":"normal"}]})).unwrap();
        assert!(update_dataset(
            State(state.clone()),
            Path(a["dataset_id"].as_str().unwrap().to_owned()),
            Json(update)
        )
        .await
        .is_err());
        with_connection(&state, |db, _| {
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM environments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                environments(db, a["dataset_id"].as_str().unwrap())?
                    .iter()
                    .map(|v| v.1.clone())
                    .collect::<Vec<_>>(),
                vec!["客户A", "测试"]
            );
            Ok(())
        })
        .await
        .unwrap();
        for (request, expected) in [
            (
                json!({"environment_names":["客户A","生产"]}),
                json!(["客户A", "生产"]),
            ),
            (json!({"description":"只改说明"}), json!(["客户A", "生产"])),
            (json!({"environment_names":[]}), json!([])),
        ] {
            let result = update_dataset(
                State(state.clone()),
                Path(b["dataset_id"].as_str().unwrap().to_owned()),
                Json(serde_json::from_value(request).unwrap()),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(result["environments"], expected);
        }
        for request in [
            json!({"environment_names":[" "]}),
            json!({"environment_ids":["missing"],"environment_names":["新标签"]}),
            json!({"environment_names":["新标签"],"environment":"旧字段"}),
        ] {
            let mut value = request;
            value["category_path"] = json!("支付/失败");
            assert!(create_dataset(
                State(state.clone()),
                Json(serde_json::from_value(value).unwrap())
            )
            .await
            .is_err());
        }
        with_connection(&state, |db, _| {
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM datasets", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM environments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                3
            );
            validate_relations(db)
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn label_intersections_secondary_labels_and_app_authorization_remain_dataset_scoped() {
        let (state, _cleanup) = state().await;
        let a=create(&state,json!({"category_path":"业务/产品","environment_names":["客户A","测试"],"fields":[{"source_key":"code","zone":"indexes"},{"source_key":"token","zone":"secrets"}],"identity_fields":["code"],"sample_data":[{"code":"001","token":"DEMO_ONLY_A"}]})).await;
        let b=create(&state,json!({"category_path":"业务/产品","environment_names":["客户A","生产"],"schema_id":a["schema_id"],"sample_data":[{"code":"001","token":"DEMO_ONLY_B"}]})).await;
        let mut owner = HeaderMap::new();
        owner.insert("x-vault-owner", HeaderValue::from_static("1"));
        for (query, count) in [
            (json!({"environment_tags":"[\"客户A\"]"}), 2),
            (json!({"environment_tags":"[\"客户A\",\"生产\"]"}), 1),
            (json!({"environment_tags":"[\"测试\",\"生产\"]"}), 0),
            (json!({"environment":"生产"}), 1),
            (json!({"environment_id":b["environment_ids"][1]}), 1),
            (json!({"q":"env:=生产 code:=001"}), 1),
            (json!({"q":"env:=客户A env:=生产"}), 1),
        ] {
            let result = search_records(
                State(state.clone()),
                Query(serde_json::from_value(query).unwrap()),
                owner.clone(),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(result["total"], count);
        }
        with_connection(&state,|db,keys| {
            db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('label-app','标签应用',?1,'secrets',?2)",params![app_key_hash("DEMO_ONLY_key"),json!([a["dataset_id"]]).to_string()]).unwrap();
            let old_grant:String=db.query_row("SELECT datasets_json FROM api_apps WHERE id='label-app'",[],|r|r.get(0)).unwrap();
            let secret=|db:&Connection| {
                let id=b["import"]["record_ids"][0].as_str().unwrap();
                let (nonce,ciphertext):(Vec<u8>,Vec<u8>)=db.query_row("SELECT nonce,ciphertext FROM protected_fields WHERE record_id=?1 AND source_key='token'",[id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
                open_field(&keys.field,id,"token",&nonce,&ciphertext).unwrap()
            };
            let before=secret(db);
            let mut d=read(db,a["schema_id"].as_str().unwrap())?;
            d.fields[1].display_name="接入密钥".into();
            let mut request:PublishRequest=serde_json::from_value(json!({"schema_id":a["schema_id"],"definition":d})).unwrap();
            request.confirmation_token=Some(token(db,keys,&request)?);
            let original=environments(db,b["dataset_id"].as_str().unwrap())?.into_iter().map(|v|v.0).collect::<Vec<_>>();
            let extra=environment_named(db,"预发布")?;
            let mut changed=original.clone();changed.push(extra);
            set_environments(db,b["dataset_id"].as_str().unwrap(),&changed)?;
            assert_eq!(commit(db,keys,&request).unwrap_err().0,StatusCode::CONFLICT);
            set_environments(db,b["dataset_id"].as_str().unwrap(),&original)?;
            request.confirmation_token=Some(token(db,keys,&request)?);
            commit(db,keys,&request)?;
            assert_eq!(environments(db,b["dataset_id"].as_str().unwrap())?.iter().map(|v|v.1.clone()).collect::<Vec<_>>(),vec!["客户A","生产"]);
            assert_eq!(secret(db),before);
            assert_eq!(db.query_row("SELECT datasets_json FROM api_apps WHERE id='label-app'",[],|r|r.get::<_,String>(0)).unwrap(),old_grant);
            Ok(())
        }).await.unwrap();
        let mut app = HeaderMap::new();
        app.insert("x-app-id", HeaderValue::from_static("label-app"));
        app.insert("x-app-key", HeaderValue::from_static("DEMO_ONLY_key"));
        for (labels, count) in [("[\"客户A\"]", 1), ("[\"客户A\",\"生产\"]", 0)] {
            let result = search_records(
                State(state.clone()),
                Query(serde_json::from_value(json!({"environment_tags":labels})).unwrap()),
                app.clone(),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(result["total"], count);
        }
        let primary = b["environment_ids"][0].as_str().unwrap().to_owned();
        let secondary = b["environment_ids"][1].as_str().unwrap().to_owned();
        let _ = rename_named(
            State(state.clone()),
            Path(("environments".into(), secondary.clone())),
            Json(NamedRequest {
                name: "正式".into(),
            }),
        )
        .await
        .unwrap();
        assert!(delete_named(
            State(state.clone()),
            Path(("environments".into(), secondary.clone()))
        )
        .await
        .is_err());
        let result = update_dataset(
            State(state.clone()),
            Path(b["dataset_id"].as_str().unwrap().to_owned()),
            Json(serde_json::from_value(json!({"environment_ids":[secondary,primary]})).unwrap()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(result["environments"], json!(["正式", "客户A"]));
        assert_eq!(result["environment"], "正式");
        with_connection(&state, |db, _| {
            initialize_schema(db)?;
            assert_eq!(
                environments(db, b["dataset_id"].as_str().unwrap())?.len(),
                2
            );
            validate_relations(db)
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn encrypted_old_vault_upgrades_on_unlock_and_preserves_existing_app_credentials() {
        let (state, _cleanup) = state().await;
        let d=create(&state,json!({"category_path":"原客户/商户","environment":"生产","fields":[{"source_key":"id","zone":"indexes"},{"source_key":"token","zone":"secrets"}],"identity_fields":["id"],"sample_data":[{"id":"001","token":"DEMO_ONLY_upgrade"}]})).await;
        let id = d["dataset_id"].as_str().unwrap().to_owned();
        let before=with_connection(&state,|db,_|{
            db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json,access_expires_at) VALUES('old-app','原应用',?1,'secrets',?2,4102444800)",params![app_key_hash("DEMO_ONLY_existing_key"),json!([id]).to_string()]).unwrap();
            let row:(String,Vec<u8>)=db.query_row("SELECT r.id,p.ciphertext FROM records r JOIN protected_fields p ON p.record_id=r.id",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            super::tests::remove_catalog(db);
            let before=super::tests::snapshot(db,None);
            Ok((row,before))
        }).await.unwrap();
        let _ = vault_seal(State(state.clone())).await;
        vault_unlock(
            State(state.clone()),
            Json(PasswordRequest {
                password: "catalog-runtime-test-password".into(),
            }),
        )
        .await
        .unwrap();
        with_connection(&state,|db,_|{
            let after:(String,Vec<u8>)=db.query_row("SELECT r.id,p.ciphertext FROM records r JOIN protected_fields p ON p.record_id=r.id",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(after,before.0);
            assert_eq!(super::tests::snapshot(db,Some(&before.1)),before.1);
            let mut headers=HeaderMap::new();headers.insert("x-app-id",HeaderValue::from_static("old-app"));headers.insert("x-app-key",HeaderValue::from_static("DEMO_ONLY_existing_key"));authorize_app_dataset(db,&headers,&id,"secrets")?;
            validate_relations(db)?;assert_eq!(db.query_row("SELECT COUNT(*) FROM customers",[],|r|r.get::<_,i64>(0)).unwrap(),0);Ok(())
        }).await.unwrap();
    }
    #[tokio::test]
    async fn dimensions_rename_filter_and_deletion_respect_references_and_shared_creation_is_consistent(
    ) {
        let (state, _cleanup) = state().await;
        let env = create_named(
            State(state.clone()),
            Path("environments".into()),
            Json(NamedRequest {
                name: "测试".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        let a=create(&state,json!({"category_path":"支付/商户","environment_ids":[env["id"]],"environment_names":["客户A"],"fields":[{"source_key":"merchant_id","zone":"indexes"}],"identity_fields":["merchant_id"],"sample_data":[{"merchant_id":"001"}]})).await;
        // A structure with an explicitly empty list must remain empty in a new instance.
        with_connection(&state, |db, keys| {
            let mut d = read(db, a["schema_id"].as_str().unwrap())?;
            d.list_fields.clear();
            let mut r: PublishRequest =
                serde_json::from_value(json!({"schema_id":a["schema_id"],"definition":d})).unwrap();
            r.confirmation_token = Some(token(db, keys, &r)?);
            commit(db, keys, &r)?;
            Ok(())
        })
        .await
        .unwrap();
        let b=create(&state,json!({"category_path":"支付/商户","schema_id":a["schema_id"],"environment":"生产","sample_data":[{"merchant_id":"001"}]})).await;
        with_connection(&state, |db, _| validate_relations(db))
            .await
            .unwrap();
        assert_eq!(a["schema_id"], b["schema_id"]);
        let _ = rename_named(
            State(state.clone()),
            Path(("environments".into(), env["id"].as_str().unwrap().into())),
            Json(NamedRequest {
                name: "预发布".into(),
            }),
        )
        .await
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-vault-owner", HeaderValue::from_static("1"));
        for (query, count) in [
            (json!({"environment_tags":"[\"客户A\"]"}), 1),
            (json!({"schema_id":a["schema_id"]}), 2),
            (json!({"environment_id":env["id"]}), 1),
            (json!({"environment":"预发布"}), 1),
            (json!({"environment_tags":"[\"missing\"]"}), 0),
        ] {
            let result = search_records(
                State(state.clone()),
                Query(serde_json::from_value(query).unwrap()),
                headers.clone(),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(result["total"], count);
        }
        assert!(delete_named(
            State(state.clone()),
            Path(("environments".into(), env["id"].as_str().unwrap().into()))
        )
        .await
        .is_err());
        assert!(lifecycle::delete_schema(
            State(state.clone()),
            Path(a["schema_id"].as_str().unwrap().into()),
            Json(serde_json::from_value(json!({"confirmation_token":"", "expected_name":"", "expires_at":0})).unwrap())
        )
        .await
        .is_err());
    }
}
