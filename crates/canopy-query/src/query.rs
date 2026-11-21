//! Validation of sorts, projections, limits, live queries and updates from untrusted callers.

use canopy_matcher::UPDATE_OPERATORS;
use canopy_protocol::ejson::is_forbidden_key;
use canopy_protocol::{CanopyError, Document, Value};

use crate::filter::{ParseFilterOptions, ParsedFilter, parse_filter};
use crate::limits::{DEFAULT_LIMITS, QueryLimits};
use crate::paths::{PathOptions, normalize_positional, validate_path};
use crate::values::{js_fields, js_first_key, js_number};

fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}

fn plain_path(limits: &QueryLimits) -> PathOptions {
    PathOptions { positional: false, max_length: limits.max_path_length }
}

/// A validated sort specification.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSort {
    /// The sort, with each direction as the int32 `1` or `-1`.
    pub sort: Document,
    /// The sorted paths in order.
    pub paths: Vec<String>,
}

/// Validates a sort such as `{ createdAt: -1 }`. Only `1` and `-1` are accepted.
pub fn parse_sort(input: &Value, limits: &QueryLimits) -> Result<ParsedSort, CanopyError> {
    let Value::Document(input) = input else { return fail("A sort must be a document") };
    let fields = js_fields(input);
    if fields.len() > limits.max_sort_keys {
        return fail(format!("A sort may not have more than {} keys", limits.max_sort_keys));
    }
    let mut sort = Document::with_capacity(fields.len());
    let mut paths = Vec::with_capacity(fields.len());
    for (path, direction) in fields {
        validate_path(path, plain_path(limits))?;
        let direction = match js_number(direction) {
            Some(1.0) => 1,
            Some(-1.0) => -1,
            _ => return fail(format!("The sort direction for {path} must be 1 or -1")),
        };
        sort.insert(path, Value::Int32(direction));
        paths.push(path.to_owned());
    }
    Ok(ParsedSort { sort, paths })
}

/// Whether a projection keeps or removes its paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionMode {
    /// Keeps only the listed paths.
    Include,
    /// Removes the listed paths.
    Exclude,
}

/// A validated projection.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedProjection {
    /// The projection, with each flag as the int32 `0` or `1`.
    pub projection: Document,
    /// Whether the projection keeps or removes its paths. A projection of `_id` alone excludes.
    pub mode: ProjectionMode,
    /// The projected paths, without `_id`.
    pub paths: Vec<String>,
    /// Whether `_id` is part of the result.
    pub include_id: bool,
}

