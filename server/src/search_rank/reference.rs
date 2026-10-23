// Pre-optimization full-sort oracle and benchmark baseline. Scalar scoring is frozen;
// array elements follow the current membership semantics so paging remains comparable.
use super::*;
use std::collections::HashMap;

type DatasetSchema = (Vec<FieldDefinition>, Vec<String>, DisplayConfig);

// Lexicographic rules avoid a large number of weak matches outweighing an
// exact match. Each clause contributes only its best hit; field length or
// repeated occurrences cannot inflate the score.
#[derive(Default, PartialEq, Eq, PartialOrd, Ord)]
struct Relevance {
    whole_phrase: bool,
    qualities: Vec<u8>, // weakest clause first, so every term matters
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
    matches!(clause.field.as_deref(), Some("category" | "env" | "environment" | "dataset" | "dataset_id"))
}

fn unique_clauses(clauses: &[SearchClause]) -> Vec<&SearchClause> {
    let mut result: Vec<&SearchClause> = Vec::new();
    for clause in clauses.iter().filter(|clause| !is_scope_clause(clause)) {
        if !result.iter().any(|previous| previous.field == clause.field
            && previous.operator == clause.operator
            && if clause.operator == SearchOperator::Regex { previous.value == clause.value }
               else { previous.value.to_lowercase() == clause.value.to_lowercase() }) {
            result.push(clause);
        }
    }
    result
}

fn word_char(char: char) -> bool { char.is_alphanumeric() || char == '_' }

fn range_quality(text: &str, start: usize, end: usize) -> u8 {
    if start == end { return 0; } // Zero-width regex matches aren't exact values.
    if start == 0 && end == text.len() { return 4; }
    let left = text[..start].chars().next_back().is_none_or(|char| !word_char(char));
    let right = text[end..].chars().next().is_none_or(|char| !word_char(char));
    if left && right { 3 } else if start == 0 || end == text.len() { 2 } else { 1 }
}

fn match_strength(text: &str, clause: &SearchClause) -> (u8, u32) {
    let normalized;
    let text = if clause.operator == SearchOperator::Regex { text } else {
        normalized = text.to_lowercase(); &normalized
    };
    let ranges = if let Some(regex) = clause.regex.as_ref() {
        regex.find_iter(text).map(|hit| (hit.start(), hit.end())).collect::<Vec<_>>()
    } else {
        let needle = clause.value.to_lowercase();
        let starts = match clause.operator {
            SearchOperator::Exact | SearchOperator::Prefix => if text.starts_with(&needle) { vec![0] } else { vec![] },
            SearchOperator::Suffix => if text.ends_with(&needle) { vec![text.len() - needle.len()] } else { vec![] },
            _ => text.match_indices(&needle).map(|(start, _)| start).collect(),
        };
        starts.into_iter().filter_map(|start| {
            let end = start + needle.len();
            let accepted = match clause.operator {
                SearchOperator::Exact => start == 0 && end == text.len(),
                SearchOperator::Prefix => start == 0,
                SearchOperator::Suffix => end == text.len(),
                _ => true,
            };
            accepted.then_some((start, end))
        }).collect()
    };
    let length = text.chars().count().max(1) as u64;
    ranges.into_iter().map(|(start, end)| (
        range_quality(text, start, end),
        (text[start..end].chars().count() as u64 * 10_000 / length) as u32,
    )).max().unwrap_or_default()
}

fn value_strength(value: &Value, clause: &SearchClause) -> (u8, u32) {
    if let Value::Array(items) = value {
        return items.iter().filter(|item| clause_matches("", item, clause)).map(|item| value_strength(item, clause)).max().unwrap_or_default();
    }
    match_strength(&value_text(value), clause)
}

fn field_role(field: &str, value: &Value, record: &Value, schema: Option<&DatasetSchema>) -> u8 {
    if field.starts_with("supplement.") { return 1; }
    if matches!(field, "category" | "environment" | "dataset") { return 0; }
    if let Some((fields, identity, display)) = schema {
        let meaningful = !value.is_null() && value.as_str().is_none_or(|text| !text.trim().is_empty());
        let public = fields.iter().any(|definition| definition.source_key == field && matches!(definition.zone.as_str(), "indexes" | "display"));
        if meaningful && public && identity.iter().any(|key| key == field) { return 5; }
        if meaningful && public && display.identifier_fields.iter().any(|key| key == field) { return 4; }
    }
    if record["indexes"].get(field).is_some() { 3 } else { 2 }
}

