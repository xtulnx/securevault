use super::*;

// Each dataset owns one independent schema. Extension values are encrypted with
// field keys; main_record_id deliberately has no FK so deleted parents leave
// recoverable orphan rows instead of silently deleting manual work.
pub(super) fn initialize(db: &Connection) -> ApiResult<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS supplement_schemas(dataset_id TEXT PRIMARY KEY REFERENCES datasets(id),fields_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS supplement_records(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES datasets(id),main_record_id TEXT NOT NULL,link_json TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,orphan INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS ix_supplement_dataset ON supplement_records(dataset_id);
      CREATE INDEX IF NOT EXISTS ix_supplement_parent ON supplement_records(main_record_id);
      UPDATE supplement_records SET orphan=1 WHERE orphan=0 AND id NOT IN (SELECT MIN(id) FROM supplement_records WHERE orphan=0 GROUP BY dataset_id,main_record_id);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_supplement_parent ON supplement_records(dataset_id,main_record_id) WHERE orphan=0;") .map_err(internal)
}

fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "记录或数据集不存在".into())
}

pub(super) fn fields(db: &Connection, dataset: &str) -> ApiResult<Vec<FieldDefinition>> {
    dataset_definitions(db, dataset).map_err(|_| missing())?;
    let raw: Option<String> = db
        .query_row(
            "SELECT fields_json FROM supplement_schemas WHERE dataset_id=?1",
            [dataset],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    serde_json::from_str(raw.as_deref().unwrap_or("[]")).map_err(internal)
}

pub(super) fn link_fields(db: &Connection, dataset: &str) -> ApiResult<Vec<String>> {
    let definitions = dataset_definitions(db, dataset)?;
    let raw: String = db
        .query_row(
            "SELECT identity_fields_json FROM datasets WHERE id=?1",
            [dataset],
            |r| r.get(0),
        )
        .map_err(internal)?;
    let identity: Vec<String> = serde_json::from_str(&raw).map_err(internal)?;
    let indexes: Vec<String> = definitions
        .iter()
        .filter(|f| f.zone == "indexes")
        .map(|f| f.source_key.clone())
        .collect();
    let mut selected = if !identity.is_empty() && identity.iter().all(|key| indexes.contains(key)) {
        identity
    } else {
        indexes
    };
    selected.sort();
    Ok(selected)
}

fn link(id: &str, indexes: &Value, fields: &[String]) -> Value {
    if fields.is_empty() {
        return json!({"mode":"id","fields":[],"values":{"id":id}});
    }
    let values: serde_json::Map<String, Value> = fields
        .iter()
        .map(|key| {
            (
                key.clone(),
                indexes.get(key).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    let complete = values
        .values()
        .all(|value| !value.is_null() && value.as_str() != Some(""));
    json!({"mode":if complete {"indexes"} else {"incomplete"},"fields":fields,"values":values})
}

pub(super) fn sync(db: &Connection, dataset: &str) -> ApiResult<()> {
    let selected = link_fields(db, dataset)?;
    let parents: Vec<(String, String)> = {
        let mut stmt = db
            .prepare("SELECT id,indexes_json FROM records WHERE dataset_id=?1")
            .map_err(internal)?;
        stmt.query_map([dataset], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(internal)?
            .collect::<Result<_, _>>()
            .map_err(internal)?
    };
    let mut links = std::collections::HashMap::new();
    let mut matches = std::collections::HashMap::<String, Vec<String>>::new();
    for (id, indexes) in parents {
        let value = link(
            &id,
            &serde_json::from_str::<Value>(&indexes).map_err(internal)?,
            &selected,
        );
        if value["mode"] != "incomplete" {
            matches
                .entry(value.to_string())
                .or_default()
                .push(id.clone());
        }
        links.insert(id, value);
    }
    let rows: Vec<(String, String, String)> = {
        let mut stmt = db
            .prepare(
                "SELECT id,main_record_id,link_json FROM supplement_records WHERE dataset_id=?1 ORDER BY orphan,updated_at,id",
            )
            .map_err(internal)?;
        stmt.query_map([dataset], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(internal)?
            .collect::<Result<_, _>>()
            .map_err(internal)?
    };
    // Release links before rebuilding them, then reserve each parent once.
    // Existing live links precede recoverable or legacy conflicting rows.
    db.execute("UPDATE supplement_records SET orphan=1 WHERE dataset_id=?1", [dataset]).map_err(internal)?;
    let mut occupied = std::collections::HashSet::new();
    for (id, parent, old) in rows {
        // A stable system ID anchors surviving rows during any index/schema edits.
        let (parent, snapshot, mut orphan) = if let Some(value) = links.get(&parent) {
            (parent, value.to_string(), false)
        } else if let Some(candidates) = matches.get(&old).filter(|ids| ids.len() == 1) {
            let parent = candidates[0].clone();
            (parent.clone(), links[&parent].to_string(), false)
        } else {
            let mut snapshot: Value = serde_json::from_str(&old).map_err(internal)?;
            if selected.is_empty() {
                snapshot = link(&parent, &Value::Null, &selected);
            } else if snapshot["fields"] != json!(selected) {
                snapshot["mode"] = json!("unresolved");
            }
            (parent, snapshot.to_string(), true)
        };
        if !orphan && !occupied.insert(parent.clone()) { orphan = true; }
        db.execute(
            "UPDATE supplement_records SET main_record_id=?2,link_json=?3,orphan=?4 WHERE id=?1",
            params![id, parent, snapshot, orphan],
        )
        .map_err(internal)?;
    }
    Ok(())
}

pub(super) fn values(db: &Connection, keys: &KeySet, id: &str) -> ApiResult<Value> {
    let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = db
        .query_row(
            "SELECT nonce,ciphertext FROM supplement_records WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(missing)?;
    open_field(&keys.field, id, "supplement", &nonce, &ciphertext)
}

fn public_values(values: &Value, fields: &[FieldDefinition]) -> (Value, Vec<Value>) {
    let mut public = serde_json::Map::new();
    let mut protected = Vec::new();
    for field in fields {
        if let Some(value) = values.get(&field.source_key) {
            match field.zone.as_str() {
                "ignore" => {}
                "hidden" | "secrets" => protected.push(
                    json!({"field_name":field.source_key,"zone":field.zone,"masked":"••••••••"}),
                ),
                _ => {
                    public.insert(field.source_key.clone(), value.clone());
                }
            }
        }
    }
    (Value::Object(public), protected)
}

pub(super) fn rows(
    db: &Connection,
    keys: &KeySet,
    dataset: &str,
    parent: Option<&str>,
) -> ApiResult<Vec<Value>> {
    let definitions = fields(db, dataset)?;
    let raw: Vec<(String, String, String, bool, String)> = {
        let mut stmt = db.prepare("SELECT id,main_record_id,link_json,orphan,updated_at FROM supplement_records WHERE dataset_id=?1 AND (?2 IS NULL OR (main_record_id=?2 AND orphan=0)) ORDER BY updated_at DESC,id").map_err(internal)?;
        stmt.query_map(params![dataset, parent], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?
    };
    raw.into_iter().map(|(id,parent,link,orphan,updated)| {
        let (public,protected) = public_values(&values(db,keys,&id)?, &definitions);
        Ok(json!({"id":id,"main_record_id":parent,"link":serde_json::from_str::<Value>(&link).map_err(internal)?,"orphan":orphan,"values":public,"protected_fields":protected,"updated":updated}))
    }).collect()
}

pub(super) fn searchable(db: &Connection, keys: &KeySet, scope: Option<&[String]>, dataset: Option<&str>) -> ApiResult<std::collections::HashMap<String,Value>> {
    let mut result=std::collections::HashMap::new();
    let mut stmt=db.prepare("SELECT s.id,s.dataset_id,s.main_record_id,s.nonce,s.ciphertext,d.fields_json FROM supplement_records s JOIN supplement_schemas d ON d.dataset_id=s.dataset_id JOIN records r ON r.id=s.main_record_id AND r.dataset_id=s.dataset_id WHERE s.orphan=0 AND (?1 IS NULL OR s.dataset_id=?1)").map_err(internal)?;
    let mut rows=stmt.query([dataset]).map_err(internal)?;
    while let Some(row)=rows.next().map_err(internal)? {
        let dataset:String=row.get(1).map_err(internal)?;
        if scope.is_some_and(|ids|!ids.contains(&dataset)) {continue;}
        let id:String=row.get(0).map_err(internal)?;
        let definitions:Vec<FieldDefinition>=serde_json::from_str(&row.get::<_,String>(5).map_err(internal)?).map_err(internal)?;
        let data=open_field(&keys.field,&id,"supplement",&row.get::<_,Vec<u8>>(3).map_err(internal)?,&row.get::<_,Vec<u8>>(4).map_err(internal)?)?;
        let mut indexes=serde_json::Map::new();let mut display=serde_json::Map::new();let mut labels=serde_json::Map::new();
        for field in definitions.iter().filter(|f|matches!(f.zone.as_str(),"indexes"|"display")) {
            if let Some(value)=data.get(&field.source_key) {
                if field.zone=="indexes" {indexes.insert(field.source_key.clone(),value.clone());} else {display.insert(field.source_key.clone(),value.clone());}
                labels.insert(field.source_key.clone(),json!(if field.display_name.is_empty(){&field.source_key}else{&field.display_name}));
            }
        }
        result.insert(row.get::<_,String>(2).map_err(internal)?,json!({"id":id,"indexes":indexes,"display":display,"field_labels":labels}));
    }
    Ok(result)
}

#[derive(Deserialize)]
pub(super) struct SchemaRequest {
    fields: Vec<FieldDefinition>,
}
#[derive(Deserialize)]
pub(super) struct WriteRequest {
    #[serde(default)]
    main_record_id: Option<String>,
    #[serde(default)]
    values: serde_json::Map<String, Value>,
    #[serde(default)]
    unset_fields: Vec<String>,
}

fn apply(
    values: &mut serde_json::Map<String, Value>,
    request: &WriteRequest,
    fields: &[FieldDefinition],
) -> ApiResult<()> {
    for key in request.values.keys().chain(request.unset_fields.iter()) {
        if !fields
            .iter()
            .any(|f| f.source_key == *key && f.zone != "ignore")
        {
            return Err(bad_request(format!("字段未定义或已忽略：{key}")));
        }
    }
    for key in &request.unset_fields {
        values.remove(key);
    }
    values.extend(request.values.clone());
    Ok(())
}

pub(super) async fn get_table(
    State(state): State<AppState>,
    Path(dataset): Path<String>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db,keys| {
        let definitions = fields(db,&dataset)?;
        let selected = link_fields(db,&dataset)?;
        Ok(Json(json!({"dataset_id":dataset,"fields":definitions,"link_fields":selected,"link_mode":if selected.is_empty(){"id"}else{"indexes"},"records":rows(db,keys,&dataset,None)?})))
    }).await
}

pub(super) async fn save_schema(
    State(state): State<AppState>,
    Path(dataset): Path<String>,
    Json(request): Json<SchemaRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db,keys| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        let mut next=catalog::read_instance(&tx,&dataset)?;
        next.supplement_fields=request.fields.clone();
        catalog::require_local_edit(&tx,&dataset,&next)?;
        save_schema_in_connection(&tx,keys,&dataset,&request.fields)?;
        catalog::sync_local(&tx,&dataset)?;
        tx.commit().map_err(internal)?;
        Ok(Json(json!({"saved":true})))
    }).await
}

pub(super) fn save_schema_in_connection(db: &Connection, keys: &KeySet, dataset: &str, fields_next: &[FieldDefinition]) -> ApiResult<()> {
    let old=fields(db,dataset)?;
    validate_schema(fields_next,&[],&[])?;
    let ids:Vec<String>={let mut s=db.prepare("SELECT id FROM supplement_records WHERE dataset_id=?1").map_err(internal)?;s.query_map([dataset],|r|r.get(0)).map_err(internal)?.collect::<Result<_,_>>().map_err(internal)?};
    for id in ids {
        let previous=values(db,keys,&id)?;
        let previous=previous.as_object().ok_or_else(||bad_request("附表值格式无效，已中止数据模型迁移"))?;
        let mut next=serde_json::Map::new();
        let mut consumed=std::collections::HashSet::new();
        for field in fields_next {
            let key=field.previous_source_key.as_ref().filter(|key|old.iter().any(|f|&f.source_key==*key)).unwrap_or(&field.source_key);
            if !consumed.insert(key.as_str()) {return Err(bad_request("附表多个字段不能引用同一原字段"));}
            if field.zone!="ignore" {if let Some(value)=previous.get(key){next.insert(field.source_key.clone(),value.clone());}}
        }
        for key in previous.keys() {
            let explicitly_ignored=fields_next.iter().any(|field|field.zone=="ignore" && (key==&field.source_key || key.starts_with(&format!("{}.",field.source_key))));
            if !consumed.contains(key.as_str()) && !explicitly_ignored && !old.iter().any(|field|&field.source_key==key) {return Err(bad_request(format!("附表仍有字段 {key} 的值，请先补齐数据模型或显式设为忽略")));}
        }
        let (nonce,ciphertext)=seal_field(&keys.field,&id,"supplement",&Value::Object(next))?;
        db.execute("UPDATE supplement_records SET nonce=?2,ciphertext=?3 WHERE id=?1",params![id,nonce,ciphertext]).map_err(internal)?;
    }
    let mut definitions=fields_next.to_vec();
    for field in &mut definitions {field.previous_source_key=None;}
    db.execute("INSERT INTO supplement_schemas(dataset_id,fields_json) VALUES(?1,?2) ON CONFLICT(dataset_id) DO UPDATE SET fields_json=excluded.fields_json",params![dataset,serde_json::to_string(&definitions).map_err(internal)?]).map_err(internal)?;
    db.execute("INSERT INTO audit_events(event,record_id) VALUES('supplement_schema_updated',?1)",[dataset]).map_err(internal)?;
    Ok(())
}

pub(super) fn write_row(
    db: &Connection,
    keys: &KeySet,
    dataset: &str,
    id: Option<&str>,
    request: &WriteRequest,
) -> ApiResult<Value> {
    let definitions = fields(db, dataset)?;
    let mut data = if let Some(id) = id {
        values(db, keys, id)?
            .as_object()
            .cloned()
            .ok_or_else(|| internal("invalid values"))?
    } else {
        Default::default()
    };
    apply(&mut data, request, &definitions)?;
    let old_parent: Option<String> = if let Some(id) = id {
        db.query_row(
            "SELECT main_record_id FROM supplement_records WHERE id=?1 AND dataset_id=?2",
            params![id, dataset],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?
    } else {
        None
    };
    if id.is_some() && old_parent.is_none() {
        return Err(missing());
    }
    let parent = request
        .main_record_id
        .as_ref()
        .or(old_parent.as_ref())
        .ok_or_else(|| bad_request("请选择关联主记录"))?;
    let occupied: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM supplement_records WHERE dataset_id=?1 AND main_record_id=?2 AND orphan=0 AND (?3 IS NULL OR id<>?3))", params![dataset,parent,id],|r|r.get(0)).map_err(internal)?;
    let retaining_orphan = occupied && id.is_some() && request.main_record_id.is_none();
    if occupied && !retaining_orphan {return Err(ApiError(StatusCode::CONFLICT,"此主记录已有附表，请编辑现有附表；每条主记录只允许一条附表".into()));}
    let selected = link_fields(db, dataset)?;
    let indexes: Option<String> = db
        .query_row(
            "SELECT indexes_json FROM records WHERE id=?1 AND dataset_id=?2",
            params![parent, dataset],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    // Orphans may be edited without changing their unavailable parent.
    let snapshot = if let Some(indexes) = indexes.as_ref() {
        link(
            parent,
            &serde_json::from_str::<Value>(indexes).map_err(internal)?,
            &selected,
        )
    } else if id.is_some() && request.main_record_id.is_none() {
        let raw: String = db
            .query_row(
                "SELECT link_json FROM supplement_records WHERE id=?1",
                [id.unwrap()],
                |r| r.get(0),
            )
            .map_err(internal)?;
        serde_json::from_str(&raw).map_err(internal)?
    } else {
        return Err(bad_request("关联记录不属于此数据集或已删除"));
    };
    let id = id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("sup_{}", Uuid::new_v4().simple()));
    let (nonce, ciphertext) = seal_field(&keys.field, &id, "supplement", &Value::Object(data))?;
    db.execute("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext,orphan) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET main_record_id=excluded.main_record_id,link_json=excluded.link_json,nonce=excluded.nonce,ciphertext=excluded.ciphertext,orphan=excluded.orphan,updated_at=CURRENT_TIMESTAMP",params![id,dataset,parent,snapshot.to_string(),nonce,ciphertext,indexes.is_none() || retaining_orphan]).map_err(internal)?;
    db.execute(
        "INSERT INTO audit_events(event,record_id) VALUES('supplement_written',?1)",
        [&id],
    )
    .map_err(internal)?;
    Ok(json!({"id":id}))
}

pub(super) async fn create_row(
    State(state): State<AppState>,
    Path(dataset): Path<String>,
    Json(request): Json<WriteRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = write_row(&tx, keys, &dataset, None, &request)?;
        tx.commit().map_err(internal)?;
        Ok(Json(result))
    })
    .await
}
pub(super) async fn update_row(
    State(state): State<AppState>,
    Path((dataset, id)): Path<(String, String)>,
    Json(request): Json<WriteRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = write_row(&tx, keys, &dataset, Some(&id), &request)?;
        tx.commit().map_err(internal)?;
        Ok(Json(result))
    })
    .await
}
pub(super) async fn delete_row(
    State(state): State<AppState>,
    Path((dataset, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |connection, _| {
        let tx = connection.unchecked_transaction().map_err(internal)?;
        let db: &Connection = &tx;
        let count = db
            .execute(
                "DELETE FROM supplement_records WHERE id=?1 AND dataset_id=?2",
                params![id, dataset],
            )
            .map_err(internal)?;
        if count == 0 {
            return Err(missing());
        }
        db.execute(
            "INSERT INTO audit_events(event,record_id) VALUES('supplement_deleted',?1)",
            [&id],
        )
        .map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(Json(json!({"deleted":count})))
    })
    .await
}
pub(super) async fn cleanup(
    State(state): State<AppState>,
    Path(dataset): Path<String>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db,_| { let tx=db.unchecked_transaction().map_err(internal)?; sync(&tx,&dataset)?; let count=tx.execute("DELETE FROM supplement_records WHERE dataset_id=?1 AND orphan=1",[&dataset]).map_err(internal)?; tx.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('supplement_orphans_cleaned',?1,?2)",params![dataset,count.to_string()]).map_err(internal)?; tx.commit().map_err(internal)?; Ok(Json(json!({"deleted":count}))) }).await
}

pub(super) async fn reveal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RevealRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db,keys| {
        let dataset: String = db.query_row("SELECT dataset_id FROM supplement_records WHERE id=?1",[&id],|r|r.get(0)).optional().map_err(internal)?.ok_or_else(missing)?;
        authorize_app_dataset(db,&headers,&dataset,"secrets")?;
        let definitions=fields(db,&dataset)?;
        if !definitions.iter().any(|f| f.source_key==request.field_name && f.zone=="secrets") { return Err(missing()); }
        let data=values(db,keys,&id)?;
        let value=data.get(&request.field_name).ok_or_else(missing)?;
        db.execute("INSERT INTO audit_events(event,record_id,field_name) VALUES('supplement_reveal',?1,?2)",params![id,request.field_name]).map_err(internal)?;
        Ok(Json(json!({"value":value,"expires_in_seconds":30})))
    }).await
}

pub(super) fn main_values(
    db: &Connection,
    keys: &KeySet,
    id: &str,
) -> ApiResult<serde_json::Map<String, Value>> {
    let (indexes, display): (String, String) = db
        .query_row(
            "SELECT indexes_json,display_json FROM records WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(missing)?;
    let mut values =
        serde_json::from_str::<serde_json::Map<String, Value>>(&indexes).map_err(internal)?;
    values.extend(
        serde_json::from_str::<serde_json::Map<String, Value>>(&display).map_err(internal)?,
    );
    let mut stmt = db
        .prepare("SELECT source_key,nonce,ciphertext FROM protected_fields WHERE record_id=?1")
        .map_err(internal)?;
    let protected = stmt
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(internal)?;
    for row in protected {
        let (field, nonce, ciphertext) = row.map_err(internal)?;
        values.insert(
            field.clone(),
            open_field(&keys.field, id, &field, &nonce, &ciphertext)?,
        );
    }
    Ok(values)
}

pub(super) fn write_main(
    db: &Connection,
    keys: &KeySet,
    dataset: &str,
    id: Option<&str>,
    request: &WriteRequest,
) -> ApiResult<Value> {
    let definitions = dataset_definitions(db, dataset).map_err(|_| missing())?;
    if let Some(id)=id {
        let owner:Option<String>=db.query_row("SELECT dataset_id FROM records WHERE id=?1",[id],|row|row.get(0)).optional().map_err(internal)?;
        if owner.as_deref()!=Some(dataset) {return Err(bad_request("记录不属于目标数据集或已删除"));}
    }
    let mut data = if let Some(id) = id {
        main_values(db, keys, id)?
    } else {
        Default::default()
    };
    apply(&mut data, request, &definitions)?;
    let mut nested = serde_json::Map::new();
    for (key, value) in &data {
        insert_nested_value(&mut nested, key, value.clone());
    }
    let input = Value::Object(nested);
    let (category, environment, identity): (String, Option<String>, String) = db
        .query_row(
            "SELECT category_path,environment,identity_fields_json FROM datasets WHERE id=?1",
            [dataset],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(internal)?;
    let identity: Vec<String> = serde_json::from_str(&identity).map_err(internal)?;
    let hash = identity_hash(&keys.identity, dataset, &identity, &input);
    if !identity.is_empty() && hash.is_none() {
        return Err(bad_request("请填写完整的逻辑 KEY"));
    }
    let duplicate:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM records WHERE dataset_id=?1 AND identity_hash=?2 AND (?3 IS NULL OR id<>?3))",params![dataset,hash,id],|r|r.get(0)).map_err(internal)?;
    if duplicate {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "逻辑 KEY 已存在，请编辑对应记录".into(),
        ));
    }
    let id = id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("rec_{}", Uuid::new_v4().simple()));
    // Keep flat Schema fields intact, including JSON objects in sensitive fields.
    // Flattening them would invent child fields with potentially public zones.
    let previous_display: Option<String> = db
        .query_row("SELECT display_json FROM records WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(internal)?;
    let previous_display: Value =
        serde_json::from_str(previous_display.as_deref().unwrap_or("{}")).map_err(internal)?;
    let mut indexes = serde_json::Map::new();
    let mut display = serde_json::Map::new();
    let mut protected = Vec::new();
    for (field, value) in data {
        if definitions.iter().any(|f| {
            f.zone == "ignore"
                && (f.source_key == field || field.starts_with(&format!("{}.", f.source_key)))
        }) {
            continue;
        }
        let previous_zone: Option<String> = db
            .query_row(
                "SELECT zone FROM protected_fields WHERE record_id=?1 AND source_key=?2",
                params![id, field],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal)?;
        let previous_public = if previous_display.get(&field).is_some() {
            "display"
        } else {
            "indexes"
        };
        let zone = definitions
            .iter()
            .find(|f| f.source_key == field)
            .map(|f| f.zone.as_str())
            .or(previous_zone.as_deref())
            .or(Some(previous_public))
            .unwrap_or("indexes");
        match zone {
            "secrets" | "hidden" => protected.push((field, zone.to_owned(), value)),
            "display" | "normal" => {
                display.insert(field, value);
            }
            _ => {
                indexes.insert(field, value);
            }
        }
    }
    let indexes = Value::Object(indexes);
    let display = Value::Object(display);
    let (search_display, _) = split_display_fields(&display, &definitions);
    let blob = search_blob(&category, environment.as_deref(), &indexes, &search_display);
    db.execute("INSERT INTO records(id,dataset_id,category_path,environment,indexes_json,display_json,search_blob,identity_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET indexes_json=excluded.indexes_json,display_json=excluded.display_json,search_blob=excluded.search_blob,identity_hash=excluded.identity_hash,updated_at=CURRENT_TIMESTAMP",params![id,dataset,category,environment,indexes.to_string(),display.to_string(),blob,hash]).map_err(internal)?;
    db.execute("DELETE FROM protected_fields WHERE record_id=?1", [&id])
        .map_err(internal)?;
    for (field, zone, value) in protected {
        let (nonce, ciphertext) = seal_field(&keys.field, &id, &field, &value)?;
        db.execute(
            "INSERT INTO protected_fields VALUES(?1,?2,?3,?4,?5)",
            params![id, field, zone, nonce, ciphertext],
        )
        .map_err(internal)?;
    }
    sync(db, dataset)?;
    db.execute(
        "INSERT INTO audit_events(event,record_id) VALUES('manual_record_written',?1)",
        [&id],
    )
    .map_err(internal)?;
    Ok(json!({"id":id}))
}

