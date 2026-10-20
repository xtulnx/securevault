use super::*;
use std::{
    borrow::Cow,
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
};

pub(super) type DatasetSchema = (Vec<FieldDefinition>, Vec<String>, DisplayConfig);

#[derive(Default, PartialEq, Eq, PartialOrd, Ord)]
struct Relevance {
    whole_phrase: bool,
    qualities: Vec<u8>,
    concentration: usize,
    roles: Vec<u8>,
    coverage: u64,
}

#[derive(Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Hit {
    quality: u8,
    role: u8,
    coverage: u32,
}
#[derive(Default)]
struct FieldHits {
    best: Hit,
    clauses: usize,
}

fn is_scope_clause(clause: &SearchClause) -> bool {
    matches!(
        clause.field.as_deref(),
        Some("category" | "env" | "environment" | "dataset" | "dataset_id")
    )
}

fn unique_clauses(clauses: &[SearchClause]) -> Vec<&SearchClause> {
    let mut result: Vec<&SearchClause> = Vec::new();
    for clause in clauses.iter().filter(|clause| !is_scope_clause(clause)) {
        if !result.iter().any(|previous| {
            previous.field == clause.field
                && previous.operator == clause.operator
                && if clause.operator == SearchOperator::Regex {
                    previous.value == clause.value
                } else {
                    previous.value.to_lowercase() == clause.value.to_lowercase()
                }
        }) {
            result.push(clause);
        }
    }
    result
}

fn word_char(char: char) -> bool {
    char.is_alphanumeric() || char == '_'
}
fn range_quality(text: &str, start: usize, end: usize) -> u8 {
    if start == end {
        return 0;
    }
    if start == 0 && end == text.len() {
        return 4;
    }
    let left = text[..start]
        .chars()
        .next_back()
        .is_none_or(|char| !word_char(char));
    let right = text[end..]
        .chars()
        .next()
        .is_none_or(|char| !word_char(char));
    if left && right {
        3
    } else if start == 0 || end == text.len() {
        2
    } else {
        1
    }
}

// None is a failed match, Some((0, 0)) is a valid zero-width regex match.
// Literal query normalization is prepared once, and ranges are streamed.
fn strength(text: &str, clause: &SearchClause, needle: &str) -> Option<(u8, u32)> {
    if let Some(regex) = clause.regex.as_ref() {
        let length = text.chars().count().max(1) as u64;
        return regex
            .find_iter(text)
            .map(|hit| {
                (
                    range_quality(text, hit.start(), hit.end()),
                    (text[hit.start()..hit.end()].chars().count() as u64 * 10_000 / length) as u32,
                )
            })
            .max();
    }
    // Exact filtering has always used ASCII case folding. Keep that semantic
    // even though ranking normalizes Unicode for its coverage calculation.
    if clause.operator == SearchOperator::Exact && !text.eq_ignore_ascii_case(&clause.value) {
        return None;
    }
    let text = text.to_lowercase();
    let length = text.chars().count().max(1) as u64;
    let coverage = (needle.chars().count() as u64 * 10_000 / length) as u32;
    let hit = |start: usize| (range_quality(&text, start, start + needle.len()), coverage);
    match clause.operator {
        SearchOperator::Exact => Some(hit(0)),
        SearchOperator::Prefix => text.starts_with(needle).then(|| hit(0)),
        SearchOperator::Suffix => text
            .ends_with(needle)
            .then(|| hit(text.len() - needle.len())),
        _ => text
            .match_indices(needle)
            .map(|(start, _)| hit(start))
            .max(),
    }
}

#[cfg(test)]
fn match_strength(text: &str, clause: &SearchClause) -> (u8, u32) {
    strength(text, clause, &clause.value.to_lowercase()).unwrap_or_default()
}

#[derive(Clone, Copy)]
enum FieldValue<'a> {
    Text(&'a str),
    Json(&'a Value),
}
impl FieldValue<'_> {
    fn text(&self) -> Cow<'_, str> {
        match self {
            Self::Text(text) => Cow::Borrowed(text),
            Self::Json(Value::String(text)) => Cow::Borrowed(text),
            Self::Json(value) => Cow::Owned(value.to_string()),
        }
    }
    fn meaningful(&self) -> bool {
        match self {
            Self::Text(text) => !text.trim().is_empty(),
            Self::Json(value) => {
                !value.is_null() && value.as_str().is_none_or(|text| !text.trim().is_empty())
            }
        }
    }
}

