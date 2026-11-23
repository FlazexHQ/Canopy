use canopy_protocol::{CanopyError, Document, Value};
use canopy_query::{
    DEFAULT_LIMITS, FilterContext, ParseFilterOptions, PathOptions, QueryLimits, parse_expression,
    parse_filter, validate_path,
};

use crate::engine::PolicyEngine;
use crate::fields::{can_access, to_projection};
use crate::model::{Operation, RequestContext};
use crate::search::{SEARCH_STAGES, SearchScope, secure_search_stage};
use crate::values::js_number;

/// Limits on caller pipelines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PipelineLimits {
    /// Maximum stages, counting those inside `$facet`, `$lookup` and `$unionWith`.
    pub max_stages: usize,
    /// Maximum `$sample` size.
    pub max_sample: u64,
    /// The limits of the filters and expressions inside the stages.
    pub query: QueryLimits,
}

/// Default pipeline limits.
pub const DEFAULT_PIPELINE_LIMITS: PipelineLimits =
    PipelineLimits { max_stages: 20, max_sample: 1000, query: DEFAULT_LIMITS };

/// Options of [`secure_pipeline`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecurePipelineOptions {
    /// Allows `$search` and `$vectorSearch` as the first stage, for a collection with a search index the app
    /// opted in.
    pub search: bool,
    /// The most documents `$vectorSearch` may ask for.
    pub max_search_results: u64,
}

impl Default for SecurePipelineOptions {
    fn default() -> SecurePipelineOptions {
        SecurePipelineOptions { search: false, max_search_results: 1000 }
    }
}

/// Stages whose operand is checked as an aggregation expression and kept as it is.
const EXPRESSION_STAGES: [&str; 13] = [
    "$project",
    "$addFields",
    "$set",
    "$group",
    "$bucket",
    "$bucketAuto",
    "$sortByCount",
    "$replaceRoot",
    "$replaceWith",
    "$densify",
    "$fill",
    "$setWindowFields",
    "$sort",
];

const LOOKUP_KEYS: [&str; 6] = ["from", "localField", "foreignField", "let", "pipeline", "as"];
const UNION_KEYS: [&str; 2] = ["coll", "pipeline"];

fn fail<T>(message: impl Into<String>) -> Result<T, CanopyError> {
    Err(CanopyError::invalid_query(message))
}

struct State<'a> {
    engine: &'a PolicyEngine,
    ctx: &'a RequestContext,
    limits: &'a PipelineLimits,
    stages: usize,
}

fn stage(name: &str, value: Value) -> Document {
    [(name.to_owned(), value)].into_iter().collect()
}

fn safe_integer(value: &Value) -> Option<f64> {
    js_number(value).filter(|number| number.trunc() == *number && number.abs() <= 9_007_199_254_740_991.0)
}

fn path_options(limits: &QueryLimits) -> PathOptions {
    PathOptions { positional: false, max_length: limits.max_path_length }
}

/// Makes a caller's aggregation pipeline safe to run on `collection`. The result starts with
/// `{ $match: USING(read) }` and a projection of the readable fields, so every later stage only sees what the
/// caller may read. `$lookup` and `$unionWith` must name collections the caller may read, and get the same
/// prefix for that collection inside their pipeline; `$lookup` joins only on readable foreign fields, because
/// the join runs on the foreign documents before their pipeline does. Stages outside the allowlist (`$out`,
/// `$merge`, `$graphLookup`, `$search`, the diagnostic stages and anything unknown) are refused, and so are
/// `$function`, `$accumulator`, `$where` and system variables other than `$$NOW`, `$$ROOT`, `$$CURRENT` and
/// `$$REMOVE`.
///
/// With `options.search`, the pipeline may start with `$search` or `$vectorSearch`; the prefix then follows
/// that stage, so the search runs over the collection and the policy filters its results before any later
/// stage. Every field the search uses must be readable for the caller, and operators that can match any field
/// (`queryString`, `moreLikeThis`, wildcard paths) need every field readable. Fails with an invalid query
/// error.
pub fn secure_pipeline(
    engine: &PolicyEngine,
    collection: &str,
    pipeline: &Value,
    ctx: &RequestContext,
    limits: &PipelineLimits,
    options: SecurePipelineOptions,
) -> Result<Vec<Document>, CanopyError> {
    let mut state = State { engine, ctx, limits, stages: 0 };
    let first = pipeline.as_array().and_then(<[Value]>::first);
    let search = first
        .and_then(Value::as_document)
        .and_then(|document| document.first_key().map(|name| (document, name)))
        .filter(|(_, name)| options.search && SEARCH_STAGES.contains(name));
    let Some((first, name)) = search else {
        let mut out = prefix(&state, collection);
        out.extend(stages(&mut state, pipeline, "The pipeline")?);
        return Ok(out);
    };
    if first.len() != 1 {
        return fail("A stage must have exactly one key");
    }
    state.stages += 1;
    let value = first.get(name).cloned().unwrap_or(Value::Null);
    let search_stage = if ctx.is_service() {
        stage(name, value)
    } else {
        let scope = SearchScope {
            readable: engine.readable(collection, ctx),
            max_results: options.max_search_results,
        };
        secure_search_stage(&scope, name, &value)?
    };
    let rest = Value::Array(pipeline.as_array().map(|items| items[1..].to_vec()).unwrap_or_default());
    let mut out = vec![search_stage];
    out.extend(prefix(&state, collection));
    out.extend(stages(&mut state, &rest, "The pipeline")?);
    Ok(out)
}

