use canopy_policy::{Operation, PolicyEngine, PolicySet, RequestContext, Role};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::typescript::quote;
use crate::{
    CollectionSchema, DEFAULT_SAMPLE_SIZE, EnumOptions, InferOptions, ObjectShape, RestrictMode, ScalarType,
    SchemaSource, Shape, from_json_schema, infer_schema, js_cmp, restrict_shape,
};

/// Options for reading the database side of a schema comparison.
#[derive(Clone, Copy, Debug)]
pub struct SchemaDiffOptions {
    /// Maximum documents per collection, selected in descending `_id` order.
    pub sample_size: usize,
    /// Whether to infer low cardinality string enums.
    pub infer_enums: bool,
}

impl Default for SchemaDiffOptions {
    fn default() -> Self {
        Self { sample_size: DEFAULT_SAMPLE_SIZE as usize, infer_enums: false }
    }
}

/// Parses a positive JavaScript safe integer for `schema diff --sample`.
pub fn parse_diff_sample_size(value: &str) -> Result<usize, CanopyError> {
    if !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(size) = value.parse::<usize>()
        && size as u64 <= 9_007_199_254_740_991
    {
        return Ok(size);
    }
    Err(CanopyError::new(ErrorCode::ConfigInvalid, "--sample needs a positive integer"))
}

/// Selects exposed policy collections, or all listed collections except system collections.
pub fn schema_diff_collections<'a>(
    listed: impl IntoIterator<Item = &'a str>,
    policies: Option<&'a PolicySet>,
) -> Vec<&'a str> {
    let mut names: Vec<_> = policies
        .into_iter()
        .flat_map(PolicySet::collections)
        .filter(|definition| definition.exposed)
        .map(|definition| definition.collection.as_str())
        .collect();
    if names.is_empty() {
        names.extend(listed.into_iter().filter(|name| !name.starts_with("system.")));
    }
    names.sort_by(|a, b| js_cmp(a, b));
    names
}

/// Reads the shape from the collection's validator or infers it from documents in descending `_id` order.
pub fn schema_diff_actual(
    name: &str,
    validator: Option<&Document>,
    documents: &[Document],
    options: SchemaDiffOptions,
) -> CollectionSchema {
    if let Some(schema) =
        validator.and_then(|doc| doc.get("$jsonSchema")).filter(|value| !matches!(value, Value::Undefined))
    {
        let shape = from_json_schema(schema);
        let object = match shape {
            Shape::Object(object) => Some(object),
            Shape::Union(parts) => parts.into_iter().find_map(|part| match part {
                Shape::Object(object) => Some(object),
                _ => None,
            }),
            _ => None,
        };
        return CollectionSchema {
            name: name.to_owned(),
            shape: object.unwrap_or_else(ObjectShape::open),
            source: SchemaSource::Validator,
            sampled: None,
        };
    }
    let count = documents.len().min(options.sample_size);
    let sample = documents.get(..count).unwrap_or_default();
    infer_schema(name, sample, &InferOptions { enums: options.infer_enums.then(EnumOptions::default) })
}

/// Output and exit status for `schema diff`. Lines do not include newline terminators.
#[derive(Debug, PartialEq, Eq)]
pub struct SchemaDiffReport {
    /// Standard output lines.
    pub logs: Vec<String>,
    /// Standard error lines.
    pub errors: Vec<String>,
    /// Zero when no drift was found, otherwise one.
    pub exit_code: i32,
}

