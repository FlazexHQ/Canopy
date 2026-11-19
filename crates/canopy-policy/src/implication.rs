//! Equality fields of filter templates, and whether an update's `check` is implied by its target.

use std::collections::HashSet;

use canopy_protocol::ejson::canonical_string;
use canopy_protocol::{CanopyError, Document, Value};

use crate::engine::Compiled;
use crate::values::{js_fields, js_ordered};

const LOGICAL: [&str; 3] = ["$and", "$or", "$nor"];

/// The fields a filter template compares by equality on every query: plain values, policy variables and
/// `$eq`/`$in`, at the top level and inside `$and`. Branches of `$or` and `$nor` are left out, since no single
/// index serves them. `_id` is always indexed and is skipped.
pub fn equality_fields(filter: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    collect_equality(filter, &mut out);
    let mut unique: Vec<String> = Vec::new();
    for field in out {
        if !unique.contains(&field) {
            unique.push(field);
        }
    }
    unique
}

fn collect_equality(filter: &Value, out: &mut Vec<String>) {
    let Value::Document(filter) = filter else { return };
    for (key, value) in js_fields(filter) {
        if key == "$and"
            && let Value::Array(parts) = value
        {
            for part in parts {
                out.extend(equality_fields(part));
            }
            continue;
        }
        if key.starts_with('$') || key == "_id" {
            continue;
        }
        match value {
            Value::Document(inner) => {
                if inner.contains_key("$auth")
                    || inner.contains_key("$ctx")
                    || inner.contains_key("$eq")
                    || inner.contains_key("$in")
                    || inner.keys().all(|name| !name.starts_with('$'))
                {
                    out.push(key.to_owned());
                }
            }
            _ => out.push(key.to_owned()),
        }
    }
}

fn single(key: &str, value: &Value) -> Document {
    [(key.to_owned(), value.clone())].into_iter().collect()
}

/// Splits a filter into the conditions that must all hold: `$and` elements and one entry per field.
fn conjuncts(filter: &Document) -> Vec<Document> {
    let mut out = Vec::new();
    for (key, value) in js_fields(filter) {
        match value {
            Value::Array(parts) if key == "$and" => {
                for part in parts {
                    let Value::Document(part) = part else { return vec![filter.clone()] };
                    out.extend(conjuncts(part));
                }
            }
            _ => out.push(single(key, value)),
        }
    }
    out
}

/// Adds the top level fields a filter reads to `fields`. Returns false when the filter has an operator whose
/// field references cannot be read from its keys, such as `$expr` or `$where`.
fn collect_fields(filter: &Document, fields: &mut HashSet<String>) -> bool {
    for (key, value) in js_fields(filter) {
        if key == "$comment" {
            continue;
        }
        if LOGICAL.contains(&key) {
            let Value::Array(parts) = value else { return false };
            for part in parts {
                let Value::Document(part) = part else { return false };
                if !collect_fields(part, fields) {
                    return false;
                }
            }
            continue;
        }
        if key.starts_with('$') {
            return false;
        }
        fields.insert(key.split('.').next().unwrap_or(key).to_owned());
    }
    true
}

/// Whether an update can skip evaluating `check` because every document it can produce already satisfies it.
/// That holds when each condition of `check` is also a condition of `target`, so the matched document
/// satisfied the check before the write, and the update writes no top level field the check reads, so the
/// written document still does. `written` are the paths the update writes. Anything this cannot decide
/// counts as not implied, so the check is then evaluated as usual.
pub fn check_implied(check: &Compiled, target: &Compiled, written: &[String]) -> Result<bool, CanopyError> {
    let check = match check {
        Compiled::All => return Ok(true),
        Compiled::Deny => return Ok(false),
        Compiled::Filter(filter) => js_ordered(filter),
    };
    let Compiled::Filter(target) = target else { return Ok(false) };
    let required = conjuncts(&js_ordered(target))
        .iter()
        .map(|part| canonical_string(&Value::Document(part.clone())))
        .collect::<Result<HashSet<String>, CanopyError>>()?;
    let mut fields = HashSet::new();
    for part in conjuncts(&check) {
        if !required.contains(&canonical_string(&Value::Document(part.clone()))?) {
            return Ok(false);
        }
        if !collect_fields(&part, &mut fields) {
            return Ok(false);
        }
    }
    Ok(written.iter().all(|path| !fields.contains(path.split('.').next().unwrap_or(path))))
}