/// The stages that restrict a collection to what the caller may read.
fn prefix(state: &State<'_>, collection: &str) -> Vec<Document> {
    let State { engine, ctx, .. } = state;
    if ctx.is_service() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let using = engine.using(collection, Operation::Read, ctx);
    if using.kind() != "all" {
        out.push(stage("$match", Value::Document(using.to_filter())));
    }
    if let Some(projection) = to_projection(&engine.readable(collection, ctx)) {
        out.push(stage("$project", Value::Document(projection)));
    }
    out
}

fn readable_collection(state: &State<'_>, name: Option<&Value>, stage: &str) -> Result<String, CanopyError> {
    let name = match name {
        Some(Value::String(name))
            if !name.is_empty() && !name.contains('$') && !name.starts_with("system.") =>
        {
            name
        }
        _ => return fail(format!("{stage} needs a collection name")),
    };
    let State { engine, ctx, .. } = state;
    if ctx.is_service() {
        return Ok(name.clone());
    }
    if !engine.is_exposed(name) || !engine.has_grant(name, Operation::Read, ctx) {
        return fail(format!("{stage} cannot read from '{name}'"));
    }
    Ok(name.clone())
}

fn stages(state: &mut State<'_>, input: &Value, what: &str) -> Result<Vec<Document>, CanopyError> {
    let Value::Array(items) = input else { return fail(format!("{what} must be an array of stages")) };
    items.iter().map(|item| sanitize_stage(state, item)).collect()
}

fn sanitize_stage(state: &mut State<'_>, input: &Value) -> Result<Document, CanopyError> {
    let Value::Document(input) = input else { return fail("A stage must be a document") };
    let Some(name) = input.first_key().filter(|_| input.len() == 1) else {
        return fail("A stage must have exactly one key");
    };
    state.stages += 1;
    if state.stages > state.limits.max_stages {
        return fail(format!("A pipeline may not have more than {} stages", state.limits.max_stages));
    }
    let value = input.get(name).unwrap_or(&Value::Null);
    let query = &state.limits.query;
    if EXPRESSION_STAGES.contains(&name) {
        parse_expression(value, query)?;
        return Ok(stage(name, value.clone()));
    }
    match name {
        "$match" => {
            let Value::Document(filter) = value else { return fail("$match needs a document") };
            if filter.contains_key("$text") {
                return fail("$text is not supported in aggregations");
            }
            let options = ParseFilterOptions {
                context: FilterContext::Filter,
                limits: *query,
                variables: false,
                expressions: true,
            };
            parse_filter(value, &options)?;
            Ok(stage("$match", value.clone()))
        }
        "$limit" => match safe_integer(value) {
            Some(limit) if limit >= 1.0 => Ok(stage("$limit", value.clone())),
            _ => fail("$limit needs a positive integer"),
        },
        "$skip" => match safe_integer(value) {
            Some(skip) if skip >= 0.0 => Ok(stage("$skip", value.clone())),
            _ => fail("$skip needs a non negative integer"),
        },
        "$count" => match value {
            Value::String(field) if !field.is_empty() && !field.starts_with('$') && !field.contains('.') => {
                Ok(stage("$count", value.clone()))
            }
            _ => fail("$count needs a field name"),
        },
        "$unset" => {
            let paths = match value {
                Value::String(_) => std::slice::from_ref(value),
                Value::Array(paths) if !paths.is_empty() => paths.as_slice(),
                _ => return fail("$unset needs a path or a list of paths"),
            };
            for path in paths {
                let Value::String(path) = path else { return fail("$unset needs field paths") };
                validate_path(path, path_options(query))?;
            }
            Ok(stage("$unset", value.clone()))
        }
        "$unwind" => {
            parse_expression(value, query)?;
            if !matches!(value, Value::String(_) | Value::Document(_)) {
                return fail("$unwind needs a path or a document");
            }
            Ok(stage("$unwind", value.clone()))
        }
        "$sample" => {
            let size = match value {
                Value::Document(spec) if spec.len() == 1 => spec.get("size").and_then(safe_integer),
                _ => None,
            };
            let Some(size) = size.filter(|size| *size >= 1.0) else {
                return fail("$sample needs { size: n }");
            };
            #[allow(clippy::cast_precision_loss)]
            if size > state.limits.max_sample as f64 {
                return fail(format!("$sample may not take more than {} documents", state.limits.max_sample));
            }
            let size = value.as_document().and_then(|spec| spec.get("size")).cloned().unwrap_or(Value::Null);
            Ok(stage("$sample", Value::Document(stage("size", size))))
        }
        "$facet" => {
            let Value::Document(branches) = value else { return fail("$facet needs named pipelines") };
            if branches.is_empty() {
                return fail("$facet needs named pipelines");
            }
            let mut out = Document::new();
            for (branch, pipeline) in branches.iter() {
                if branch.is_empty() || branch.starts_with('$') || branch.contains('.') {
                    return fail("$facet outputs need field names");
                }
                let secured = stages(state, pipeline, &format!("The $facet pipeline {branch}"))?;
                out.insert(branch, Value::Array(secured.into_iter().map(Value::Document).collect()));
            }
            Ok(stage("$facet", Value::Document(out)))
        }
        "$lookup" => Ok(stage("$lookup", Value::Document(sanitize_lookup(state, value)?))),
        "$unionWith" => Ok(stage("$unionWith", Value::Document(sanitize_union(state, value)?))),
        _ if SEARCH_STAGES.contains(&name) || name == "$searchMeta" => fail(format!(
            "The stage {name} is not allowed here: only $search and $vectorSearch, as the first stage on a collection with search turned on"
        )),
        _ => fail(format!("The stage {name} is not allowed")),
    }
}