pub(super) struct RecordView<'a> {
    pub category: &'a str,
    pub environment: Option<&'a str>,
    pub environments: &'a [String],
    pub dataset_id: &'a str,
    pub indexes: &'a Value,
    pub display: &'a Value,
    pub supplement: &'a Value,
}

// Borrow field values instead of cloning every JSON value for every clause.
// These are the existing main/supplement namespace resolution rules.
fn candidates<'a>(
    clause: &SearchClause,
    record: &RecordView<'a>,
) -> Vec<(Cow<'a, str>, FieldValue<'a>)> {
    let field = clause.field.as_deref();
    let explicit = field.and_then(|field| {
        field
            .strip_prefix("supplement.")
            .or_else(|| field.strip_prefix("附表."))
    });
    let mut result = Vec::new();
    if explicit.is_none() {
        match field {
            Some("category") => {
                result.push((Cow::Borrowed("category"), FieldValue::Text(record.category)))
            }
            Some("env" | "environment") => {
                for env in record.environments.iter().map(String::as_str).chain(record.environment) {
                    result.push((Cow::Borrowed("environment"), FieldValue::Text(env)));
                }
            }
            Some("dataset" | "dataset_id") => result.push((
                Cow::Borrowed("dataset"),
                FieldValue::Text(record.dataset_id),
            )),
            Some(field) => {
                let key = field
                    .strip_prefix("indexes.")
                    .or_else(|| field.strip_prefix("display."))
                    .unwrap_or(field);
                let found = record
                    .indexes
                    .as_object()
                    .and_then(|map| map.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)))
                    .or_else(|| {
                        record.display.as_object().and_then(|map| {
                            map.iter().find(|(name, _)| name.eq_ignore_ascii_case(key))
                        })
                    });
                if let Some((name, value)) = found {
                    result.push((Cow::Borrowed(name.as_str()), FieldValue::Json(value)));
                }
            }
            None => {
                result.push((Cow::Borrowed("category"), FieldValue::Text(record.category)));
                for env in record.environments.iter().map(String::as_str).chain(record.environment) {
                    result.push((Cow::Borrowed("environment"), FieldValue::Text(env)));
                }
                for map in [record.indexes, record.display] {
                    for (name, value) in map.as_object().into_iter().flat_map(|map| map.iter()) {
                        result.push((Cow::Borrowed(name.as_str()), FieldValue::Json(value)));
                    }
                }
            }
        }
    }
    let main_only = field.is_some_and(|field| {
        field.starts_with("indexes.")
            || field.starts_with("display.")
            || matches!(
                field,
                "category" | "env" | "environment" | "dataset" | "dataset_id"
            )
    });
    if !main_only {
        let selected = explicit.or(field);
        let (area, key) = selected
            .map(|field| {
                if let Some(key) = field.strip_prefix("indexes.") {
                    (Some("indexes"), Some(key))
                } else if let Some(key) = field.strip_prefix("display.") {
                    (Some("display"), Some(key))
                } else {
                    (None, Some(field))
                }
            })
            .unwrap_or((None, None));
        for zone in ["indexes", "display"] {
            if area.is_some_and(|area| area != zone) {
                continue;
            }
            for (name, value) in record.supplement[zone]
                .as_object()
                .into_iter()
                .flat_map(|map| map.iter())
            {
                if key.is_none_or(|key| name.eq_ignore_ascii_case(key)) {
                    result.push((
                        Cow::Owned(format!("supplement.{name}")),
                        FieldValue::Json(value),
                    ));
                }
            }
        }
    }
    result
}

