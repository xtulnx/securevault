//! Physical deletion with an expiring preview bound to the affected state.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DeleteRequest {
    confirmation_token: String,
    expected_name: String,
    expires_at: i64,
}

fn affected_apps(db: &Connection, id: &str) -> ApiResult<Vec<(String, Vec<String>, bool)>> {
    let mut statement = db.prepare("SELECT id,datasets_json,disabled FROM api_apps ORDER BY id").map_err(internal)?;
    let rows = statement.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?))).map_err(internal)?;
    let mut apps = Vec::new();
    for row in rows {
        let (app, raw, disabled) = row.map_err(internal)?;
        let mut scope: Vec<String> = serde_json::from_str(&raw).map_err(internal)?;
        if scope.iter().any(|item| item == id) {
            scope.retain(|item| item != id);
            apps.push((app, scope, disabled));
        }
    }
    Ok(apps)
}

fn impact(db: &Connection, kind: &str, id: &str) -> ApiResult<Value> {
    if kind == "schemas" {
        let name: String = db.query_row("SELECT name FROM shared_schemas WHERE id=?1",[id],|r|r.get(0)).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND,"数据模型不存在".into()))?;
        let mut statement = db.prepare("SELECT id,name,category_path FROM datasets WHERE schema_id=?1 ORDER BY id").map_err(internal)?;
        let datasets = statement.query_map([id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"category_path":r.get::<_,String>(2)?}))).map_err(internal)?.collect::<Result<Vec<_>,_>>().map_err(internal)?;
        return Ok(json!({"kind":kind,"id":id,"name":name,"allowed":datasets.is_empty(),"datasets":datasets}));
    }
    let (name,category,schema): (String,String,String) = db.query_row("SELECT name,category_path,schema_id FROM datasets WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(internal)?.ok_or_else(|| ApiError(StatusCode::NOT_FOUND,"数据集不存在".into()))?;
    let title = if name.is_empty() { category.rsplit('/').next().unwrap_or(&category).to_owned() } else { name };
    let count = |sql: &str| db.query_row(sql,[id],|r|r.get::<_,u64>(0)).map_err(internal);
    let apps = affected_apps(db,id)?;
    Ok(json!({"kind":kind,"id":id,"name":title,"category_path":category,"schema_id":schema,"allowed":true,
        "records":count("SELECT COUNT(*) FROM records WHERE dataset_id=?1")?,
        "protected_fields":count("SELECT COUNT(*) FROM protected_fields WHERE record_id IN (SELECT id FROM records WHERE dataset_id=?1)")?,
        "supplements":count("SELECT COUNT(*) FROM supplement_records WHERE dataset_id=?1")?,
        "templates":count("SELECT COUNT(*) FROM import_templates WHERE dataset_id=?1")?,
        "scoped_apps":apps.len(),"disabled_apps":apps.iter().filter(|(_,scope,disabled)|scope.is_empty() && !disabled).count()
    }))
}