/// Validates an inclusion or exclusion projection. Projection operators are not accepted.
pub fn parse_projection(input: &Value, limits: &QueryLimits) -> Result<ParsedProjection, CanopyError> {
    let Value::Document(input) = input else { return fail("A projection must be a document") };
    let fields = js_fields(input);
    if fields.len() > limits.max_projection_paths {
        return fail(format!("A projection may not have more than {} paths", limits.max_projection_paths));
    }
    let mut projection = Document::with_capacity(fields.len());
    let mut mode: Option<ProjectionMode> = None;
    let mut include_id = true;
    let mut paths: Vec<String> = Vec::new();
    for (path, raw) in fields {
        validate_path(path, plain_path(limits))?;
        let on = match raw {
            Value::Bool(flag) => *flag,
            other => match js_number(other) {
                Some(1.0) => true,
                Some(0.0) => false,
                _ => return fail(format!("The projection of {path} must be 0 or 1")),
            },
        };
        projection.insert(path, Value::Int32(i32::from(on)));
        if path == "_id" {
            include_id = on;
            continue;
        }
        let path_mode = if on { ProjectionMode::Include } else { ProjectionMode::Exclude };
        if mode.is_some_and(|mode| mode != path_mode) {
            return fail("A projection cannot mix inclusion and exclusion");
        }
        mode = Some(path_mode);
        paths.push(path.to_owned());
    }
    for a in &paths {
        for b in &paths {
            if a != b && b.len() > a.len() && b.starts_with(a.as_str()) && b.as_bytes()[a.len()] == b'.' {
                return fail(format!("Path collision between {a} and {b}"));
            }
        }
    }
    Ok(ParsedProjection { projection, mode: mode.unwrap_or(ProjectionMode::Exclude), paths, include_id })
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Validates a `limit`: a non negative integer no larger than the limits allow.
pub fn parse_limit(input: &Value, limits: &QueryLimits) -> Result<u32, CanopyError> {
    let n = match js_number(input) {
        Some(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER && n >= 0.0 => n,
        _ => return fail("limit must be a non negative integer"),
    };
    if n > f64::from(limits.max_limit) {
        return fail(format!("limit may not exceed {}", limits.max_limit));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(n as u32)
}

/// The parts of a live query (the `q` of a `sub` message) as a caller sent them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueryInput {
    /// The filter; an absent filter matches every document.
    pub filter: Option<Value>,
    /// The sort.
    pub sort: Option<Value>,
    /// The limit.
    pub limit: Option<Value>,
    /// The projection.
    pub fields: Option<Value>,
}

/// A validated live query.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedQuery {
    /// The filter.
    pub filter: ParsedFilter,
    /// The sort.
    pub sort: Option<ParsedSort>,
    /// The limit.
    pub limit: Option<u32>,
    /// The projection.
    pub fields: Option<ParsedProjection>,
    /// Every path the query reads, for the unreadable path check.
    pub paths: Vec<String>,
}

/// Validates the parts of a live query from an untrusted caller.
pub fn parse_query(input: &QueryInput, limits: &QueryLimits) -> Result<ParsedQuery, CanopyError> {
    let empty = Value::Document(Document::new());
    let options = ParseFilterOptions { limits: *limits, ..ParseFilterOptions::default() };
    let filter = parse_filter(input.filter.as_ref().unwrap_or(&empty), &options)?;
    let sort = input.sort.as_ref().map(|sort| parse_sort(sort, limits)).transpose()?;
    let limit = input.limit.as_ref().map(|limit| parse_limit(limit, limits)).transpose()?;
    let fields = input.fields.as_ref().map(|fields| parse_projection(fields, limits)).transpose()?;
    let mut paths: Vec<String> = Vec::new();
    for path in filter.paths.iter().chain(sort.iter().flat_map(|sort| sort.paths.iter())) {
        if !paths.contains(path) {
            paths.push(path.clone());
        }
    }
    Ok(ParsedQuery { filter, sort, limit, fields, paths })
}

/// Whether an update replaces the document or applies operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateKind {
    /// An operator update.
    Operators,
    /// A whole replacement document.
    Replacement,
}

/// A validated update.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedUpdate {
    /// The update, unchanged.
    pub update: Document,
    /// Whether the update replaces the document or applies operators.
    pub kind: UpdateKind,
    /// Every path the update writes, with positional segments removed. `$rename` contributes both sides.
    pub written_paths: Vec<String>,
}

/// Options for [`parse_update`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseUpdateOptions {
    /// The limits to apply.
    pub limits: QueryLimits,
    /// Accept pipeline style updates. Only the `service` role may use them.
    pub allow_pipeline: bool,
}

impl Default for ParseUpdateOptions {
    fn default() -> ParseUpdateOptions {
        ParseUpdateOptions { limits: DEFAULT_LIMITS, allow_pipeline: false }
    }
}