fn field_role(
    field: &str,
    value: FieldValue<'_>,
    record: &RecordView<'_>,
    schema: Option<&DatasetSchema>,
) -> u8 {
    if field.starts_with("supplement.") {
        return 1;
    }
    if matches!(field, "category" | "environment" | "dataset") {
        return 0;
    }
    if let Some((fields, identity, display)) = schema {
        let public = fields.iter().any(|definition| {
            definition.source_key == field
                && matches!(definition.zone.as_str(), "indexes" | "display")
        });
        if value.meaningful() && public && identity.iter().any(|key| key == field) {
            return 5;
        }
        if value.meaningful() && public && display.identifier_fields.iter().any(|key| key == field)
        {
            return 4;
        }
    }
    if record.indexes.get(field).is_some() {
        3
    } else {
        2
    }
}

struct PreparedClause<'a> {
    clause: &'a SearchClause,
    needle: String,
    relevant: bool,
}
pub(super) struct SearchPlan<'a> {
    clauses: Vec<PreparedClause<'a>>,
    phrase: Option<SearchClause>,
}
pub(super) struct Evaluation {
    relevance: Relevance,
    pub matched_fields: Vec<String>,
}
impl<'a> SearchPlan<'a> {
    pub fn new(clauses: &'a [SearchClause]) -> Self {
        let unique = unique_clauses(clauses);
        let phrase = (unique.len() > 1
            && unique.iter().all(|clause| {
                clause.field.is_none() && clause.operator == SearchOperator::Contains
            }))
        .then(|| SearchClause {
            field: None,
            operator: SearchOperator::Exact,
            regex: None,
            value: unique
                .iter()
                .map(|clause| clause.value.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        });
        Self {
            clauses: clauses
                .iter()
                .map(|clause| PreparedClause {
                    clause,
                    needle: clause.value.to_lowercase(),
                    relevant: unique.iter().any(|unique| std::ptr::eq(*unique, clause)),
                })
                .collect(),
            phrase,
        }
    }
    pub fn evaluate(
        &self,
        record: &RecordView<'_>,
        schema: Option<&DatasetSchema>,
    ) -> Option<Evaluation> {
        let mut score = Relevance::default();
        let mut fields = HashMap::<String, FieldHits>::new();
        let mut matched_fields = Vec::new();
        for prepared in &self.clauses {
            let clause = prepared.clause;
            let mut any = false;
            let mut best = Hit::default();
            for (field, value) in candidates(clause, record) {
                let text = value.text();
                let hit = if prepared.relevant {
                    let ranked = if field == "category"
                        && clause.operator == SearchOperator::Exact
                        && !text.eq_ignore_ascii_case(&clause.value)
                        && text
                            .get(..clause.value.len())
                            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&clause.value))
                        && text.as_bytes().get(clause.value.len()) == Some(&b'/')
                    {
                        Some((0, 0))
                    } else {
                        strength(&text, clause, &prepared.needle)
                    };
                    let Some((quality, coverage)) = ranked else {
                        continue;
                    };
                    Hit {
                        quality,
                        role: field_role(&field, value, record, schema),
                        coverage,
                    }
                } else {
                    let matches =
                        if field == "category" && clause.operator == SearchOperator::Exact {
                            text.eq_ignore_ascii_case(&clause.value)
                                || text.get(..clause.value.len()).is_some_and(|prefix| {
                                    prefix.eq_ignore_ascii_case(&clause.value)
                                }) && text.as_bytes().get(clause.value.len()) == Some(&b'/')
                        } else {
                            matches_value(&text, clause)
                        };
                    if !matches {
                        continue;
                    }
                    Hit::default()
                };
                any = true;
                if !matched_fields.iter().any(|key| key == &field) {
                    matched_fields.push(field.to_string());
                }
                if prepared.relevant {
                    best = best.max(hit);
                    let entry = fields.entry(field.into_owned()).or_default();
                    entry.best = entry.best.max(hit);
                    entry.clauses += 1;
                }
            }
            if !any {
                return None;
            }
            if prepared.relevant {
                score.qualities.push(best.quality);
                score.roles.push(best.role);
                score.coverage += best.coverage as u64;
            }
        }
        score.qualities.sort();
        score.roles.sort();
        score.concentration = fields
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "category" | "environment" | "dataset"))
            .map(|(_, field)| field.clauses)
            .max()
            .unwrap_or(0);
        if let Some(phrase) = &self.phrase {
            score.whole_phrase = candidates(phrase, record).iter().any(|(field, value)| {
                !matches!(field.as_ref(), "category" | "environment" | "dataset")
                    && value.text().eq_ignore_ascii_case(&phrase.value)
            });
        }
        matched_fields.sort_by(|a, b| {
            let key = |name: &String| {
                fields
                    .get(name)
                    .map(|field| {
                        (
                            field.best.quality,
                            field.clauses,
                            field.best.role,
                            field.best.coverage,
                        )
                    })
                    .unwrap_or_default()
            };
            key(b).cmp(&key(a))
        });
        Some(Evaluation {
            relevance: score,
            matched_fields,
        })
    }
}

