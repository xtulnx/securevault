use super::*;

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn database(count: usize, supplements: bool) -> (AppState, Cleanup) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("samples/.build");
    fs::create_dir_all(&root).unwrap();
    let directory = root.join(format!("search-performance-{}", Uuid::new_v4()));
    private_dir(&directory).unwrap();
    let state = rotation::state_for(directory.clone());
    let (keys, _) = initialize_vault(&state, "PERFORMANCE-TEST-ONLY-2026").unwrap();
    activate(&state, keys, true).await;
    let rows = tests::fixtures(count);
    let (mut fields, identity, display) = tests::schemas().remove("ds").unwrap();
    fields.push(
        serde_json::from_value(json!({"source_key":"description","zone":"display"})).unwrap(),
    );
    fields.push(serde_json::from_value(json!({"source_key":"secret","zone":"secrets"})).unwrap());
    with_connection(&state, |db, keys| {
        let tx = db.unchecked_transaction().unwrap();
        tx.execute("INSERT INTO datasets(id,category_path,environment,fields_json,identity_fields_json,conflict_strategy,display_config_json) VALUES('ds','业务/产品','prod',?1,?2,'allow_mark',?3)",
            params![serde_json::to_string(&fields).unwrap(), serde_json::to_string(&identity).unwrap(), serde_json::to_string(&display).unwrap()]).unwrap();
        let supplement_fields = json!([{"source_key":"code","zone":"indexes"},{"source_key":"a","zone":"display"}]);
        tx.execute("INSERT INTO supplement_schemas(dataset_id,fields_json) VALUES('ds',?1)", [supplement_fields.to_string()]).unwrap();
        let mut insert = tx.prepare("INSERT INTO records(id,dataset_id,category_path,environment,indexes_json,display_json,search_blob,expired,updated_at) VALUES(?1,'ds',?2,?3,?4,?5,'',?6,?7)").unwrap();
        let mut secret = tx.prepare("INSERT INTO protected_fields(record_id,source_key,zone,nonce,ciphertext) VALUES(?1,'secret','secrets',?2,?3)").unwrap();
        let mut extension = tx.prepare("INSERT INTO supplement_records(id,dataset_id,main_record_id,link_json,nonce,ciphertext) VALUES(?1,'ds',?2,'{}',?3,?4)").unwrap();
        for (i, row) in rows.iter().enumerate() {
            let id = row["id"].as_str().unwrap();
            insert.execute(params![id, row["category"].as_str(), row["environment"].as_str(), row["indexes"].to_string(), row["display"].to_string(), row["expired"].as_bool(), row["updated"].as_str()]).unwrap();
            if i % 10 == 0 {
                let (nonce, ciphertext) = seal_field(&keys.field, id, "secret", &json!("FAKE-TEST-SECRET")).unwrap();
                secret.execute(params![id, nonce, ciphertext]).unwrap();
            }
            if supplements && !row["supplement"].is_null() {
                let extension_id = format!("ext-{id}");
                let data = json!({"code":row["supplement"]["indexes"]["code"],"a":row["supplement"]["display"]["a"]});
                let (nonce, ciphertext) = seal_field(&keys.field, &extension_id, "supplement", &data).unwrap();
                extension.execute(params![extension_id, id, nonce, ciphertext]).unwrap();
            }
        }
        drop(insert); drop(secret); drop(extension);
        tx.commit().unwrap();
        Ok(())
    }).await.unwrap();
    (state, Cleanup(directory))
}

fn owner() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-vault-owner", HeaderValue::from_static("true"));
    headers
}

async fn run(state: &AppState, query: &Value, baseline: bool) -> Value {
    let query: SearchQuery = serde_json::from_value(query.clone()).unwrap();
    if baseline {
        reference_endpoint::search(State(state.clone()), Query(query), owner())
            .await
            .unwrap()
            .0
    } else {
        search_records(State(state.clone()), Query(query), owner())
            .await
            .unwrap()
            .0
    }
}

#[tokio::test]
async fn api_pages_and_secret_metadata_equal_the_previous_endpoint() {
    let (state, _cleanup) = database(129, true).await;
    for query in [
        "",
        "1",
        "a",
        "=1",
        "=业务",
        "alpha beta",
        "code:~[α-ω]+",
        "code:~^",
        "category:=业务 env:=prod a",
        "附表.code:=1",
    ] {
        for page in [0, 1, 2, 8] {
            let query = json!({"q":query,"page":page,"limit":17,"include_expired":true});
            assert_eq!(
                run(&state, &query, false).await,
                run(&state, &query, true).await,
                "query={query}"
            );
        }
    }
    for query in [
        json!({"q":"a","category":"业务","environment":"prod"}),
        json!({"q":"a","categories":"[\"业务\",\"业务/产品\"]"}),
        json!({"q":"a","dataset_id":"missing"}),
        json!({"q":"a","page":usize::MAX}),
        json!({"q":"a","limit":0}),
    ] {
        assert_eq!(
            run(&state, &query, false).await,
            run(&state, &query, true).await,
            "query={query}"
        );
    }
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

// Release-mode handler comparison; no HTTP transport or browser overhead.
// Run explicitly so normal correctness tests stay quick and deterministic.
#[tokio::test]
#[ignore = "release performance comparison with isolated SQLCipher fixtures"]
async fn search_performance_comparison() {
    let mut results = Vec::new();
    for count in [2_000, 20_000, 100_000] {
        let (state, _cleanup) = database(count, true).await;
        for (q, page) in [
            ("1", 1),
            ("a", 1),
            ("1", 10),
            ("key:=1", 1),
            ("code:~[α-ω]+", 1),
        ] {
            let query = json!({"q":q,"page":page,"limit":30,"include_expired":true});
            let expected = run(&state, &query, true).await;
            assert_eq!(run(&state, &query, false).await, expected);
            let mut before = Vec::new();
            let mut after = Vec::new();
            for round in 0..5 {
                for baseline in if round % 2 == 0 {
                    [true, false]
                } else {
                    [false, true]
                } {
                    let start = Instant::now();
                    let actual = std::hint::black_box(run(&state, &query, baseline).await);
                    let elapsed = start.elapsed().as_secs_f64() * 1_000.0;
                    assert_eq!(actual, expected);
                    if baseline {
                        before.push(elapsed);
                    } else {
                        after.push(elapsed);
                    }
                }
            }
            let before_ms = median(before);
            let after_ms = median(after);
            let matches = expected["total"].as_u64().unwrap();
            let entry = json!({"rows":count,"query":q,"page":page,"limit":30,"matches":matches,"baseline_median_ms":before_ms,
                "optimized_median_ms":after_ms,"speedup":before_ms/after_ms,"baseline_retained_rows":matches,
                "optimized_retained_rows_bound":matches.min(page as u64 * 30),"samples":5,"response_equal":true});
            println!("PERF {entry}");
            results.push(entry);
        }
    }
    let report = json!({"profile":"release","platform":std::env::consts::OS,"arch":std::env::consts::ARCH,
        "fixture":"isolated SQLCipher database; 6 public fields, one encrypted supplement per 3 rows, one protected field per 10 rows",
        "measurement":"search handler including DB open, SQL, supplement decryption, JSON parsing, matching, ranking, pagination and highlights; excludes HTTP/UI",
        "results":results});
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("samples/.build/search-performance-results.json");
    fs::write(output, serde_json::to_string_pretty(&report).unwrap()).unwrap();
}