/// Validates an update document from an untrusted caller and lists the paths it writes.
pub fn parse_update(input: &Value, options: &ParseUpdateOptions) -> Result<ParsedUpdate, CanopyError> {
    let limits = &options.limits;
    let update = match input {
        Value::Array(_) if !options.allow_pipeline => {
            return fail("Pipeline updates are only accepted from the service role");
        }
        Value::Array(_) => return fail("Pipeline updates are not supported yet"),
        Value::Document(update) => update,
        _ => return fail("An update must be a document"),
    };
    let fields = js_fields(update);
    if fields.is_empty() || !fields.iter().any(|(key, _)| key.starts_with('$')) {
        validate_stored_document(input, limits)?;
        let written_paths = fields.iter().map(|(key, _)| (*key).to_owned()).collect();
        return Ok(ParsedUpdate { update: update.clone(), kind: UpdateKind::Replacement, written_paths });
    }
    if !fields.iter().all(|(key, _)| key.starts_with('$')) {
        return fail("An update cannot mix operators and fields");
    }
    let mut written = Vec::new();
    for (op, operand) in fields {
        if !UPDATE_OPERATORS.contains(&op) {
            return fail(format!("The update operator {op} is not allowed"));
        }
        let Value::Document(operand) = operand else { return fail(format!("{op} needs a document")) };
        for (path, value) in js_fields(operand) {
            validate_path(path, PathOptions { positional: true, max_length: limits.max_path_length })?;
            written.push(normalize_positional(path));
            if op == "$rename" {
                let Value::String(target) = value else { return fail("$rename targets must be strings") };
                validate_path(target, plain_path(limits))?;
                written.push(target.clone());
                continue;
            }
            validate_update_value(op, value, limits, 1)?;
        }
    }
    Ok(ParsedUpdate { update: update.clone(), kind: UpdateKind::Operators, written_paths: written })
}

fn validate_update_value(
    op: &str,
    value: &Value,
    limits: &QueryLimits,
    depth: usize,
) -> Result<(), CanopyError> {
    if op == "$pull" {
        if let Value::Document(condition) = value {
            let options = ParseFilterOptions { limits: *limits, ..ParseFilterOptions::default() };
            if js_first_key(condition).is_some_and(|key| key.starts_with('$')) {
                let mut wrapped = Document::with_capacity(1);
                wrapped.insert("v", value.clone());
                parse_filter(&Value::Document(wrapped), &options)?;
            } else {
                parse_filter(value, &options)?;
            }
        }
        return Ok(());
    }
    if let (true, Value::Document(spec)) = (op == "$push" || op == "$addToSet", value)
        && spec.contains_key("$each")
    {
        for (key, _) in js_fields(spec) {
            if !matches!(key, "$each" | "$position" | "$slice" | "$sort") {
                return fail(format!("Unknown {op} modifier {key}"));
            }
        }
        let Some(Value::Array(each)) = spec.get("$each") else { return fail("$each needs an array") };
        if each.len() > limits.max_in_list {
            return fail(format!("$each may not have more than {} values", limits.max_in_list));
        }
        for item in each {
            validate_value_for_storage(item, limits, depth + 1)?;
        }
        return Ok(());
    }
    if op == "$currentDate" || op == "$bit" {
        return Ok(());
    }
    validate_value_for_storage(value, limits, depth)
}

fn validate_value_for_storage(value: &Value, limits: &QueryLimits, depth: usize) -> Result<(), CanopyError> {
    if depth > limits.max_depth {
        return fail(format!("A document may not nest deeper than {} levels", limits.max_depth));
    }
    match value {
        Value::Array(items) => {
            for item in items {
                validate_value_for_storage(item, limits, depth + 1)?;
            }
            Ok(())
        }
        Value::Document(document) => {
            for (key, inner) in js_fields(document) {
                if is_forbidden_key(key) {
                    return fail(format!("The key \"{key}\" is not allowed"));
                }
                if key.is_empty() {
                    return fail("Field names may not be empty");
                }
                if key.starts_with('$') {
                    return fail(format!("Field names may not start with $: {key}"));
                }
                if key.contains('.') {
                    return fail(format!("Field names may not contain dots: {key}"));
                }
                if key.contains('\0') {
                    return fail("Field names may not contain NUL characters");
                }
                validate_value_for_storage(inner, limits, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Validates a document that will be inserted or used as a replacement: no empty, `$` prefixed or dotted
/// keys and no prototype keys at any depth.
pub fn validate_stored_document(document: &Value, limits: &QueryLimits) -> Result<(), CanopyError> {
    if !matches!(document, Value::Document(_)) {
        return fail("A document must be an object");
    }
    validate_value_for_storage(document, limits, 1)
}