#[derive(PartialEq, Eq)]
pub(super) struct RankKey {
    relevance: Relevance,
    expired: bool,
    updated: String,
    id: String,
}
impl Evaluation {
    pub fn rank(self, expired: bool, updated: String, id: String) -> RankKey {
        RankKey {
            relevance: self.relevance,
            expired,
            updated,
            id,
        }
    }
}
impl Ord for RankKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.relevance
            .cmp(&other.relevance)
            .then_with(|| other.expired.cmp(&self.expired))
            .then_with(|| self.updated.cmp(&other.updated))
            .then_with(|| other.id.cmp(&self.id))
    }
}
impl PartialOrd for RankKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
struct RankedRecord {
    key: RankKey,
    record: Value,
}
impl PartialEq for RankedRecord {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}
impl Eq for RankedRecord {}
impl Ord for RankedRecord {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key.cmp(&other.key)
    }
}
impl PartialOrd for RankedRecord {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

// The worst retained result is the heap root. Better rows replace it;
// discarded matches never need a response JSON object or secret metadata.
pub(super) struct TopResults {
    heap: BinaryHeap<Reverse<RankedRecord>>,
    capacity: usize,
    pub total: usize,
}
impl TopResults {
    pub fn new(offset: usize, limit: usize) -> Self {
        Self {
            heap: BinaryHeap::new(),
            capacity: offset.saturating_add(limit),
            total: 0,
        }
    }
    pub fn offer(&mut self, key: RankKey, record: impl FnOnce() -> Value) {
        self.total += 1;
        if self.capacity == 0 {
            return;
        }
        if self.heap.len() == self.capacity {
            if self.heap.peek().is_some_and(|worst| key <= worst.0.key) {
                return;
            }
            *self.heap.peek_mut().unwrap() = Reverse(RankedRecord {
                key,
                record: record(),
            });
        } else {
            self.heap.push(Reverse(RankedRecord {
                key,
                record: record(),
            }));
        }
    }
    pub fn finish(self, offset: usize) -> Vec<Value> {
        self.heap
            .into_sorted_vec()
            .into_iter()
            .skip(offset)
            .map(|Reverse(result)| result.record)
            .collect()
    }
}

#[cfg(test)]
mod benchmark;
#[cfg(test)]
mod reference;
#[cfg(test)]
mod reference_endpoint;

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn optimized(
        q: &str,
        records: &[Value],
        offset: usize,
        limit: usize,
    ) -> (usize, Vec<Value>) {
        let clauses = parse_search_clauses(q).unwrap();
        let plan = SearchPlan::new(&clauses);
        let schemas = schemas();
        let mut top = TopResults::new(offset, limit);
        for record in records {
            let view = RecordView {
                category: record["category"].as_str().unwrap_or_default(),
                environment: record["environment"].as_str(),
                environments: &[],
                dataset_id: record["dataset_id"].as_str().unwrap_or_default(),
                indexes: &record["indexes"],
                display: &record["display"],
                supplement: &record["supplement"],
            };
            let Some(mut evaluation) = plan.evaluate(&view, schemas.get(view.dataset_id)) else {
                continue;
            };
            let matched = std::mem::take(&mut evaluation.matched_fields);
            top.offer(
                evaluation.rank(
                    record["expired"].as_bool().unwrap_or(false),
                    record["updated"].as_str().unwrap_or_default().into(),
                    record["id"].as_str().unwrap_or_default().into(),
                ),
                || {
                    let mut record = record.clone();
                    record["matched_fields"] = json!(matched);
                    record
                },
            );
            assert!(top.heap.len() <= offset.saturating_add(limit));
        }
        let total = top.total;
        (total, top.finish(offset))
    }

