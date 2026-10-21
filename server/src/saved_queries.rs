use super::*;

// Stored inside the SQLCipher vault, never in browser storage. Owner-only routes
// use the existing security middleware; app credentials cannot access queries.
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Filters {
    q: String,
    categories: Vec<String>,
    labels: Vec<String>,
    schema_id: Option<String>,
    dataset_id: Option<String>,
    include_expired: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedQuery {
    name: String,
    filters: Filters,
}

pub(super) fn initialize(db: &Connection) -> ApiResult<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS saved_queries(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, filters_json TEXT NOT NULL
    );").map_err(internal)
}

pub(super) fn validate(request: &SavedQuery) -> ApiResult<()> {
    let name = request.name.trim();
    let f = &request.filters;
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(bad_request("查询名称需为 1 至 80 个字符，不能包含控制字符"));
    }
    if f.q.len() > 8192 || f.categories.len() > 128 || f.labels.len() > 64
        || f.categories.iter().chain(f.labels.iter()).any(|s| s.is_empty() || s.len() > 1024)
        || [&f.schema_id, &f.dataset_id].into_iter().flatten().any(|s| s.is_empty() || s.len() > 128)
    {
        return Err(bad_request("查询条件过长或无效"));
    }
    Ok(())
}

fn write(db: &Connection, id: Option<&str>, request: &SavedQuery) -> ApiResult<Value> {
    validate(request)?;
    let tx = db.unchecked_transaction().map_err(internal)?;
    if let Some(id) = id {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM saved_queries WHERE id=?1)", [id], |r| r.get(0)).map_err(internal)?;
        if !exists { return Err(ApiError(StatusCode::NOT_FOUND, "常用查询不存在，请刷新列表".into())); }
    } else {
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM saved_queries", [], |r| r.get(0)).map_err(internal)?;
        if count >= 50 { return Err(bad_request("最多保存 50 个常用查询")); }
    }
    let name = request.name.trim();
    let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM saved_queries WHERE name=?1 AND id<>?2)", params![name, id.unwrap_or("")], |r| r.get(0)).map_err(internal)?;
    if duplicate { return Err(bad_request("查询名称已存在，请修改名称")); }
    let id = id.map(str::to_owned).unwrap_or_else(|| format!("query_{}", Uuid::new_v4().simple()));
    let raw = serde_json::to_string(&request.filters).map_err(internal)?;
    tx.execute("INSERT INTO saved_queries(id,name,filters_json) VALUES(?1,?2,?3)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters_json=excluded.filters_json",
        params![id, name, raw]).map_err(internal)?;
    tx.commit().map_err(internal)?;
    Ok(json!({"id":id,"name":name,"filters":request.filters}))
}

pub(super) async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, _| {
        let mut stmt = db.prepare("SELECT id,name,filters_json FROM saved_queries ORDER BY name,id").map_err(internal)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(internal)?;
        let mut queries = Vec::new();
        for row in rows {
            let (id, name, raw) = row.map_err(internal)?;
            queries.push(json!({"id":id,"name":name,"filters":serde_json::from_str::<Filters>(&raw).map_err(internal)?}));
        }
        Ok(Json(json!({"queries":queries})))
    }).await
}

pub(super) async fn create(State(state): State<AppState>, Json(request): Json<SavedQuery>) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, _| write(db, None, &request).map(Json)).await
}

pub(super) async fn update(State(state): State<AppState>, Path(id): Path<String>, Json(request): Json<SavedQuery>) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, _| write(db, Some(&id), &request).map(Json)).await
}

pub(super) async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, _| {
        db.execute("DELETE FROM saved_queries WHERE id=?1", [id]).map_err(internal)?;
        Ok(Json(json!({"deleted":true})))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[tokio::test]
    async fn encrypted_queries_survive_reunlock_and_crud_requires_unlocked_vault() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../samples/.build")
            .join(format!("saved-queries-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        private_dir(&dir).unwrap();
        let _cleanup = Cleanup(dir.clone());
        let state = rotation::state_for(dir);
        let password = "query-regression-password";
        let (keys, _) = initialize_vault(&state, password).unwrap();
        activate(&state, keys, true).await;
        let saved = create(State(state.clone()), Json(SavedQuery {
            name: "private-query-name".into(),
            filters: Filters { q: "private-search-value".into(), ..Filters::default() },
        })).await.unwrap().0;
        assert_eq!(list(State(state.clone())).await.unwrap().0["queries"].as_array().unwrap().len(), 1);
        let _ = vault_seal(State(state.clone())).await;
        assert!(list(State(state.clone())).await.is_err());
        let bytes = fs::read(database_path(&state)).unwrap();
        assert!(!bytes.windows(b"private-search-value".len()).any(|part| part == b"private-search-value"));
        let keys = unwrap_keys(password, &read_meta(&state).unwrap()).unwrap();
        activate(&state, keys, true).await;
        assert_eq!(list(State(state.clone())).await.unwrap().0["queries"][0]["filters"]["q"], "private-search-value");
        let id = saved["id"].as_str().unwrap().to_owned();
        let _ = update(State(state.clone()), Path(id.clone()), Json(SavedQuery { name: "renamed".into(), filters: Filters::default() })).await.unwrap();
        assert_eq!(list(State(state.clone())).await.unwrap().0["queries"][0]["name"], "renamed");
        let _ = delete(State(state.clone()), Path(id)).await.unwrap();
        assert_eq!(list(State(state)).await.unwrap().0["queries"], json!([]));
    }
    #[test]
    fn queries_preserve_typed_filters_and_update_without_overwriting_other_names() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        initialize(&db).unwrap();
        let mut request: SavedQuery = serde_json::from_value(json!({"name":"生产账户","filters":{
            "q":"enabled:=false", "categories":["业务/账户"],"labels":["生产","内部"],
            "schema_id":"schema-a","dataset_id":"ds-a","include_expired":true
        }})).unwrap();
        let result = write(&db, None, &request).unwrap();
        assert!(write(&db, None, &request).is_err());
        request.name = "已更新".into();
        request.filters.q = "count:=0".into();
        write(&db, Some(result["id"].as_str().unwrap()), &request).unwrap();
        let raw: String = db.query_row("SELECT filters_json FROM saved_queries", [], |r| r.get(0)).unwrap();
        let filters: Filters = serde_json::from_str(&raw).unwrap();
        assert_eq!(filters.q, "count:=0");
        assert_eq!(filters.labels, ["生产", "内部"]);
        assert!(filters.include_expired);
        assert!(write(&db, Some("missing"), &request).is_err());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM saved_queries", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test]
    fn query_limits_and_unknown_fields_are_rejected() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        assert!(serde_json::from_value::<SavedQuery>(json!({"name":"x","filters":{"credentials":"secret"}})).is_err());
        let mut request = SavedQuery { name:" ".into(), filters:Filters::default() };
        assert!(write(&db, None, &request).is_err());
        request.name = "query".into();
        request.filters.q = "x".repeat(8193);
        assert!(write(&db, None, &request).is_err());
        request.filters.q.clear();
        request.filters.labels = (0..65).map(|i| format!("label-{i}")).collect();
        assert!(write(&db, None, &request).is_err());
        request.filters.labels.truncate(64);
        assert!(validate(&request).is_ok());
        request.filters.labels.clear();
        for i in 0..50 { request.name = format!("query-{i}"); write(&db, None, &request).unwrap(); }
        request.name = "overflow".into();
        assert!(write(&db, None, &request).is_err());
    }
}