/// Formats schema drift and optionally appends a field access report using a parsed canonical policy set.
pub fn schema_diff(
    file: &str,
    database: &str,
    declared: &[CollectionSchema],
    actual: &[CollectionSchema],
    role: Option<(&str, &PolicySet)>,
) -> SchemaDiffReport {
    let mut errors = Vec::new();
    for schema in sorted_schemas(declared) {
        if let Some(found) = actual.iter().rfind(|entry| entry.name == schema.name) {
            compare_objects(
                &schema.shape,
                &found.shape,
                &schema.name,
                found.source == SchemaSource::Inferred,
                &mut errors,
            );
        } else {
            errors.push(format!("{} is in the schema file but not in the database", schema.name));
        }
    }
    for schema in sorted_schemas(actual) {
        if !declared.iter().any(|entry| entry.name == schema.name) {
            errors.push(format!("{} is in the database but not in the schema file", schema.name));
        }
    }
    let mut logs = Vec::new();
    let exit_code = if errors.is_empty() {
        logs.push(format!("no drift between {file} and {database}"));
        0
    } else {
        errors.push(format!("{} differences; edit {file} or run canopy schema push", errors.len()));
        1
    };
    if let Some((role, policies)) = role {
        logs.extend(role_report(declared, policies, role));
    }
    SchemaDiffReport { logs, errors, exit_code }
}

pub(crate) fn sorted_schemas(schemas: &[CollectionSchema]) -> Vec<&CollectionSchema> {
    let mut sorted: Vec<_> = schemas.iter().collect();
    sorted.sort_by(|a, b| js_cmp(&a.name, &b.name));
    sorted
}

fn describe(shape: &Shape) -> String {
    match shape {
        Shape::Any => "any".into(),
        Shape::Scalar { scalar, values: None } => scalar.name().into(),
        Shape::Scalar { values: Some(values), .. } => {
            values.iter().map(|value| quote(value)).collect::<Vec<_>>().join(" | ")
        }
        Shape::Array(items) => format!("array of {}", describe(items)),
        Shape::Object(_) => "object".into(),
        Shape::Union(of) => of.iter().map(describe).collect::<Vec<_>>().join(" | "),
    }
}

pub(crate) fn bson_type(scalar: ScalarType) -> &'static str {
    if scalar == ScalarType::Uuid { "binData" } else { scalar.name() }
}

fn key(shape: &Shape) -> String {
    match shape {
        Shape::Any => "any".into(),
        Shape::Scalar { scalar, values: None } => bson_type(*scalar).into(),
        Shape::Scalar { scalar, values: Some(values) } => {
            let mut values: Vec<_> = values.iter().map(String::as_str).collect();
            values.sort_by(|a, b| js_cmp(a, b));
            format!("{}:{}", scalar.name(), values.join(","))
        }
        Shape::Array(items) => format!("[{}]", key(items)),
        Shape::Object(_) => "object".into(),
        Shape::Union(of) => {
            let mut keys: Vec<_> = of.iter().map(key).collect();
            keys.sort_by(|a, b| js_cmp(a, b));
            keys.dedup();
            keys.join("|")
        }
    }
}

fn covers(outer: &Shape, inner: &Shape, sampled: bool) -> bool {
    matches!(outer, Shape::Any)
        || inner.members().iter().all(|part| {
            outer.members().iter().any(|candidate| match (candidate, part) {
                (Shape::Any, _) | (Shape::Object(_), Shape::Object(_)) => true,
                (Shape::Scalar { scalar: a, values: allowed }, Shape::Scalar { scalar: b, values: seen })
                    if bson_type(*a) == bson_type(*b) =>
                {
                    allowed.as_ref().is_none_or(|allowed| {
                        seen.as_ref().map_or(sampled, |seen| seen.iter().all(|v| allowed.contains(v)))
                    })
                }
                (Shape::Array(a), Shape::Array(b)) => covers(a, b, sampled),
                _ => false,
            })
        })
}

fn objects_of<'a>(shape: &'a Shape, objects: &mut Vec<&'a ObjectShape>) {
    for part in shape.members() {
        match part {
            Shape::Object(object) => objects.push(object),
            Shape::Array(items) => objects_of(items, objects),
            _ => {}
        }
    }
}