fn token(db: &Connection, keys: &KeySet, kind: &str, id: &str, expires: i64, impact: &Value) -> ApiResult<String> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&keys.identity[..]).map_err(internal)?;
    mac.update(b"physical-delete-v1"); mac.update(&expires.to_le_bytes());
    mac.update(&serde_json::to_vec(impact).map_err(internal)?);
    let queries: &[&str] = if kind == "schemas" {
        &["SELECT * FROM shared_schemas WHERE id=?1", "SELECT * FROM datasets WHERE schema_id=?1 ORDER BY id"]
    } else { &[
        "SELECT * FROM datasets WHERE id=?1",
        "SELECT * FROM records WHERE dataset_id=?1 ORDER BY id",
        "SELECT * FROM protected_fields WHERE record_id IN (SELECT id FROM records WHERE dataset_id=?1) ORDER BY record_id,source_key",
        "SELECT * FROM supplement_records WHERE dataset_id=?1 ORDER BY id",
        "SELECT * FROM supplement_schemas WHERE dataset_id=?1",
        "SELECT * FROM import_templates WHERE dataset_id=?1 ORDER BY name",
        "SELECT * FROM dataset_environments WHERE dataset_id=?1 ORDER BY position",
        "SELECT * FROM api_apps WHERE EXISTS(SELECT 1 FROM json_each(datasets_json) WHERE value=?1) ORDER BY id",
    ] };
    for sql in queries {
        mac.update(sql.as_bytes());
        let mut statement = db.prepare(sql).map_err(internal)?;
        let columns = statement.column_count();
        let mut rows = statement.query([id]).map_err(internal)?;
        while let Some(row) = rows.next().map_err(internal)? {
            mac.update(b"row");
            for i in 0..columns {
                use rusqlite::types::ValueRef;
                let bytes = match row.get_ref(i).map_err(internal)? {
                    ValueRef::Null => vec![0],
                    ValueRef::Integer(n) => [vec![1],n.to_le_bytes().to_vec()].concat(),
                    ValueRef::Real(n) => [vec![2],n.to_le_bytes().to_vec()].concat(),
                    ValueRef::Text(t) => [vec![3],t.to_vec()].concat(),
                    ValueRef::Blob(b) => [vec![4],b.to_vec()].concat(),
                };
                mac.update(&(bytes.len() as u64).to_le_bytes()); mac.update(&bytes);
            }
        }
    }
    Ok(hex::encode(mac.finalize().into_bytes()))
}

async fn preview(state: AppState, kind: &str, id: String) -> ApiResult<Response> {
    with_connection(&state, |db,keys| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        let mut result = impact(&tx,kind,&id)?;
        let expires = unix_now() + 600;
        let confirmation = token(&tx,keys,kind,&id,expires,&result)?;
        result["confirmation_token"] = json!(confirmation); result["expires_at"] = json!(expires);
        let mut response = Json(result).into_response();
        response.headers_mut().insert(header::CACHE_CONTROL,HeaderValue::from_static("no-store"));
        Ok(response)
    }).await
}

async fn delete(state: AppState, kind: &str, id: String, request: DeleteRequest) -> ApiResult<Json<Value>> {
    with_connection(&state, |db,keys| {
        let tx = db.unchecked_transaction().map_err(internal)?;
        let result = impact(&tx,kind,&id)?;
        if result["allowed"] != true { return Err(bad_request("数据模型仍被数据集引用，请先迁移引用或删除关联数据集")); }
        if request.expected_name != result["name"].as_str().unwrap_or("") { return Err(bad_request("确认名称不匹配，未删除任何数据")); }
        if request.expires_at < unix_now() || request.confirmation_token != token(&tx,keys,kind,&id,request.expires_at,&result)? {
            return Err(ApiError(StatusCode::CONFLICT,"删除预检已失效或数据发生变化，请重新预检并确认".into()));
        }
        if kind == "schemas" {
            tx.execute("DELETE FROM shared_schemas WHERE id=?1",[&id]).map_err(internal)?;
        } else {
            for (app, scope, disabled) in affected_apps(&tx,&id)? {
                tx.execute("UPDATE api_apps SET datasets_json=?2,disabled=?3 WHERE id=?1",params![app,serde_json::to_string(&scope).map_err(internal)?,disabled || scope.is_empty()]).map_err(internal)?;
            }
            // Explicit ordering also supports older databases without cascading FKs.
            for sql in [
                "DELETE FROM protected_fields WHERE record_id IN (SELECT id FROM records WHERE dataset_id=?1)",
                "DELETE FROM supplement_records WHERE dataset_id=?1",
                "DELETE FROM supplement_schemas WHERE dataset_id=?1",
                "DELETE FROM import_templates WHERE dataset_id=?1",
                "DELETE FROM dataset_environments WHERE dataset_id=?1",
                "DELETE FROM records WHERE dataset_id=?1",
                "DELETE FROM datasets WHERE id=?1",
            ] { tx.execute(sql,[&id]).map_err(internal)?; }
        }
        tx.execute("INSERT INTO audit_events(event,record_id) VALUES(?1,?2)",params![if kind == "schemas" {"schema_delete"} else {"dataset_delete"},id]).map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(Json(json!({"deleted":true,"id":id})))
    }).await
}

