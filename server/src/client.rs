use super::*;

// A separate read-only surface keeps management schemas and routes unchanged.
// Return only the display metadata for datasets authorized to this caller.
pub(super) async fn datasets(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    with_connection(&state, |db, _| {
        let scope = authorized_dataset_scope(db, &headers, "search")?;
        let mut statement = db.prepare(
            "SELECT id,category_path,environment,fields_json,identity_fields_json,
                    list_fields_json,display_config_json,description
             FROM datasets ORDER BY category_path,environment,id",
        ).map_err(internal)?;
        let mut rows = statement.query([]).map_err(internal)?;
        let mut datasets = Vec::new();
        while let Some(row) = rows.next().map_err(internal)? {
            let id: String = row.get(0).map_err(internal)?;
            if scope.as_ref().is_some_and(|allowed| !allowed.contains(&id)) { continue; }
            let definitions: Vec<FieldDefinition> = serde_json::from_str(
                &row.get::<_, String>(3).map_err(internal)?,
            ).map_err(internal)?;
            let public_key = |key: &str| definitions.iter().any(|field|
                field.source_key == key && matches!(field.zone.as_str(), "indexes" | "display"));
            let identity: Vec<String> = serde_json::from_str(
                &row.get::<_, String>(4).map_err(internal)?,
            ).map_err(internal)?;
            // Never turn a mixed public/protected composite KEY into a partial KEY.
            let identity = if identity.iter().all(|key| public_key(key)) { identity } else { Vec::new() };
            let list: Vec<ListFieldDefinition> = serde_json::from_str(
                &row.get::<_, String>(5).map_err(internal)?,
            ).map_err(internal)?;
            let mut config: DisplayConfig = serde_json::from_str(
                &row.get::<_, String>(6).map_err(internal)?,
            ).map_err(internal)?;
            config.identifier_fields.retain(|key| public_key(key));
            datasets.push(json!({
                "id": id,
                "category_path": row.get::<_, String>(1).map_err(internal)?,
                "environment": row.get::<_, Option<String>>(2).map_err(internal)?,
                "fields": display_fields(&definitions),
                "supplement_fields": display_fields(&supplement::fields(db, &id)?),
                "identity_fields": identity,
                "list_fields": list.into_iter().filter(|field| public_key(&field.source_key)).collect::<Vec<_>>(),
                "display_config": config,
                "description": row.get::<_, String>(7).map_err(internal)?,
            }));
        }
        for dataset in &mut datasets { catalog::enrich(db,dataset)?; }
        Ok(Json(json!({ "datasets": datasets })))
    }).await
}

fn display_fields(fields: &[FieldDefinition]) -> Vec<Value> {
    fields
        .iter()
        .filter(|field| matches!(field.zone.as_str(), "indexes" | "display" | "normal"))
        .map(|field| {
            json!({
                "source_key": field.source_key, "display_name": field.display_name,
                "zone": field.zone, "position": field.position,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn client_metadata_keeps_dataset_scope_and_omits_protected_and_management_schema() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("samples/.build");
        fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("client-metadata-{}", Uuid::new_v4()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone());
        private_dir(&directory).unwrap();
        let state = rotation::state_for(directory);
        let (keys, _) = initialize_vault(&state, "client-metadata-test-123").unwrap();
        activate(&state, keys, true).await;
        with_connection(&state, |db, _| {
            let fields = json!([
                {"source_key":"code","display_name":"编号","zone":"indexes"},
                {"source_key":"notes","zone":"normal"},
                {"source_key":"secret","zone":"secrets"},
                {"source_key":"hidden","zone":"hidden"},
                {"source_key":"ignored","zone":"ignore"}
            ]).to_string();
            for id in ["allowed", "denied"] {
                db.execute("INSERT INTO datasets(id,category_path,fields_json,identity_fields_json,conflict_strategy,list_fields_json,description,display_config_json) VALUES(?1,?1,?2,'[\"code\",\"secret\"]','reject','[{\"source_key\":\"code\",\"visible\":true},{\"source_key\":\"hidden\",\"visible\":false}]','说明','{\"identifier_fields\":[\"code\"]}')", params![id, fields]).unwrap();
                db.execute("INSERT INTO supplement_schemas(dataset_id,fields_json) VALUES(?1,?2)", params![id, fields]).unwrap();
            }
            db.execute("INSERT INTO api_apps(id,name,key_hash,permission,datasets_json) VALUES('app','client',?1,'search','[\"allowed\"]')", [app_key_hash("test-key")]).unwrap();
            Ok(())
        }).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-app-id", HeaderValue::from_static("app"));
        headers.insert("x-app-key", HeaderValue::from_static("test-key"));
        let result = datasets(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(result["datasets"].as_array().unwrap().len(), 1);
        let dataset = &result["datasets"][0];
        assert_eq!(dataset["id"], "allowed");
        for key in ["fields", "supplement_fields"] {
            assert_eq!(
                dataset[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|field| field["source_key"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["code", "notes"]
            );
        }
        assert_eq!(dataset["identity_fields"], json!([]));
        assert_eq!(dataset["list_fields"].as_array().unwrap().len(), 1);
        assert_eq!(
            dataset["display_config"]["identifier_fields"],
            json!(["code"])
        );
        assert!(dataset.get("conflict_strategy").is_none());
        assert!(!result.to_string().contains("denied"));
        assert_eq!(
            datasets(State(state.clone()), HeaderMap::new())
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        headers.insert("x-app-key", HeaderValue::from_static("wrong-key"));
        assert_eq!(
            datasets(State(state.clone()), headers.clone())
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        headers.insert("x-app-key", HeaderValue::from_static("test-key"));
        with_connection(&state, |db, _| {
            db.execute("UPDATE api_apps SET datasets_json='[]' WHERE id='app'", [])
                .unwrap();
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            datasets(State(state.clone()), headers.clone())
                .await
                .unwrap()
                .0,
            json!({"datasets":[]})
        );
        state.runtime.lock().await.keys = None;
        assert_eq!(
            datasets(State(state), headers).await.unwrap_err().0,
            StatusCode::LOCKED
        );
    }
}
