use canopy_protocol::{CanopyError, Document, Value};

use crate::fields::{FieldAccess, can_access};
use crate::values::js_number;

/// The search stages, which MongoDB only accepts as the first stage of a pipeline.
pub const SEARCH_STAGES: [&str; 2] = ["$search", "$vectorSearch"];

const OPERATORS: [&str; 16] = [
    "autocomplete",
    "compound",
    "embeddedDocument",
    "equals",
    "exists",
    "geoShape",
    "geoWithin",
    "in",
    "moreLikeThis",
    "near",
    "phrase",
    "queryString",
    "range",
    "regex",
    "text",
    "wildcard",
];
const OPTIONS: [&str; 7] =
    ["index", "highlight", "scoreDetails", "sort", "concurrent", "searchAfter", "searchBefore"];
/// Operators whose text or source documents can name any indexed field.
const ANY_FIELD: [&str; 2] = ["queryString", "moreLikeThis"];
const COMPOUND_CLAUSES: [&str; 4] = ["must", "mustNot", "should", "filter"];
const VECTOR_KEYS: [&str; 7] = ["index", "path", "queryVector", "numCandidates", "limit", "exact", "filter"];
/// The operators `$vectorSearch.filter` supports.
const VECTOR_FILTER_OPERATORS: [&str; 10] =
    ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$not"];
const VECTOR_FILTER_LOGICAL: [&str; 3] = ["$and", "$or", "$nor"];
const MAX_CANDIDATES: f64 = 10_000.0;
const MAX_DIMENSIONS: usize = 8192;
const MAX_DEPTH: usize = 32;

fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}

/// What a search may look at for one caller.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchScope {
    /// The fields the caller may read.
    pub readable: FieldAccess,
    /// The most documents `$vectorSearch` may return.
    pub max_results: u64,
}

fn readable_path(scope: &SearchScope, path: Option<&Value>, place: &str) -> Result<(), CanopyError> {
    let path = match path {
        Some(Value::String(path)) if !path.is_empty() && !path.starts_with('$') => path,
        _ => return fail(format!("{place} needs field paths")),
    };
    if !can_access(&scope.readable, path) {
        return fail(format!("{place} cannot use the unreadable field {path}"));
    }
    Ok(())
}

fn every_field(scope: &SearchScope, what: &str) -> Result<(), CanopyError> {
    if scope.readable != FieldAccess::All {
        return fail(format!(
            "{what} can match any field, so it needs every field of the collection to be readable"
        ));
    }
    Ok(())
}

/// Checks a `path` of a search operator: a field, `{ value, multi }`, `{ value, undefined }` (in score
/// functions), `{ wildcard }` or a list of those.
fn paths(scope: &SearchScope, value: Option<&Value>, place: &str) -> Result<(), CanopyError> {
    match value {
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return fail(format!("{place} needs at least one path"));
            }
            for item in items {
                paths(scope, Some(item), place)?;
            }
            Ok(())
        }
        Some(Value::Document(path)) => {
            if path.contains_key("wildcard") {
                if path.len() != 1 || !matches!(path.get("wildcard"), Some(Value::String(_))) {
                    return fail(format!("{place} needs {{ wildcard: \"<pattern>\" }}"));
                }
                return every_field(scope, "A wildcard path");
            }
            for key in path.keys() {
                if key != "value" && key != "multi" && key != "undefined" {
                    return fail(format!("Unknown path field {key} in {place}"));
                }
            }
            readable_path(scope, path.get("value"), place)
        }
        other => readable_path(scope, other, place),
    }
}