pub(super) async fn preview_dataset(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> { preview(state,"datasets",id).await }
pub(super) async fn preview_schema(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> { preview(state,"schemas",id).await }
pub(super) async fn delete_dataset(State(state): State<AppState>, Path(id): Path<String>, Json(request): Json<DeleteRequest>) -> ApiResult<Json<Value>> { delete(state,"datasets",id,request).await }
pub(super) async fn delete_schema(State(state): State<AppState>, Path(id): Path<String>, Json(request): Json<DeleteRequest>) -> ApiResult<Json<Value>> { delete(state,"schemas",id,request).await }

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn deletion_checks_impact_staleness_and_cleans_all_dependents_without_widening_grants() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("lifecycle-{}",Uuid::new_v4()));
        struct Cleanup(PathBuf); impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(directory.clone()); private_dir(&directory).unwrap();
        let state = rotation::state_for(directory);
        let (keys,_) = initialize_vault(&state,"lifecycle-test-password-2026").unwrap(); activate(&state,keys,true).await;
        async fn create(state: &AppState, body: Value) -> Value { create_dataset(State(state.clone()),Json(serde_json::from_value(body).unwrap())).await.unwrap().0 }
        let a = create(&state,json!({"category_path":"删除/实例A","environment_names":["保留标签"],"fields":[{"source_key":"code","zone":"indexes"},{"source_key":"token","zone":"secrets"}],"identity_fields":["code"],"sample_data":[{"code":"001","token":"TEST-ONLY"}]})).await;
        let id = a["dataset_id"].as_str().unwrap(); let schema = a["schema_id"].as_str().unwrap();
        let b = create(&state,json!({"category_path":"删除/实例B","schema_id":schema,"sample_data":[{"code":"002"}]})).await;
        let other = b["dataset_id"].as_str().unwrap();
        with_connection(&state,|db,_| {
            db.execute("INSERT INTO import_templates(name,dataset_id,mappings_json) VALUES('delete-test',?1,'[]')",[id]).map_err(internal)?;
            db.execute("INSERT INTO supplement_schemas(dataset_id,fields_json) VALUES(?1,'[]') ON CONFLICT DO NOTHING",[id]).map_err(internal)?;
            db.execute("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext,orphan) VALUES('orphan',?1,'missing','{}',X'00',X'00',1)",[id]).map_err(internal)?;
            for (app,scope) in [("only",json!([id])),("both",json!([id,other])),("global",json!([]))] {
                db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES(?1,?1,?1,'search',?2)",params![app,scope.to_string()]).map_err(internal)?;
            }
            Ok(())
        }).await.unwrap();
        async fn confirmation(state: &AppState, kind: &str, id: &str) -> (Value,DeleteRequest) {
            with_connection(state,|db,keys| {
                let value = impact(db,kind,id)?; let expires_at = unix_now() + 600;
                let request = DeleteRequest { confirmation_token:token(db,keys,kind,id,expires_at,&value)?,expected_name:value["name"].as_str().unwrap().into(),expires_at };
                Ok((value,request))
            }).await.unwrap()
        }
        let (info,stale) = confirmation(&state,"datasets",id).await;
        assert_eq!(info["records"],1); assert_eq!(info["protected_fields"],1); assert_eq!(info["supplements"],1); assert_eq!(info["templates"],1);
        assert_eq!(info["scoped_apps"],2); assert_eq!(info["disabled_apps"],1);
        let (_,model_request) = confirmation(&state,"schemas",schema).await;
        assert!(delete(state.clone(),"schemas",schema.into(),model_request).await.is_err());
        with_connection(&state,|db,_| { db.execute("UPDATE records SET expired=1 WHERE dataset_id=?1",[id]).map_err(internal)?; Ok(()) }).await.unwrap();
        assert_eq!(delete(state.clone(),"datasets",id.into(),stale).await.unwrap_err().0,StatusCode::CONFLICT);
        let (_,mut wrong) = confirmation(&state,"datasets",id).await; wrong.expected_name = "错误名称".into();
        assert!(delete(state.clone(),"datasets",id.into(),wrong).await.is_err());
        let (_,mut expired) = confirmation(&state,"datasets",id).await; expired.expires_at = unix_now() - 1;
        assert_eq!(delete(state.clone(),"datasets",id.into(),expired).await.unwrap_err().0,StatusCode::CONFLICT);
        with_connection(&state,|db,_| { db.execute_batch("CREATE TRIGGER deletion_failure BEFORE DELETE ON datasets BEGIN SELECT RAISE(ABORT,'test failure'); END;").map_err(internal)?; Ok(()) }).await.unwrap();
        let (_,request) = confirmation(&state,"datasets",id).await;
        assert!(delete(state.clone(),"datasets",id.into(),request).await.is_err());
        with_connection(&state,|db,_| {
            assert_eq!(impact(db,"datasets",id)?["protected_fields"],1);
            assert_eq!(impact(db,"datasets",id)?["supplements"],1);
            assert_eq!(impact(db,"datasets",id)?["templates"],1);
            assert!(!db.query_row("SELECT disabled FROM api_apps WHERE id='only'",[],|r|r.get::<_,bool>(0)).unwrap());
            assert_eq!(affected_apps(db,id)?.len(),2);
            db.execute_batch("DROP TRIGGER deletion_failure").map_err(internal)?; Ok(())
        }).await.unwrap();
        let (_,request) = confirmation(&state,"datasets",id).await;
        assert_eq!(delete(state.clone(),"datasets",id.into(),request).await.unwrap().0["deleted"],true);
        with_connection(&state,|db,_| {
            for table in ["records","supplement_records","supplement_schemas","import_templates","dataset_environments"] {
                assert_eq!(db.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE dataset_id=?1"),[id],|r|r.get::<_,i64>(0)).unwrap(),0);
            }
            assert_eq!(db.query_row("SELECT COUNT(*) FROM protected_fields",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            assert_eq!(db.query_row("SELECT COUNT(*) FROM records WHERE dataset_id=?1",[other],|r|r.get::<_,i64>(0)).unwrap(),1);
            assert_eq!(db.query_row("SELECT COUNT(*) FROM shared_schemas WHERE id=?1",[schema],|r|r.get::<_,i64>(0)).unwrap(),1);
            assert_eq!(db.query_row("SELECT COUNT(*) FROM environments WHERE name='保留标签'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
            let (scope,disabled):(String,bool) = db.query_row("SELECT datasets_json,disabled FROM api_apps WHERE id='only'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(scope,"[]"); assert!(disabled);
            let scope:String = db.query_row("SELECT datasets_json FROM api_apps WHERE id='both'",[],|r|r.get(0)).unwrap(); assert_eq!(serde_json::from_str::<Value>(&scope).unwrap(),json!([other]));
            assert!(!db.query_row("SELECT disabled FROM api_apps WHERE id='global'",[],|r|r.get::<_,bool>(0)).unwrap());
            assert_eq!(db.query_row("SELECT COUNT(*) FROM audit_events WHERE event='dataset_delete'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
            assert!(db.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
            Ok(())
        }).await.unwrap();
        let (_,request) = confirmation(&state,"datasets",other).await;
        delete(state.clone(),"datasets",other.into(),request).await.unwrap();
        let (model,request) = confirmation(&state,"schemas",schema).await; assert_eq!(model["allowed"],true);
        delete(state.clone(),"schemas",schema.into(),request).await.unwrap();
        assert!(preview(state.clone(),"schemas",schema.into()).await.is_err());
        assert!(preview(state,"datasets",id.into()).await.is_err());
    }
}
