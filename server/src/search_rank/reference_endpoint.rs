// Frozen full-sort endpoint, used only by equivalence and performance tests.
use super::*;

pub(super) async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let limit = query.limit.clamp(1, 100);
    let offset = query.page.saturating_sub(1).saturating_mul(limit);
    let clauses = parse_search_clauses(&query.q)?;
    let categories = match query.categories.as_deref() {
        Some(raw) => {
            let paths: Vec<String> = serde_json::from_str(raw)
                .map_err(|_| bad_request("categories 必须是目录路径的 JSON 数组"))?;
            if paths.len() > 128 {
                return Err(bad_request("最多选择 128 个目录"));
            }
            paths
                .iter()
                .map(|path| normalize_category(path))
                .collect::<ApiResult<Vec<_>>>()?
        }
        None => Vec::new(),
    };
    with_connection(&state, |connection, keys| {
        let dataset_scope = authorized_dataset_scope(connection, &headers, "search")?;
        let supplements = supplement::searchable(connection, keys, dataset_scope.as_deref(), query.dataset_id.as_deref())?;
        let mut datasets = connection.prepare("SELECT id,fields_json,identity_fields_json,display_config_json FROM datasets").map_err(internal)?;
        let definitions = datasets.query_map([], |row| Ok((row.get::<_, String>(0)?, (
            serde_json::from_str::<Vec<FieldDefinition>>(&row.get::<_, String>(1)?).unwrap_or_default(),
            serde_json::from_str::<Vec<String>>(&row.get::<_, String>(2)?).unwrap_or_default(),
            serde_json::from_str::<DisplayConfig>(&row.get::<_, String>(3)?).unwrap_or_default(),
        )))).map_err(internal)?.collect::<Result<std::collections::HashMap<_, _>, _>>().map_err(internal)?;
        let mut sql = String::from("SELECT id,dataset_id,category_path,environment,indexes_json,display_json,updated_at,duplicate_of,(SELECT COUNT(*) FROM protected_fields p WHERE p.record_id=r.id AND p.zone='secrets'),(SELECT json_group_array(source_key) FROM protected_fields p WHERE p.record_id=r.id AND p.zone='secrets'),expired FROM records r WHERE 1=1");
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(dataset_id) = query.dataset_id.as_ref() { sql.push_str(" AND r.dataset_id=?"); values.push(dataset_id.clone().into()); }
        if !query.include_expired { sql.push_str(" AND expired=0"); }
        if let Some(category) = query.category.as_ref() { sql.push_str(" AND (category_path=? OR category_path LIKE ? ESCAPE '\\')"); values.push(category.clone().into()); values.push(format!("{}/%", category.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")).into()); }
        if !categories.is_empty() {
            sql.push_str(" AND (");
            for (index, category) in categories.iter().enumerate() {
                if index > 0 { sql.push_str(" OR "); }
                sql.push_str("(category_path=? OR category_path LIKE ? ESCAPE '\\')");
                values.push(category.clone().into());
                values.push(format!("{}/%", category.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")).into());
            }
            sql.push(')');
        }
        if let Some(environment) = query.environment.as_ref() { sql.push_str(" AND environment=?"); values.push(environment.clone().into()); }
        let mut statement=connection.prepare(&sql).map_err(internal)?;
        let rows=statement.query_map(rusqlite::params_from_iter(values), |row| {
            let category = row.get::<_,String>(2)?;
            let environment = row.get::<_,Option<String>>(3)?;
            let indexes: Value=serde_json::from_str(&row.get::<_,String>(4)?).unwrap_or(Value::Null);
            let display: Value=serde_json::from_str(&row.get::<_,String>(5)?).unwrap_or(Value::Null);
            let secret_fields: Value=serde_json::from_str(&row.get::<_,String>(9)?).unwrap_or(Value::Array(vec![]));
            let dataset_id = row.get::<_,String>(1)?;
            let (display, _) = split_display_fields(&display, definitions.get(&dataset_id).map(|schema| schema.0.as_slice()).unwrap_or_default());
            if dataset_scope.as_ref().is_some_and(|allowed| !allowed.iter().any(|candidate| candidate == &dataset_id)) { return Ok(None); }
            let id=row.get::<_,String>(0)?;
            let extension=supplements.get(&id).cloned().unwrap_or(Value::Null);
            let (matches,matched)=combined_search(&clauses,&category,environment.as_deref(),&dataset_id,&indexes,&display,&extension);
            if !matches {return Ok(None);}
            Ok(Some(json!({"id":row.get::<_,String>(0)?,"dataset_id":dataset_id,"category":category,"environment":environment,"indexes":indexes,"display":display,"updated":row.get::<_,String>(6)?,"duplicate_of":row.get::<_,Option<String>>(7)?,"secret_count":row.get::<_,i64>(8)?,"secret_fields":secret_fields,"matched_fields":matched,"supplement":extension,"expired":row.get::<_,bool>(10)?})))
        }).map_err(internal)?;
        let mut all_records: Vec<Value> = rows.filter_map(|row| row.map_err(internal).transpose()).collect::<ApiResult<Vec<_>>>()?;
        reference::sort(&mut all_records, &clauses, &definitions);
        let total = all_records.len();
        let mut records = all_records.into_iter().skip(offset).take(limit).collect::<Vec<_>>();
        for record in &mut records { record["match_info"] = match_highlights(&clauses,record); }
        Ok(Json(json!({"records":records,"page":query.page.max(1),"limit":limit,"total":total})))
    }).await
}