pub(super) async fn create_main(
    State(state): State<AppState>,
    Path(dataset): Path<String>,
    Json(request): Json<WriteRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = write_main(&tx, keys, &dataset, None, &request)?;
        tx.commit().map_err(internal)?;
        Ok(Json(result))
    })
    .await
}
pub(super) async fn update_main(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<WriteRequest>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, keys| {
        let dataset: String = db
            .query_row("SELECT dataset_id FROM records WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(internal)?
            .ok_or_else(missing)?;
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = write_main(&tx, keys, &dataset, Some(&id), &request)?;
        tx.commit().map_err(internal)?;
        Ok(Json(result))
    })
    .await
}
pub(super) async fn delete_main(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, _| {
        let dataset: String = db
            .query_row("SELECT dataset_id FROM records WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(internal)?
            .ok_or_else(missing)?;
        let tx = db.unchecked_transaction().map_err(internal)?;
        tx.execute("DELETE FROM records WHERE id=?1", [&id])
            .map_err(internal)?;
        tx.execute(
            "UPDATE records SET duplicate_of=NULL WHERE duplicate_of=?1",
            [&id],
        )
        .map_err(internal)?;
        sync(&tx, &dataset)?;
        tx.execute(
            "INSERT INTO audit_events(event,record_id) VALUES('manual_record_deleted',?1)",
            [&id],
        )
        .map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(Json(json!({"deleted":1})))
    })
    .await
}

