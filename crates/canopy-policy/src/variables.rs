//! Policy variables (`$auth`, `$ctx`, `$now`) and their substitution for one request. Every variable that
//! cannot be resolved makes its policy non matching: there are no defaults.

use std::fmt;

use canopy_protocol::json::js_number_string;
use canopy_protocol::{Binary, CanopyError, Document, ErrorCode, Value, parse_object_id};
use canopy_query::is_variable;

use crate::dates::{self, iso_date_ms, parse_duration, time_clip};
use crate::model::RequestContext;
use crate::values::{js_fields, js_number, js_string};

/// The largest array a variable may resolve to under `$in`, `$nin` or `$all`.
pub const MAX_VARIABLE_LIST: usize = 1000;

const LIST_OPERATORS: [&str; 3] = ["$in", "$nin", "$all"];

/// Why a variable made its policy non matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VariableIssueKind {
    /// The value is missing or `null`.
    Missing,
    /// A list where a single value belongs, a single value where a list belongs, or a list that is too long.
    Shape,
    /// The value cannot be converted to the requested type, or a shifted time leaves the range of dates.
    Coercion,
}

impl VariableIssueKind {
    /// The name the TypeScript package reports: `missing`, `shape` or `coercion`.
    pub const fn as_str(self) -> &'static str {
        match self {
            VariableIssueKind::Missing => "missing",
            VariableIssueKind::Shape => "shape",
            VariableIssueKind::Coercion => "coercion",
        }
    }
}

impl fmt::Display for VariableIssueKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Reported for every variable that fails to resolve (feeds `canopy_policy_variable_errors_total`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VariableIssue {
    /// What went wrong.
    pub kind: VariableIssueKind,
    /// The variable: `$auth:<path>`, `$ctx:<name>` or `$now`.
    pub variable: String,
}

/// The outcome of resolving one clause.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    /// Every variable resolved; the filter holds their values.
    Resolved(Document),
    /// A variable could not be resolved, so the policy does not match.
    Unresolvable(VariableIssue),
}

enum Stop {
    Issue(VariableIssue),
    Error(CanopyError),
}

impl From<CanopyError> for Stop {
    fn from(error: CanopyError) -> Stop {
        Stop::Error(error)
    }
}

fn issue(kind: VariableIssueKind, variable: &str) -> Stop {
    Stop::Issue(VariableIssue { kind, variable: variable.to_owned() })
}

/// Reads a dotted path from the claims, following only fields of documents.
pub fn read_claim<'a>(claims: Option<&'a Document>, path: &str) -> Option<&'a Value> {
    let mut document = claims?;
    let mut segments = path.split('.').peekable();
    while let Some(segment) = segments.next() {
        let value = document.get(segment)?;
        if segments.peek().is_none() {
            return Some(value);
        }
        document = value.as_document()?;
    }
    None
}

/// Shifts a time in milliseconds since the epoch by an ISO 8601 duration such as `-P7D` or `PT24H`, using UTC
/// calendar arithmetic exactly as JavaScript dates do. `Ok(None)` when the result leaves the range of dates;
/// an error named `TypeError` when the duration is not valid.
pub fn shift_date(ms: i64, duration: &str) -> Result<Option<i64>, CanopyError> {
    let parsed = parse_duration(duration).ok_or_else(|| {
        CanopyError::named(ErrorCode::Internal, "TypeError", format!("Invalid ISO 8601 duration: {duration}"))
    })?;
    Ok(dates::shift(ms, &parsed))
}