    pub(super) fn original(
        q: &str,
        records: &[Value],
        offset: usize,
        limit: usize,
    ) -> (usize, Vec<Value>) {
        let clauses = parse_search_clauses(q).unwrap();
        let mut matched = records
            .iter()
            .filter_map(|record| {
                let (matches, fields) = combined_search(
                    &clauses,
                    record["category"].as_str().unwrap_or_default(),
                    record["environment"].as_str(),
                    record["dataset_id"].as_str().unwrap_or_default(),
                    &record["indexes"],
                    &record["display"],
                    &record["supplement"],
                );
                matches.then(|| {
                    let mut record = record.clone();
                    record["matched_fields"] = json!(fields);
                    record
                })
            })
            .collect::<Vec<_>>();
        reference::sort(&mut matched, &clauses, &schemas());
        (
            matched.len(),
            matched.into_iter().skip(offset).take(limit).collect(),
        )
    }

    pub(super) fn fixtures(count: usize) -> Vec<Value> {
        let values = [
            json!("a"),
            json!("a-1"),
            json!("a1"),
            json!("1a"),
            json!("prefix-a-1-suffix"),
            json!("alpha beta"),
            json!("alpha"),
            json!("beta"),
            json!("😀αβ tail"),
            json!("αβ"),
            json!("你好世界"),
            json!("你好"),
            json!(1),
            json!(0),
            json!(false),
            json!(null),
            json!(""),
            json!("   "),
            json!("AAA"),
            json!("é"),
            json!("É"),
            json!({"nested":"a1"}),
            json!([1, "a"]),
            json!("aaa"),
            json!("literal.*"),
            json!("cat-food"),
            json!("cat"),
        ];
        (0..count).map(|i| {
            let mut row = record(&format!("rec-{i:08}"), json!({"key":values[i % values.len()], "code":values[(i * 3 + 2) % values.len()]}),
                json!({"title":values[(i * 5 + 4) % values.len()], "a":values[(i * 7 + 6) % values.len()], "b":values[(i * 11 + 9) % values.len()],
                    "description":format!("virtual product a1 {i}, status enabled, region cn-east, integration reference 1016")}));
            row["category"] = json!(if i % 3 == 0 { "业务" } else { "业务/产品" });
            row["environment"] = if i % 5 == 0 { Value::Null } else { json!("prod") };
            row["expired"] = json!(i % 17 == 0);
            row["updated"] = json!(format!("2026-10-{:02} 00:00:00", i % 28 + 1));
            if i % 3 == 0 { row["supplement"] = json!({"indexes":{"code":values[(i + 1) % values.len()]},"display":{"a":values[(i + 4) % values.len()]}}); }
            row
        }).collect()
    }

    #[test]
    fn optimized_pages_match_frozen_full_sort_including_fields_and_highlights() {
        let rows = fixtures(257);
        for query in [
            "",
            "1",
            "a",
            "=1",
            "=业务",
            "alpha beta",
            "alpha beta alpha",
            "code:1",
            "code:=1",
            "code:^a",
            "code:$aa",
            "code:~[α-ω]+",
            "code:~^",
            "code:~a|1",
            "code:~a*",
            "é",
            "=é",
            "=É",
            "code:=é code:=É",
            "你好",
            "0",
            "false",
            "category:=业务",
            "category:=业务 env:=prod a",
            "supplement.code:a",
            "附表.indexes.code:=1",
            "supplement.display.a:a",
            "indexes.code:a",
            "display.CODE:a",
            "dataset:=ds a",
            "a a",
            "code:a code:a",
            "a:literal.*",
            "not-found",
        ] {
            for (offset, limit) in [
                (0, 1),
                (0, 30),
                (30, 30),
                (200, 100),
                (500, 30),
                (usize::MAX, 30),
            ] {
                let expected = original(query, &rows, offset, limit);
                let actual = optimized(query, &rows, offset, limit);
                assert_eq!(
                    actual, expected,
                    "query={query:?}, offset={offset}, limit={limit}"
                );
                let clauses = parse_search_clauses(query).unwrap();
                for (actual, expected) in actual.1.iter().zip(expected.1.iter()) {
                    assert_eq!(
                        match_highlights(&clauses, actual),
                        match_highlights(&clauses, expected)
                    );
                }
            }
        }
    }