pub(super) fn rotate(db: &Connection, old: &KeySet, new: &KeySet) -> ApiResult<()> {
    let ids: Vec<String> = {
        let mut stmt = db
            .prepare("SELECT id FROM supplement_records")
            .map_err(internal)?;
        stmt.query_map([], |r| r.get(0))
            .map_err(internal)?
            .collect::<Result<_, _>>()
            .map_err(internal)?
    };
    for id in ids {
        let value = values(db, old, &id)?;
        let (nonce, ciphertext) = seal_field(&new.field, &id, "supplement", &value)?;
        db.execute(
            "UPDATE supplement_records SET nonce=?2,ciphertext=?3 WHERE id=?1",
            params![id, nonce, ciphertext],
        )
        .map_err(internal)?;
        if values(db, new, &id)? != value {
            return Err(internal("supplement rotation verification failed"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(data: Value) -> WriteRequest {
        serde_json::from_value(data).unwrap()
    }
    fn fixture() -> (Connection, KeySet) {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let keys = random_keys();
        let fields = json!([{"source_key":"code","zone":"indexes"},{"source_key":"region","zone":"indexes"},{"source_key":"note","zone":"normal"},{"source_key":"credential","zone":"secrets"},{"source_key":"internal","zone":"hidden"}]);
        db.execute("INSERT INTO datasets(id,category_path,fields_json,identity_fields_json,conflict_strategy) VALUES('d','测试',?1,'[\"code\"]','allow_mark')",[fields.to_string()]).unwrap();
        db.execute("INSERT INTO supplement_schemas VALUES('d',?1)",[json!([{"source_key":"remark","zone":"normal"},{"source_key":"access","zone":"secrets"},{"source_key":"hidden","zone":"hidden"}]).to_string()]).unwrap();
        (db, keys)
    }
    #[test]
    fn one_to_one_rejects_duplicate_and_relink_preserves_legacy_conflicts() {
        let (db,keys)=fixture();
        let a=write_main(&db,&keys,"d",None,&request(json!({"values":{"code":"A"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        let b=write_main(&db,&keys,"d",None,&request(json!({"values":{"code":"B"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        let first=write_row(&db,&keys,"d",None,&request(json!({"main_record_id":a,"values":{"remark":"first"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        assert_eq!(write_row(&db,&keys,"d",None,&request(json!({"main_record_id":a}))).unwrap_err().0,StatusCode::CONFLICT);
        let second=write_row(&db,&keys,"d",None,&request(json!({"main_record_id":b,"values":{"remark":"second"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        assert_eq!(write_row(&db,&keys,"d",Some(&second),&request(json!({"main_record_id":a,"values":{"remark":"lost"}}))).unwrap_err().0,StatusCode::CONFLICT);
        assert_eq!(values(&db,&keys,&second).unwrap()["remark"],"second");
        db.execute("DROP INDEX ux_supplement_parent",[]).unwrap();
        db.execute("UPDATE supplement_records SET main_record_id=?2 WHERE id=?1",params![second,a]).unwrap();
        initialize_schema(&db).unwrap();
        for _ in 0..2 {sync(&db,"d").unwrap();}
        let records=rows(&db,&keys,"d",None).unwrap();
        assert_eq!(records.len(),2);
        assert_eq!(records.iter().filter(|r|r["orphan"]==false).count(),1);
        let orphan=records.iter().find(|r|r["orphan"]==true).unwrap()["id"].as_str().unwrap();
        write_row(&db,&keys,"d",Some(orphan),&request(json!({"values":{"remark":"retained"}}))).unwrap();
        assert_eq!(rows(&db,&keys,"d",Some(&a)).unwrap().len(),1);
        write_row(&db,&keys,"d",Some(orphan),&request(json!({"main_record_id":b}))).unwrap();
        assert_eq!(rows(&db,&keys,"d",Some(&b)).unwrap().len(),1);
        assert!(values(&db,&keys,&first).is_ok());
    }

    #[test]
    fn explicit_null_preserves_field_presence_for_main_and_supplement_without_clearing_keys() {
        let (db, keys) = fixture();
        let id = write_main(&db, &keys, "d", None, &request(json!({"values":{"code":"A","note":{"count":0},"credential":"synthetic"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        write_main(&db, &keys, "d", Some(&id), &request(json!({"values":{"note":null,"credential":null}}))).unwrap();
        let data = main_values(&db, &keys, &id).unwrap();
        for key in ["note", "credential"] {
            assert!(data.contains_key(key));
            assert!(data[key].is_null());
        }
        assert_eq!(data["code"], "A");
        assert!(write_main(&db, &keys, "d", Some(&id), &request(json!({"values":{"code":null}}))).is_err());
        assert_eq!(main_values(&db, &keys, &id).unwrap()["code"], "A");
        let child = write_row(&db, &keys, "d", None, &request(json!({"main_record_id":id,"values":{"remark":"text","access":"synthetic"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        write_row(&db, &keys, "d", Some(&child), &request(json!({"values":{"remark":null,"access":null}}))).unwrap();
        let child_data = values(&db, &keys, &child).unwrap();
        for key in ["remark", "access"] {
            assert!(child_data.as_object().unwrap().contains_key(key));
            assert!(child_data[key].is_null());
        }
    }

    #[test]
    fn manual_main_edits_preserve_secrets_and_types_and_reject_duplicate_keys() {
        let (db, keys) = fixture();
        let input = request(
            json!({"values":{"code":"A","region":1,"note":"long\ntext","credential":{"nested":"private-value"},"internal":"hidden-value"}}),
        );
        let id = write_main(&db, &keys, "d", None, &input).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let updated = request(json!({"values":{"note":true}}));
        write_main(&db, &keys, "d", Some(&id), &updated).unwrap();
        let values = main_values(&db, &keys, &id).unwrap();
        assert_eq!(values["credential"], json!({"nested":"private-value"}));
        assert_eq!(values["internal"], "hidden-value");
        assert_eq!(values["note"], true);
        assert_eq!(values["region"], 1);
        let (indexes, display, blob): (String, String, String) = db
            .query_row(
                "SELECT indexes_json,display_json,search_blob FROM records WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(!format!("{indexes}{display}{blob}").contains("private-value"));
        assert_eq!(
            write_main(&db, &keys, "d", None, &input).unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert!(
            write_main(
                &db,
                &keys,
                "d",
                Some(&id),
                &request(json!({"unset_fields":["code"]}))
            )
            .is_err()
        );
        assert!(
            write_main(
                &db,
                &keys,
                "d",
                Some(&id),
                &request(json!({"values":{"unknown":"bad"}}))
            )
            .is_err()
        );
        write_main(
            &db,
            &keys,
            "d",
            Some(&id),
            &request(json!({"unset_fields":["credential"]})),
        )
        .unwrap();
        assert!(
            !main_values(&db, &keys, &id)
                .unwrap()
                .contains_key("credential")
        );
    }
    #[test]
    fn import_updates_and_index_changes_preserve_independent_values_and_resolve_orphans() {
        let (db, keys) = fixture();
        let parent = write_main(
            &db,
            &keys,
            "d",
            None,
            &request(json!({"values":{"code":"A","region":"east"}})),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let row=write_row(&db,&keys,"d",None,&request(json!({"main_record_id":parent,"values":{"remark":"手工说明","access":"private-addon","hidden":"hidden-addon"}}))).unwrap()["id"].as_str().unwrap().to_owned();
        let defs = dataset_definitions(&db, "d").unwrap();
        insert_records(
            &db,
            &keys,
            "d",
            "测试",
            None,
            &defs,
            &["code".into()],
            &[json!({"code":"A","region":"west","credential":{"nested":"import-private"},"note":{"sql":"SELECT 1"}})],
            false,
        )
        .unwrap();
        assert_eq!(values(&db, &keys, &row).unwrap()["remark"], "手工说明");
        assert_eq!(
            main_values(&db, &keys, &parent).unwrap()["credential"],
            json!({"nested":"import-private"})
        );
        assert_eq!(
            main_values(&db, &keys, &parent).unwrap()["note"],
            json!({"sql":"SELECT 1"})
        );
        let stored: String = db
            .query_row(
                "SELECT indexes_json || display_json || search_blob FROM records WHERE id=?1",
                [&parent],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!stored.contains("import-private"));
        let listed = rows(&db, &keys, "d", Some(&parent)).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].to_string().contains("private-addon"));
        assert_eq!(listed[0]["protected_fields"].as_array().unwrap().len(), 2);
        write_main(
            &db,
            &keys,
            "d",
            Some(&parent),
            &request(json!({"values":{"code":"B"}})),
        )
        .unwrap();
        assert_eq!(
            rows(&db, &keys, "d", None).unwrap()[0]["link"]["values"]["code"],
            "B"
        );
        db.execute("DELETE FROM records WHERE id=?1", [&parent])
            .unwrap();
        sync(&db, "d").unwrap();
        assert_eq!(rows(&db, &keys, "d", None).unwrap()[0]["orphan"], true);
        let replacement = write_main(
            &db,
            &keys,
            "d",
            None,
            &request(json!({"values":{"code":"B","region":"west"}})),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let restored = rows(&db, &keys, "d", None).unwrap();
        assert_eq!(restored[0]["orphan"], false);
        assert_eq!(restored[0]["main_record_id"], replacement);
        assert_eq!(values(&db, &keys, &row).unwrap()["access"], "private-addon");
        // Losing all indexes switches every surviving row to system-ID links.
        db.execute("UPDATE datasets SET fields_json=?1,identity_fields_json='[]' WHERE id='d'",[json!([{"source_key":"code","zone":"normal"},{"source_key":"region","zone":"normal"}]).to_string()]).unwrap();
        sync(&db, "d").unwrap();
        assert_eq!(
            rows(&db, &keys, "d", None).unwrap()[0]["link"]["mode"],
            "id"
        );
        assert_eq!(
            rows(&db, &keys, "d", None).unwrap()[0]["link"]["values"]["id"],
            replacement
        );
        let newkeys = random_keys();
        rotate(&db, &keys, &newkeys).unwrap();
        assert_eq!(
            values(&db, &newkeys, &row).unwrap()["access"],
            "private-addon"
        );
        assert!(values(&db, &keys, &row).is_err());
    }
    #[test]
    fn ambiguous_and_incomplete_indexes_never_reattach_to_an_arbitrary_parent() {
        let (db, keys) = fixture();
        let parent = write_main(
            &db,
            &keys,
            "d",
            None,
            &request(json!({"values":{"code":"A"}})),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        write_row(
            &db,
            &keys,
            "d",
            None,
            &request(json!({"main_record_id":parent,"values":{"remark":"retain"}})),
        )
        .unwrap();
        db.execute("DELETE FROM records WHERE id=?1", [&parent])
            .unwrap();
        for id in ["duplicate1", "duplicate2"] {
            db.execute("INSERT INTO records(id,dataset_id,category_path,indexes_json,display_json,search_blob) VALUES(?1,'d','测试','{\"code\":\"A\"}','{}','')",[id]).unwrap();
        }
        sync(&db, "d").unwrap();
        assert_eq!(rows(&db, &keys, "d", None).unwrap()[0]["orphan"], true);
        db.execute(
            "UPDATE datasets SET identity_fields_json='[]' WHERE id='d'",
            [],
        )
        .unwrap();
        sync(&db, "d").unwrap();
        assert_eq!(rows(&db, &keys, "d", None).unwrap()[0]["orphan"], true);
        assert!(
            write_row(
                &db,
                &keys,
                "d",
                None,
                &request(json!({"main_record_id":"missing","values":{"remark":"bad"}}))
            )
            .is_err()
        );
        db.execute("INSERT INTO datasets(id,category_path,fields_json,identity_fields_json,conflict_strategy) VALUES('other','其他','[]','[]','allow_mark')",[]).unwrap();
        let other = write_main(&db, &keys, "other", None, &request(json!({}))).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            write_row(
                &db,
                &keys,
                "d",
                None,
                &request(json!({"main_record_id":other,"values":{"remark":"bad"}}))
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn endpoints_migrate_schema_enforce_app_scope_and_cleanup_only_unlinked_records() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("supplement-test-{}", Uuid::new_v4()));
        private_dir(&path).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let state = rotation::state_for(path);
        let (keys, _) = initialize_vault(&state, "supplement-test-password").unwrap();
        activate(&state, keys, true).await;
        let dataset=create_dataset(State(state.clone()),Json(serde_json::from_value(json!({"category_path":"测试","fields":[{"source_key":"code","zone":"indexes"},{"source_key":"note","zone":"normal"}],"identity_fields":["code"]})).unwrap())).await.unwrap().0["dataset_id"].as_str().unwrap().to_owned();
        let parent = create_main(
            State(state.clone()),
            Path(dataset.clone()),
            Json(request(json!({"values":{"code":"A","note":"primary"}}))),
        )
        .await
        .unwrap()
        .0["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let _ = save_schema(State(state.clone()),Path(dataset.clone()),Json(serde_json::from_value(json!({"fields":[{"source_key":"notes","zone":"normal"},{"source_key":"password","zone":"secrets"},{"source_key":"hidden","zone":"hidden"}]})).unwrap())).await.unwrap();
        let id=create_row(State(state.clone()),Path(dataset.clone()),Json(request(json!({"main_record_id":parent,"values":{"notes":"manual","password":"secret-one","hidden":"hidden-one"}})))).await.unwrap().0["id"].as_str().unwrap().to_owned();
        let _ = save_schema(State(state.clone()),Path(dataset.clone()),Json(serde_json::from_value(json!({"fields":[{"source_key":"notes","zone":"normal"},{"source_key":"password","zone":"secrets"},{"source_key":"hidden","zone":"hidden"},{"source_key":"code","zone":"indexes","display_name":"附表编号"},{"source_key":"status","zone":"display"}]})).unwrap())).await.unwrap();
        let _ = update_row(State(state.clone()),Path((dataset.clone(),id.clone())),Json(request(json!({"values":{"code":"B","status":"已确认"}})))).await.unwrap();
        let mut owner = HeaderMap::new();
        owner.insert("x-vault-owner", HeaderValue::from_static("1"));
        for (q,expected) in [("code:=A supplement.code:=B",1),("附表.code:=B status:=已确认",1),("code:=B",1),("indexes.code:=B",0),("supplement.code:~^B$",1),("secret-one",0),("hidden-one",0),("manual",0)] {
            let query:SearchQuery=serde_json::from_value(json!({"q":q,"dataset_id":dataset})).unwrap();
            let found=search_records(State(state.clone()),Query(query),owner.clone()).await.unwrap().0;
            assert_eq!(found["total"],expected,"query {q}");
            assert!(!found.to_string().contains("secret-one"));
            assert!(!found.to_string().contains("hidden-one"));
            assert!(!found.to_string().contains("manual"));
            if expected==1 {assert_eq!(found["records"][0]["supplement"]["indexes"]["code"],"B");}
        }
        let listed=list_datasets(State(state.clone())).await.unwrap().0;
        assert!(listed["datasets"][0]["supplement_fields"].as_array().unwrap().iter().any(|f|f["source_key"]=="code"));
        with_connection(&state,|db,_|{db.execute("UPDATE records SET expired=1 WHERE id=?1",[&parent]).unwrap();Ok(())}).await.unwrap();
        let query:SearchQuery=serde_json::from_value(json!({"q":"supplement.code:=B"})).unwrap();
        assert_eq!(search_records(State(state.clone()),Query(query),owner.clone()).await.unwrap().0["total"],0);
        let query:SearchQuery=serde_json::from_value(json!({"q":"supplement.code:=B","include_expired":true})).unwrap();
        assert_eq!(search_records(State(state.clone()),Query(query),owner.clone()).await.unwrap().0["total"],1);
        with_connection(&state,|db,_|{db.execute("UPDATE records SET expired=0 WHERE id=?1",[&parent]).unwrap();Ok(())}).await.unwrap();
        let detail = record_detail(State(state.clone()), Path(parent.clone()), owner.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(detail["supplement_records"][0]["values"]["notes"], "manual");
        assert!(!detail.to_string().contains("secret-one"));
        assert_eq!(
            reveal(
                State(state.clone()),
                Path(id.clone()),
                owner.clone(),
                Json(RevealRequest {
                    field_name: "password".into()
                })
            )
            .await
            .unwrap()
            .0["value"],
            "secret-one"
        );
        assert_eq!(
            reveal(
                State(state.clone()),
                Path(id.clone()),
                owner.clone(),
                Json(RevealRequest {
                    field_name: "hidden".into()
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::NOT_FOUND
        );
        with_connection(&state,|db,_|{db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('app','app',?1,'search',?2)",params![app_key_hash("token"),json!([dataset]).to_string()]).unwrap();Ok(())}).await.unwrap();
        let mut app = HeaderMap::new();
        app.insert("x-app-id", HeaderValue::from_static("app"));
        app.insert("x-app-key", HeaderValue::from_static("token"));
        let query:SearchQuery=serde_json::from_value(json!({"q":"code:=A supplement.code:=B","page":1,"limit":1})).unwrap();
        assert_eq!(search_records(State(state.clone()),Query(query),app.clone()).await.unwrap().0["total"],1);
        for filter in [json!({"category":"其他"}),json!({"environment":"prod"}),json!({"dataset_id":"other"})] {
            let mut data=filter;data["q"]=json!("supplement.code:=B");
            let query:SearchQuery=serde_json::from_value(data).unwrap();
            assert_eq!(search_records(State(state.clone()),Query(query),owner.clone()).await.unwrap().0["total"],0);
        }
        assert_eq!(
            reveal(
                State(state.clone()),
                Path(id.clone()),
                app.clone(),
                Json(RevealRequest {
                    field_name: "password".into()
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::FORBIDDEN
        );
        with_connection(&state, |db, _| {
            db.execute(
                "UPDATE api_apps SET permission='secrets',datasets_json='[]'",
                [],
            )
            .unwrap();
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            reveal(
                State(state.clone()),
                Path(id.clone()),
                app.clone(),
                Json(RevealRequest {
                    field_name: "password".into()
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::FORBIDDEN
        );
        let query:SearchQuery=serde_json::from_value(json!({"q":"supplement.code:=B"})).unwrap();
        assert_eq!(search_records(State(state.clone()),Query(query),app.clone()).await.unwrap().0["total"],0);
        let _ = save_schema(State(state.clone()),Path(dataset.clone()),Json(serde_json::from_value(json!({"fields":[{"source_key":"memo","previous_source_key":"notes","zone":"display"},{"source_key":"password","zone":"hidden"}]})).unwrap())).await.unwrap();
        with_connection(&state, |db, keys| {
            let data = values(db, keys, &id).unwrap();
            assert_eq!(data["memo"], "manual");
            assert!(data.get("hidden").is_none());
            assert_eq!(data["password"], "secret-one");
            Ok(())
        })
        .await
        .unwrap();
        // A failed destructive import is atomic, including a prospective schema change.
        state.batches.lock().await.insert(
            "bad".into(),
            ImportBatch::new(vec![json!({"note":"no-key"})], None),
        );
        assert!(
            import_records(
                State(state.clone()),
                Json(
                    serde_json::from_value(
                        json!({"dataset_id":dataset,"batch_id":"bad","delete_missing":true})
                    )
                    .unwrap()
                )
            )
            .await
            .is_err()
        );
        assert_eq!(
            get_table(State(state.clone()), Path(dataset.clone()))
                .await
                .unwrap()
                .0["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            record_detail(State(state.clone()), Path(parent.clone()), owner.clone())
                .await
                .unwrap()
                .0["normal"]["note"],
            "primary"
        );
        assert_eq!(
            cleanup(State(state.clone()), Path(dataset.clone()))
                .await
                .unwrap()
                .0["deleted"],
            0
        );
        let changed: DatasetUpdate=serde_json::from_value(json!({"fields":[{"source_key":"new_code","previous_source_key":"code","zone":"indexes"},{"source_key":"note","zone":"normal"}],"identity_fields":["new_code"]})).unwrap();
        let _ = update_dataset(State(state.clone()), Path(dataset.clone()), Json(changed))
            .await
            .unwrap();
        let table = get_table(State(state.clone()), Path(dataset.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(table["records"][0]["link"]["values"]["new_code"], "A");
        assert_eq!(table["link_fields"], json!(["new_code"]));
        let changed: DatasetUpdate=serde_json::from_value(json!({"fields":[{"source_key":"new_code","zone":"normal"},{"source_key":"note","zone":"normal"}],"identity_fields":[]})).unwrap();
        let _ = update_dataset(State(state.clone()), Path(dataset.clone()), Json(changed))
            .await
            .unwrap();
        assert_eq!(
            get_table(State(state.clone()), Path(dataset.clone()))
                .await
                .unwrap()
                .0["records"][0]["link"]["mode"],
            "id"
        );
        let _ = delete_main(State(state.clone()), Path(parent))
            .await
            .unwrap();
        let _ = update_row(
            State(state.clone()),
            Path((dataset.clone(), id)),
            Json(request(json!({"values":{"memo":"orphan-edit"}}))),
        )
        .await
        .unwrap();
        let table = get_table(State(state.clone()), Path(dataset.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(table["records"][0]["orphan"], true);
        assert_eq!(table["records"][0]["values"]["memo"], "orphan-edit");
        let query:SearchQuery=serde_json::from_value(json!({"q":"supplement.memo:orphan-edit","include_expired":true})).unwrap();
        assert_eq!(search_records(State(state.clone()),Query(query),owner).await.unwrap().0["total"],0);
        assert_eq!(
            cleanup(State(state.clone()), Path(dataset.clone()))
                .await
                .unwrap()
                .0["deleted"],
            1
        );
        assert!(
            get_table(State(state), Path(dataset)).await.unwrap().0["records"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