/// Walks an operator body, checking every path it names and refusing operators that can see any field.
fn walk(scope: &SearchScope, value: &Value, place: &str, depth: usize) -> Result<(), CanopyError> {
    if depth > MAX_DEPTH {
        return fail("The search is nested too deeply");
    }
    match value {
        Value::Array(items) => {
            for item in items {
                walk(scope, item, place, depth + 1)?;
            }
            Ok(())
        }
        Value::Document(body) => {
            for (key, item) in body.iter() {
                if key == "path" || key == "defaultPath" {
                    paths(scope, Some(item), place)?;
                } else if ANY_FIELD.contains(&key) {
                    every_field(scope, key)?;
                } else if key == "operator" && matches!(item, Value::Document(_)) {
                    operator(scope, item, depth + 1)?;
                } else {
                    walk(scope, item, place, depth + 1)?;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Checks one operator document such as `{ text: { query, path } }`, recursing into compound clauses.
fn operator(scope: &SearchScope, value: &Value, depth: usize) -> Result<(), CanopyError> {
    let Value::Document(operator_document) = value else {
        return fail("A search operator must be a document");
    };
    let Some(name) = operator_document.first_key().filter(|_| operator_document.len() == 1) else {
        return fail("A search operator must have exactly one key");
    };
    if !OPERATORS.contains(&name) {
        return fail(format!("The search operator {name} is not allowed"));
    }
    let Some(Value::Document(body)) = operator_document.get(name) else {
        return fail(format!("The search operator {name} needs a document"));
    };
    if ANY_FIELD.contains(&name) {
        every_field(scope, name)?;
    }
    if name != "compound" {
        return walk(scope, &Value::Document(body.clone()), name, depth);
    }
    for (clause, item) in body.iter() {
        if COMPOUND_CLAUSES.contains(&clause) {
            match item {
                Value::Array(inner) => {
                    for inner in inner {
                        operator(scope, inner, depth + 1)?;
                    }
                }
                inner => operator(scope, inner, depth + 1)?,
            }
        } else if clause == "minimumShouldMatch" {
            if !js_number(item).is_some_and(|number| safe_integer(number) && number >= 0.0) {
                return fail("minimumShouldMatch needs a non negative integer");
            }
        } else if clause == "score" {
            walk(scope, item, "compound", depth + 1)?;
        } else {
            return fail(format!("Unknown compound field {clause}"));
        }
    }
    Ok(())
}

fn safe_integer(number: f64) -> bool {
    number.trunc() == number && number.abs() <= 9_007_199_254_740_991.0
}

fn single(name: &str, value: Value) -> Document {
    [(name.to_owned(), value)].into_iter().collect()
}

fn search(scope: &SearchScope, value: &Value) -> Result<Document, CanopyError> {
    let Value::Document(spec) = value else { return fail("$search needs a document") };
    let mut operators = 0;
    for (key, item) in spec.iter() {
        if OPERATORS.contains(&key) {
            operators += 1;
            operator(scope, &Value::Document(single(key, item.clone())), 1)?;
            continue;
        }
        if !OPTIONS.contains(&key) {
            return fail(format!("The $search option {key} is not allowed"));
        }
        match key {
            "index" | "searchAfter" | "searchBefore" => {
                if !matches!(item, Value::String(text) if !text.is_empty()) {
                    return fail(format!("$search {key} needs a string"));
                }
            }
            "scoreDetails" | "concurrent" => {
                if !matches!(item, Value::Bool(_)) {
                    return fail(format!("$search {key} needs true or false"));
                }
            }
            "highlight" => {
                let Value::Document(highlight) = item else {
                    return fail("$search highlight needs a document");
                };
                for field in highlight.keys() {
                    if field != "path" && field != "maxCharsToExamine" && field != "maxNumPassages" {
                        return fail(format!("Unknown highlight field {field}"));
                    }
                }
                paths(scope, highlight.get("path"), "highlight")?;
            }
            "sort" => {
                let Value::Document(sort) = item else {
                    return fail("$search sort needs a document of fields");
                };
                if sort.is_empty() {
                    return fail("$search sort needs a document of fields");
                }
                for (field, order) in sort.iter() {
                    if matches!(order, Value::Document(order) if order.contains_key("$meta")) {
                        continue;
                    }
                    readable_path(scope, Some(&Value::String(field.to_owned())), "$search sort")?;
                }
            }
            _ => {}
        }
    }
    if operators != 1 {
        return fail("$search needs exactly one operator");
    }
    Ok(single("$search", value.clone()))
}

/// Checks a `$vectorSearch.filter`: only the operators it supports, on readable fields.
fn vector_filter(scope: &SearchScope, value: &Value, depth: usize) -> Result<(), CanopyError> {
    if depth > MAX_DEPTH {
        return fail("The $vectorSearch filter is nested too deeply");
    }
    let Value::Document(filter) = value else { return fail("$vectorSearch filter needs a document") };
    for (key, item) in filter.iter() {
        if VECTOR_FILTER_LOGICAL.contains(&key) {
            let Value::Array(inner) = item else { return fail(format!("{key} needs a list of filters")) };
            if inner.is_empty() {
                return fail(format!("{key} needs a list of filters"));
            }
            for inner in inner {
                vector_filter(scope, inner, depth + 1)?;
            }
            continue;
        }
        if key.starts_with('$') {
            return fail(format!("The $vectorSearch filter operator {key} is not allowed"));
        }
        readable_path(scope, Some(&Value::String(key.to_owned())), "$vectorSearch filter")?;
        condition(item, depth + 1)?;
    }
    Ok(())
}

fn condition(value: &Value, depth: usize) -> Result<(), CanopyError> {
    if depth > MAX_DEPTH {
        return fail("The $vectorSearch filter is nested too deeply");
    }
    let Value::Document(operators) = value else { return Ok(()) };
    if operators.is_empty() || !operators.keys().all(|key| key.starts_with('$')) {
        return Ok(());
    }
    for (key, item) in operators.iter() {
        if !VECTOR_FILTER_OPERATORS.contains(&key) {
            return fail(format!("The $vectorSearch filter operator {key} is not allowed"));
        }
        if key == "$not" {
            condition(item, depth + 1)?;
        }
    }
    Ok(())
}

fn positive(value: Option<&Value>, what: &str, max: f64) -> Result<f64, CanopyError> {
    let Some(number) = value.and_then(js_number).filter(|number| safe_integer(*number) && *number >= 1.0)
    else {
        return fail(format!("{what} needs a positive integer"));
    };
    if number > max {
        return fail(format!("{what} may not be more than {max}"));
    }
    Ok(number)
}

fn vector_search(scope: &SearchScope, value: &Value) -> Result<Document, CanopyError> {
    let Value::Document(spec) = value else { return fail("$vectorSearch needs a document") };
    for key in spec.keys() {
        if !VECTOR_KEYS.contains(&key) {
            return fail(format!("The $vectorSearch option {key} is not allowed"));
        }
    }
    if !matches!(spec.get("index"), Some(Value::String(index)) if !index.is_empty()) {
        return fail("$vectorSearch needs an index");
    }
    readable_path(scope, spec.get("path"), "$vectorSearch")?;
    let finite = |item: &Value| js_number(item).is_some_and(f64::is_finite);
    match spec.get("queryVector") {
        Some(Value::Array(vector))
            if !vector.is_empty() && vector.len() <= MAX_DIMENSIONS && vector.iter().all(finite) => {}
        _ => return fail(format!("$vectorSearch queryVector needs 1 to {MAX_DIMENSIONS} numbers")),
    }
    #[allow(clippy::cast_precision_loss)]
    let limit = positive(spec.get("limit"), "$vectorSearch limit", scope.max_results as f64)?;
    let exact = spec.get("exact");
    if exact.is_some_and(|exact| !matches!(exact, Value::Bool(_))) {
        return fail("$vectorSearch exact needs true or false");
    }
    if !matches!(exact, Some(Value::Bool(true))) {
        let candidates = positive(spec.get("numCandidates"), "$vectorSearch numCandidates", MAX_CANDIDATES)?;
        if candidates < limit {
            return fail("$vectorSearch numCandidates may not be less than limit");
        }
    } else if spec.contains_key("numCandidates") {
        return fail("$vectorSearch numCandidates does not apply to an exact search");
    }
    if let Some(filter) = spec.get("filter") {
        vector_filter(scope, filter, 1)?;
    }
    Ok(single("$vectorSearch", value.clone()))
}

/// Checks a `$search` or `$vectorSearch` stage of a caller who is not `service`: only documented operators and
/// options, and every field it searches, sorts, highlights or filters on readable for the caller. Fails with an
/// invalid query error.
pub fn secure_search_stage(scope: &SearchScope, name: &str, value: &Value) -> Result<Document, CanopyError> {
    if name == "$search" { search(scope, value) } else { vector_search(scope, value) }
}