    #[test]
    fn heap_capacity_is_bounded_and_late_better_matches_replace_the_worst() {
        let rows = (0..10_000)
            .map(|i| {
                record(
                    &format!("rec-{i:08}"),
                    json!({"key":if i < 9_970 { "partial-a" } else { "a" }}),
                    json!({}),
                )
            })
            .collect::<Vec<_>>();
        let expected = original("a", &rows, 0, 30);
        let actual = optimized("a", &rows, 0, 30);
        assert_eq!(actual, expected);
        assert_eq!(actual.0, 10_000);
        assert_eq!(actual.1[0]["id"], "rec-00009970");
    }

    fn record(id: &str, indexes: Value, display: Value) -> Value {
        json!({"id":id,"dataset_id":"ds","category":"业务/产品","environment":"prod",
            "indexes":indexes,"display":display,"supplement":null,"expired":false,"updated":"2026-01-01 00:00:00"})
    }

    pub(super) fn schemas() -> HashMap<String, DatasetSchema> {
        HashMap::from([(
            "ds".into(),
            (
                serde_json::from_value(json!([
                    {"source_key":"key","zone":"indexes"}, {"source_key":"title","zone":"display"},
                    {"source_key":"code","zone":"indexes"}, {"source_key":"a","zone":"display"},
                    {"source_key":"b","zone":"display"}
                ]))
                .unwrap(),
                vec!["key".into()],
                serde_json::from_value(json!({"identifier_fields":["title"]})).unwrap(),
            ),
        )])
    }

    fn ranked(q: &str, records: Vec<Value>) -> Vec<Value> {
        optimized(q, &records, 0, usize::MAX).1
    }