fn compare_objects(
    declared: &ObjectShape,
    actual: &ObjectShape,
    prefix: &str,
    sampled: bool,
    errors: &mut Vec<String>,
) {
    let mut names: Vec<_> =
        declared.fields.iter().chain(&actual.fields).map(|(name, _)| name.as_str()).collect();
    names.sort_by(|a, b| js_cmp(a, b));
    names.dedup();
    for name in names {
        let path = format!("{prefix}.{name}");
        match (declared.field(name), actual.field(name)) {
            (None, Some(theirs)) => errors.push(format!(
                "{path} is in the database ({}) but not in the schema file",
                describe(&theirs.shape),
            )),
            (Some(_), None) if !actual.open => {
                errors.push(format!("{path} is in the schema file but the database does not allow it",))
            }
            (Some(mine), None) if mine.required => errors
                .push(format!("{path} is required in the schema file but the database does not have it",)),
            (Some(mine), Some(theirs)) => {
                if key(&mine.shape) != key(&theirs.shape) && !covers(&mine.shape, &theirs.shape, sampled) {
                    errors.push(format!(
                        "{path} is {} in the schema file but {} in the database",
                        describe(&mine.shape),
                        describe(&theirs.shape),
                    ));
                }
                if mine.required != theirs.required {
                    let label = |required| if required { "required" } else { "optional" };
                    errors.push(format!(
                        "{path} is {} in the schema file but {} in the database",
                        label(mine.required),
                        label(theirs.required),
                    ));
                }
                let mut a = Vec::new();
                let mut b = Vec::new();
                objects_of(&mine.shape, &mut a);
                objects_of(&theirs.shape, &mut b);
                if let ([a], [b]) = (a.as_slice(), b.as_slice()) {
                    compare_objects(a, b, &path, sampled, errors);
                }
            }
            _ => {}
        }
    }
}

fn field_paths(shape: &ObjectShape) -> Vec<String> {
    fn visit(shape: &Shape, prefix: &str, paths: &mut Vec<String>) {
        match shape {
            Shape::Array(items) => visit(items, prefix, paths),
            Shape::Union(of) => of.iter().for_each(|part| visit(part, prefix, paths)),
            Shape::Object(object) => visit_object(object, prefix, paths),
            _ => {}
        }
    }
    fn visit_object(shape: &ObjectShape, prefix: &str, paths: &mut Vec<String>) {
        for (name, field) in &shape.fields {
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
            visit(&field.shape, &path, paths);
            paths.push(path);
        }
    }
    let mut paths = Vec::new();
    visit_object(shape, "", &mut paths);
    paths.sort_by(|a, b| js_cmp(a, b));
    paths.dedup();
    paths
}

fn role_report(declared: &[CollectionSchema], policies: &PolicySet, role: &str) -> Vec<String> {
    let engine = PolicyEngine::new(policies.clone());
    let mut ctx = RequestContext { roles: [role].into_iter().collect(), claims: None, ctx: None, now: 0 };
    if !matches!(role, Role::ANON | Role::AUTHENTICATED | Role::SERVICE) {
        ctx.roles.insert(Role::AUTHENTICATED);
    }
    let mut lines = Vec::new();
    for schema in sorted_schemas(declared) {
        let name = &schema.name;
        let paths = field_paths(&schema.shape);
        let excluded = |visible: Vec<String>| {
            paths.iter().filter(|path| !visible.contains(path)).cloned().collect::<Vec<_>>()
        };
        let mut restrictions = Vec::new();
        if engine.has_grant(name, Operation::Read, &ctx) {
            let visible = restrict_shape(&schema.shape, &engine.readable(name, &ctx), RestrictMode::Remove);
            let hidden = excluded(field_paths(&visible));
            if !hidden.is_empty() {
                restrictions.push(format!("  cannot read: {}", hidden.join(", ")));
            }
        } else {
            restrictions.push("  cannot read the collection".to_owned());
        }
        let writable = if engine.has_grant(name, Operation::Insert, &ctx) {
            let visible = restrict_shape(
                &schema.shape,
                &engine.writable(name, Operation::Insert, &ctx),
                RestrictMode::Remove,
            );
            field_paths(&visible)
        } else {
            Vec::new()
        };
        let denied = excluded(writable);
        if !denied.is_empty() {
            restrictions.push(format!("  cannot write: {} (on insert)", denied.join(", ")));
        }
        if !restrictions.is_empty() {
            lines.push(format!("role {role} on {name}:"));
            lines.extend(restrictions);
        }
    }
    if lines.is_empty() {
        lines.push(format!("role {role} can read and write every declared field"));
    }
    lines
}