fn is_scalar(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Undefined | Value::Array(_) | Value::Document(_))
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn is_decimal_text(text: &str) -> bool {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match unsigned.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (unsigned, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

fn coerce(value: &Value, coercion: Option<&str>, variable: &str) -> Result<Value, Stop> {
    let Some(coercion) = coercion else { return Ok(value.clone()) };
    let fail = || issue(VariableIssueKind::Coercion, variable);
    let number = js_number(value).filter(|number| number.is_finite());
    match coercion {
        "objectId" => match value {
            Value::String(text) => parse_object_id(text).map(Value::ObjectId).ok_or_else(fail),
            _ => Err(fail()),
        },
        "string" => match (value, number) {
            (Value::String(_), _) => Ok(value.clone()),
            (_, Some(number)) => Ok(Value::String(js_number_string(number))),
            _ => Err(fail()),
        },
        "number" => match (value, number) {
            (_, Some(_)) => Ok(value.clone()),
            (Value::String(text), _) if is_decimal_text(text) => {
                Ok(Value::from_js_number(text.parse::<f64>().map_err(|_| fail())?))
            }
            _ => Err(fail()),
        },
        "bool" => match value {
            Value::Bool(_) => Ok(value.clone()),
            Value::String(text) if text == "true" || text == "false" => Ok(Value::Bool(text == "true")),
            _ => Err(fail()),
        },
        "date" => {
            let ms = match value {
                Value::String(text) => iso_date_ms(text),
                _ => js_number(value).and_then(|seconds| time_clip(seconds * 1000.0)),
            };
            ms.map(Value::DateTime).ok_or_else(fail)
        }
        "uuid" => match value {
            Value::String(text) if is_uuid(text) => {
                let hex: Vec<u8> = text.bytes().filter(|byte| *byte != b'-').collect();
                let bytes = hex
                    .chunks(2)
                    .map(|pair| {
                        std::str::from_utf8(pair).ok().and_then(|pair| u8::from_str_radix(pair, 16).ok())
                    })
                    .collect::<Option<Vec<u8>>>()
                    .ok_or_else(fail)?;
                Ok(Value::Binary(Box::new(Binary { subtype: 4, bytes })))
            }
            _ => Err(fail()),
        },
        _ => Err(fail()),
    }
}

fn resolve_variable(variable: &Document, list: bool, ctx: &RequestContext) -> Result<Value, Stop> {
    let (name, raw, coercion) = if let Some(path) = variable.get("$auth") {
        let path = js_string(path);
        let coercion = variable.get("as").and_then(Value::as_str);
        (format!("$auth:{path}"), read_claim(ctx.claims.as_ref(), &path), coercion)
    } else if let Some(key) = variable.get("$ctx") {
        let key = js_string(key);
        let raw = ctx.ctx.as_ref().and_then(|values| values.get(&key));
        (format!("$ctx:{key}"), raw, None)
    } else {
        let name = "$now";
        let offset = match variable.get("$now") {
            Some(Value::Document(spec)) => spec.get("offset").and_then(Value::as_str),
            _ => None,
        };
        let value = match offset {
            None => Some(ctx.now),
            Some(offset) => shift_date(ctx.now, offset)?,
        };
        if list {
            return Err(issue(VariableIssueKind::Shape, name));
        }
        return value.map(Value::DateTime).ok_or_else(|| issue(VariableIssueKind::Coercion, name));
    };
    let raw = match raw {
        None | Some(Value::Null | Value::Undefined) => return Err(issue(VariableIssueKind::Missing, &name)),
        Some(raw) => raw,
    };
    if list {
        let Value::Array(items) = raw else { return Err(issue(VariableIssueKind::Shape, &name)) };
        if items.len() > MAX_VARIABLE_LIST {
            return Err(issue(VariableIssueKind::Shape, &name));
        }
        return items
            .iter()
            .map(|item| {
                if !is_scalar(item) {
                    return Err(issue(VariableIssueKind::Shape, &name));
                }
                coerce(item, coercion, &name)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array);
    }
    if !is_scalar(raw) {
        return Err(issue(VariableIssueKind::Shape, &name));
    }
    coerce(raw, coercion, &name)
}

fn substitute(value: &Value, list: bool, ctx: &RequestContext) -> Result<Value, Stop> {
    match value {
        Value::Document(document) if is_variable(value) => resolve_variable(document, list, ctx),
        Value::Array(items) => {
            items.iter().map(|item| substitute(item, false, ctx)).collect::<Result<_, _>>().map(Value::Array)
        }
        Value::Document(document) => Ok(Value::Document(substitute_document(document, ctx)?)),
        other => Ok(other.clone()),
    }
}

fn substitute_document(document: &Document, ctx: &RequestContext) -> Result<Document, Stop> {
    let mut out = Document::with_capacity(document.len());
    for (key, item) in js_fields(document) {
        out.insert(key, substitute(item, LIST_OPERATORS.contains(&key), ctx)?);
    }
    Ok(out)
}

/// Substitutes the variables of a clause for one request context. A variable that is missing, `null`, of the
/// wrong shape or fails its coercion makes the whole clause unresolvable, so its policy does not match.
/// There are no defaults. The resolved filter has its keys in JavaScript property order. A clause that is itself
/// a variable, such as `{ $auth: "sub" }`, is not a filter and fails with an `InvalidQueryError`.
pub fn resolve_clause(clause: &Document, ctx: &RequestContext) -> Result<Resolution, CanopyError> {
    if is_variable(&Value::Document(clause.clone())) {
        return Err(CanopyError::invalid_query("A policy clause must be a filter document, not a variable"));
    }
    match substitute_document(clause, ctx) {
        Ok(filter) => Ok(Resolution::Resolved(filter)),
        Err(Stop::Issue(issue)) => Ok(Resolution::Unresolvable(issue)),
        Err(Stop::Error(error)) => Err(error),
    }
}

/// Returns true when the clause depends on the request time, so realtime must re-snapshot it periodically.
pub fn uses_now(clause: &Value) -> bool {
    match clause {
        Value::Array(items) => items.iter().any(uses_now),
        Value::Document(document) => {
            document.contains_key("$now") || document.iter().any(|(_, item)| uses_now(item))
        }
        _ => false,
    }
}

/// Lists the claim paths a clause reads, for claim change detection.
pub fn claim_paths(clause: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_claim_paths(clause, &mut out);
    out
}

fn collect_claim_paths(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| collect_claim_paths(item, out)),
        Value::Document(document) => {
            if let Some(Value::String(path)) = document.get("$auth") {
                out.push(path.clone());
                return;
            }
            for (_, item) in js_fields(document) {
                collect_claim_paths(item, out);
            }
        }
        _ => {}
    }
}