    fn ids(records: &[Value]) -> Vec<&str> {
        records
            .iter()
            .map(|record| record["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn whole_values_then_complete_segments_then_edges_then_substrings() {
        let result = ranked(
            "cat",
            vec![
                record("substring-key", json!({"key":"bobcatfish"}), json!({})),
                record("suffix", json!({}), json!({"a":"bobcat"})),
                record("prefix", json!({}), json!({"a":"catnap"})),
                record("segment", json!({}), json!({"a":"cat-food"})),
                record("whole-display", json!({}), json!({"a":"CAT"})),
            ],
        );
        assert_eq!(
            ids(&result),
            vec![
                "whole-display",
                "segment",
                "prefix",
                "suffix",
                "substring-key"
            ]
        );
    }

    #[test]
    fn equal_matches_use_dataset_key_identifier_indexes_display_supplement_then_metadata() {
        let mut supplement = record("supplement", json!({}), json!({}));
        supplement["supplement"] = json!({"indexes":{"a":"cat"},"display":{}});
        let mut metadata = record("metadata", json!({}), json!({}));
        metadata["category"] = json!("cat");
        let result = ranked(
            "cat",
            vec![
                metadata,
                supplement,
                record("display", json!({}), json!({"a":"cat"})),
                record("index", json!({"code":"cat"}), json!({})),
                record("identifier", json!({}), json!({"title":"cat"})),
                record("key", json!({"key":"cat"}), json!({})),
            ],
        );
        assert_eq!(
            ids(&result),
            vec![
                "key",
                "identifier",
                "index",
                "display",
                "supplement",
                "metadata"
            ]
        );
    }

    #[test]
    fn multi_term_queries_prefer_the_whole_phrase_then_all_terms_quality_and_concentration() {
        let result = ranked(
            "alpha beta",
            vec![
                record(
                    "concentrated",
                    json!({}),
                    json!({"a":"prefix alpha beta suffix"}),
                ),
                record(
                    "split",
                    json!({}),
                    json!({"a":"prefix alpha suffix", "b":"prefix beta suffix"}),
                ),
                record("one-weak", json!({"key":"alpha"}), json!({"b":"betamax"})),
                record("all-exact", json!({}), json!({"a":"alpha", "b":"beta"})),
                record("phrase", json!({}), json!({"a":"alpha beta"})),
                record("missing-term", json!({"key":"alpha"}), json!({})),
            ],
        );
        assert_eq!(
            ids(&result),
            vec!["phrase", "all-exact", "concentrated", "split", "one-weak"]
        );
        assert_eq!(
            ids(&ranked("alpha beta alpha", result.clone())),
            ids(&result)
        );
    }

    #[test]
    fn scope_filters_do_not_change_relevance_and_explicit_namespaces_are_respected() {
        let mut main = record("main", json!({"code":"cat"}), json!({}));
        main["category"] = json!("业务");
        main["supplement"] = json!({"indexes":{"code":"catnap"}});
        let mut extension = record("extension", json!({"code":"catnap"}), json!({}));
        extension["supplement"] = json!({"indexes":{"code":"cat"}});
        let rows = vec![main, extension];
        assert_eq!(
            ids(&ranked("code:cat", rows.clone())),
            vec!["main", "extension"]
        );
        assert_eq!(
            ids(&ranked("category:=业务 env:=prod code:cat", rows.clone())),
            vec!["main", "extension"]
        );
        assert_eq!(
            ids(&ranked("附表.indexes.code:cat", rows.clone())),
            vec!["extension", "main"]
        );
        assert_eq!(
            ids(&ranked("indexes.code:cat", rows)),
            vec!["main", "extension"]
        );
    }

    #[test]
    fn unicode_regex_numbers_booleans_and_overlapping_suffixes_have_correct_strength() {
        assert_eq!(
            ids(&ranked(
                "你好",
                vec![
                    record("partial", json!({"code":"你好世界"}), json!({})),
                    record("exact", json!({}), json!({"a":"你好"})),
                ]
            )),
            vec!["exact", "partial"]
        );
        assert_eq!(
            ids(&ranked(
                "code:~[α-ω]+",
                vec![
                    record("partial", json!({"code":"😀αβ tail"}), json!({})),
                    record("exact", json!({"code":"αβ"}), json!({})),
                ]
            )),
            vec!["exact", "partial"]
        );
        for (query, value) in [("0", json!(0)), ("false", json!(false))] {
            assert_eq!(
                ids(&ranked(
                    query,
                    vec![
                        record(
                            "partial",
                            json!({"key":format!("pre{query}post")}),
                            json!({})
                        ),
                        record("exact", json!({"code":value}), json!({})),
                    ]
                )),
                vec!["exact", "partial"]
            );
        }
        let clause = parse_search_clauses("code:$aa").unwrap();
        assert_eq!(match_strength("aaa", &clause[0]), (2, 6666));
        let clause = parse_search_clauses("code:~^").unwrap();
        assert_eq!(match_strength("anything", &clause[0]), (0, 0));
    }

    #[test]
    fn ties_are_stable_active_then_updated_then_id_and_do_not_count_repeated_hits() {
        let mut expired = record("expired", json!({}), json!({"a":"cat"}));
        expired["expired"] = json!(true);
        expired["updated"] = json!("2030-01-01 00:00:00");
        let mut older = record("older", json!({}), json!({"a":"cat"}));
        older["updated"] = json!("2025-01-01 00:00:00");
        let rows = vec![
            expired,
            older,
            record("b", json!({}), json!({"a":"cat"})),
            record("a", json!({}), json!({"a":"cat"})),
        ];
        for query in ["", "env:=prod", "cat"] {
            assert_eq!(
                ids(&ranked(query, rows.clone())),
                vec!["a", "b", "older", "expired"]
            );
        }
        let result = ranked(
            "cat",
            vec![
                record("repeated", json!({}), json!({"a":"cat cat cat"})),
                record("concise", json!({}), json!({"a":"one cat"})),
            ],
        );
        assert_eq!(ids(&result), vec!["concise", "repeated"]);
    }

    #[test]
    fn summary_fields_are_sorted_by_actual_match_quality_without_extra_fields() {
        let result = ranked(
            "cat",
            vec![record(
                "one",
                json!({"key":"catnap"}),
                json!({"a":"cat", "b":"not matched"}),
            )],
        );
        assert_eq!(result[0]["matched_fields"], json!(["a", "key"]));
        assert_eq!(
            match_highlights(&parse_search_clauses("cat").unwrap(), &result[0])["key"]["ranges"],
            json!([[0, 3]])
        );
    }
}