fn candidates(clause: &SearchClause, record: &Value) -> Vec<(String, Value)> {
    let mut fields=combined_clause_fields(clause, record["category"].as_str().unwrap_or_default(),
        record["environment"].as_str(), record["dataset_id"].as_str().unwrap_or_default(),
        &record["indexes"], &record["display"], &record["supplement"]);
    if clause.field.is_none() || matches!(clause.field.as_deref(),Some("env"|"environment")) {
        fields.extend(record["environments"].as_array().into_iter().flatten().map(|v|("environment".to_owned(),v.clone())));
    }
    fields
}

fn relevance(record: &mut Value, clauses: &[&SearchClause], schema: Option<&DatasetSchema>) -> Relevance {
    let mut score = Relevance::default();
    let mut fields = HashMap::<String, FieldHits>::new();
    for clause in clauses {
        let mut best = Hit::default();
        for (field, value) in candidates(clause, record) {
            if !clause_matches(&field, &value, clause) { continue; }
            let (quality, coverage) = value_strength(&value, clause);
            let hit = Hit { quality, role: field_role(&field, &value, record, schema), coverage };
            best = best.max(hit);
            let entry = fields.entry(field).or_default();
            entry.best = entry.best.max(hit);
            entry.clauses += 1;
        }
        score.qualities.push(best.quality);
        score.roles.push(best.role);
        score.coverage += best.coverage as u64;
    }
    score.qualities.sort();
    score.roles.sort();
    score.concentration = fields.iter().filter(|(key, _)| !matches!(key.as_str(), "category" | "environment" | "dataset"))
        .map(|(_, field)| field.clauses).max().unwrap_or(0);
    // Only a plain multi-keyword query has a whole-query phrase. Structured
    // AND conditions and regexes must not be interpreted as literal phrases.
    if clauses.len() > 1 && clauses.iter().all(|clause| clause.field.is_none() && clause.operator == SearchOperator::Contains) {
        let phrase = SearchClause { field: None, operator: SearchOperator::Exact,
            value: clauses.iter().map(|clause| clause.value.as_str()).collect::<Vec<_>>().join(" "), regex: None };
        score.whole_phrase = candidates(&phrase, record).iter().any(|(field, value)| {
            !matches!(field.as_str(), "category" | "environment" | "dataset")
                && clause_matches(field, value, &phrase)
        });
    }
    // Stronger matched fields also lead the summary, while equal hits retain
    // the existing order. Only actual search matches are ever included.
    if let Some(matched) = record["matched_fields"].as_array_mut() {
        matched.sort_by(|a, b| {
            let key = |value: &Value| fields.get(value.as_str().unwrap_or_default())
                .map(|field| (field.best.quality, field.clauses, field.best.role, field.best.coverage)).unwrap_or_default();
            key(b).cmp(&key(a))
        });
    }
    score
}

pub(super) fn sort(records: &mut [Value], clauses: &[SearchClause], schemas: &HashMap<String, DatasetSchema>) {
    let clauses = unique_clauses(clauses);
    // Compute once before sorting the entire authorized result set, then page.
    let scores: HashMap<String, Relevance> = records.iter_mut().map(|record| {
        let schema = record["dataset_id"].as_str().and_then(|id| schemas.get(id));
        let score = relevance(record, &clauses, schema);
        (record["id"].as_str().unwrap_or_default().to_owned(), score)
    }).collect();
    records.sort_by(|a, b| {
        let a_id = a["id"].as_str().unwrap_or_default();
        let b_id = b["id"].as_str().unwrap_or_default();
        scores.get(b_id).cmp(&scores.get(a_id))
            .then_with(|| a["expired"].as_bool().unwrap_or(false).cmp(&b["expired"].as_bool().unwrap_or(false)))
            .then_with(|| b["updated"].as_str().cmp(&a["updated"].as_str()))
            .then_with(|| a_id.cmp(b_id))
    });
}