fn variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|next| next.is_ascii_alphanumeric() || next == '_')
}

fn sanitize_lookup(state: &mut State<'_>, value: &Value) -> Result<Document, CanopyError> {
    let Value::Document(spec) = value else { return fail("$lookup needs a document") };
    for key in spec.keys() {
        if !LOOKUP_KEYS.contains(&key) {
            return fail(format!("Unknown $lookup field {key}"));
        }
    }
    let from = readable_collection(state, spec.get("from"), "$lookup")?;
    let max_length = state.limits.query.max_path_length;
    let options = PathOptions { positional: false, max_length };
    let as_field = match spec.get("as") {
        Some(Value::String(field)) if !field.is_empty() => field.clone(),
        _ => return fail("$lookup needs as"),
    };
    validate_path(&as_field, options)?;
    let mut out = stage("from", Value::String(from.clone()));
    match (spec.get("localField"), spec.get("foreignField")) {
        (None, None) => {}
        (Some(_), None) | (None, Some(_)) => {
            return fail("$lookup needs both localField and foreignField, or neither");
        }
        (Some(Value::String(local)), Some(Value::String(foreign))) => {
            validate_path(local, options)?;
            validate_path(foreign, options)?;
            if !can_access(&state.engine.readable(&from, state.ctx), foreign) {
                return fail(format!("$lookup cannot join on the unreadable field {foreign} of '{from}'"));
            }
            out.insert("localField", Value::String(local.clone()));
            out.insert("foreignField", Value::String(foreign.clone()));
        }
        _ => return fail("localField and foreignField must be field paths"),
    }
    if let Some(bindings) = spec.get("let") {
        let Value::Document(names) = bindings else { return fail("$lookup let needs a document") };
        for name in names.keys() {
            if !variable_name(name) {
                return fail(format!("The variable name {name} must start with a lower case letter"));
            }
        }
        parse_expression(bindings, &state.limits.query)?;
        out.insert("let", bindings.clone());
    }
    let sub = match spec.get("pipeline") {
        None => Vec::new(),
        Some(pipeline) => stages(state, pipeline, "$lookup pipeline")?,
    };
    let mut pipeline = prefix(state, &from);
    pipeline.extend(sub);
    out.insert("pipeline", Value::Array(pipeline.into_iter().map(Value::Document).collect()));
    out.insert("as", Value::String(as_field));
    Ok(out)
}

fn sanitize_union(state: &mut State<'_>, value: &Value) -> Result<Document, CanopyError> {
    let spec = match value {
        Value::String(_) => stage("coll", value.clone()),
        Value::Document(spec) => spec.clone(),
        _ => return fail("$unionWith needs a collection name or a document"),
    };
    for key in spec.keys() {
        if !UNION_KEYS.contains(&key) {
            return fail(format!("Unknown $unionWith field {key}"));
        }
    }
    let coll = readable_collection(state, spec.get("coll"), "$unionWith")?;
    let sub = match spec.get("pipeline") {
        None => Vec::new(),
        Some(pipeline) => stages(state, pipeline, "$unionWith pipeline")?,
    };
    let mut pipeline = prefix(state, &coll);
    pipeline.extend(sub);
    let mut out = stage("coll", Value::String(coll));
    out.insert("pipeline", Value::Array(pipeline.into_iter().map(Value::Document).collect()));
    Ok(out)
}
