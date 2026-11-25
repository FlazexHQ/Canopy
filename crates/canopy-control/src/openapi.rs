use std::collections::BTreeMap;
use std::sync::OnceLock;

use canopy_data::schema::{
    CollectionSchema, ObjectShape, RestrictMode, ScalarType, SchemaCache, SchemaSource, Shape, restrict_shape,
};
use canopy_mongo::mongodb::Database;
use canopy_policy::{Operation, PolicyEngine, RequestContext, Role};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

use crate::Reply;
use crate::core::{err, mongo};

const COLLECTION: &str = "CANOPY_COLLECTION";
static SPEC: OnceLock<Result<Json, CanopyError>> = OnceLock::new();

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    let mut document = Document::new();
    for (key, value) in entries {
        document.insert(key, value);
    }
    Value::Document(document)
}

fn fields(shape: &ObjectShape) -> impl Iterator<Item = (&str, &canopy_data::schema::Field)> {
    shape.fields.iter().map(|(name, field)| (name.as_str(), field))
}

/// Serializes the collection schema in the shape the Studio expects.
pub(crate) fn schema_value(schema: &CollectionSchema) -> Value {
    let mut out = Document::new();
    out.insert("name", string(&schema.name));
    out.insert("shape", shape_value(&Shape::Object(schema.shape.clone())));
    out.insert(
        "source",
        string(match schema.source {
            SchemaSource::Validator => "validator",
            SchemaSource::Config => "config",
            SchemaSource::Inferred => "inferred",
        }),
    );
    if let Some(sampled) = schema.sampled {
        out.insert("sampled", Value::Int64(i64::try_from(sampled).unwrap_or(i64::MAX)));
    }
    Value::Document(out)
}

fn shape_value(shape: &Shape) -> Value {
    match shape {
        Shape::Any => object([("kind", string("any"))]),
        Shape::Scalar { scalar, values } => {
            let mut out = Document::new();
            out.insert("kind", string("scalar"));
            out.insert("type", string(scalar.name()));
            if let Some(values) = values {
                out.insert("values", Value::Array(values.iter().map(|value| string(value)).collect()));
            }
            Value::Document(out)
        }
        Shape::Object(shape) => {
            let mut properties = Document::new();
            for (name, field) in fields(shape) {
                properties.insert(
                    name,
                    object([("shape", shape_value(&field.shape)), ("required", Value::Bool(field.required))]),
                );
            }
            object([
                ("kind", string("object")),
                ("fields", Value::Document(properties)),
                ("open", Value::Bool(shape.open)),
            ])
        }
        Shape::Array(items) => object([("kind", string("array")), ("items", shape_value(items))]),
        Shape::Union(items) => {
            object([("kind", string("union")), ("of", Value::Array(items.iter().map(shape_value).collect()))])
        }
    }
}

fn reference(name: &str) -> Value {
    object([("$ref", Value::String(format!("#/components/schemas/{name}")))])
}

fn scalar_schema(scalar: ScalarType, values: Option<&[String]>) -> Value {
    let kind = match scalar {
        ScalarType::String => "string",
        ScalarType::Int => "integer",
        ScalarType::Bool => "boolean",
        ScalarType::Null => "null",
        ScalarType::Long => return reference("Long"),
        ScalarType::Double => return reference("Double"),
        ScalarType::Decimal => return reference("Decimal128"),
        ScalarType::Date => return reference("Date"),
        ScalarType::ObjectId => return reference("ObjectId"),
        ScalarType::BinData | ScalarType::Uuid => return reference("Binary"),
        ScalarType::Timestamp => return reference("Timestamp"),
        ScalarType::Regex => return reference("RegularExpression"),
        ScalarType::MinKey => return reference("MinKey"),
        ScalarType::MaxKey => return reference("MaxKey"),
        ScalarType::Javascript => return object([]),
    };
    match values {
        Some(values) if scalar == ScalarType::String => object([
            ("type", string(kind)),
            ("enum", Value::Array(values.iter().map(|value| string(value)).collect())),
        ]),
        _ => object([("type", string(kind))]),
    }
}

fn json_schema(shape: &Shape) -> Value {
    match shape {
        Shape::Any => object([]),
        Shape::Scalar { scalar, values } => scalar_schema(*scalar, values.as_deref()),
        Shape::Object(shape) => object_schema(shape, false),
        Shape::Array(items) => object([("type", string("array")), ("items", json_schema(items))]),
        Shape::Union(items) => object([("anyOf", Value::Array(items.iter().map(json_schema).collect()))]),
    }
}

fn object_schema(shape: &ObjectShape, insert: bool) -> Value {
    let mut properties = Document::new();
    let mut required = Vec::new();
    let mut sorted: Vec<_> = fields(shape).collect();
    sorted.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    for (name, field) in sorted {
        properties.insert(name, json_schema(&field.shape));
        if field.required && !(insert && name == "_id") {
            required.push(string(name));
        }
    }
    let mut out = Document::new();
    out.insert("type", string("object"));
    out.insert("properties", Value::Document(properties));
    if insert && !shape.open {
        out.insert("additionalProperties", Value::Bool(false));
    }
    if !required.is_empty() {
        out.insert("required", Value::Array(required));
    }
    if !insert && !shape.open {
        out.insert("additionalProperties", Value::Bool(false));
    }
    Value::Document(out)
}

/// Converts JSON to a value without interpreting Extended JSON wrappers.
pub(crate) fn plain_value(json: Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Bool(value),
        Json::Number(value) => Value::from_js_number(value),
        Json::String(value) => Value::String(value),
        Json::Array(values) => Value::Array(values.into_iter().map(plain_value).collect()),
        Json::Object(entries) => {
            let mut out = Document::new();
            for (key, value) in entries {
                out.insert(key, plain_value(value));
            }
            Value::Document(out)
        }
    }
}

fn component_name(name: &str) -> String {
    name.encode_utf16()
        .map(|unit| {
            u8::try_from(unit)
                .ok()
                .filter(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
                .map_or('_', char::from)
        })
        .collect()
}

fn path_name(name: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn specialize(json: &Json, name: &str, component: &str, policies: &[Value]) -> Value {
    match json {
        Json::String(value) => Value::String(value.replace(COLLECTION, name)),
        Json::Array(values) => {
            Value::Array(values.iter().map(|value| specialize(value, name, component, policies)).collect())
        }
        Json::Object(entries) => {
            let mut out = Document::new();
            for (key, value) in entries {
                let specialized = match (key.as_str(), value) {
                    ("x-canopy-policies", _) => Value::Array(policies.to_vec()),
                    ("operationId" | "$ref", Json::String(value)) => {
                        Value::String(value.replace(COLLECTION, component))
                    }
                    _ => specialize(value, name, component, policies),
                };
                out.insert(key, specialized);
            }
            Value::Document(out)
        }
        value => plain_value(value.clone()),
    }
}

fn operation(method: &str, suffix: &str) -> Operation {
    match (method, suffix) {
        ("post", "") => Operation::Insert,
        ("patch" | "put", _) => Operation::Update,
        ("delete", _) => Operation::Delete,
        _ => Operation::Read,
    }
}

fn invalid_spec() -> CanopyError {
    err(ErrorCode::Internal, "Invalid OpenAPI description")
}

fn entries(value: Option<&Json>) -> Result<&[(String, Json)], CanopyError> {
    match value {
        Some(Json::Object(entries)) => Ok(entries),
        _ => Err(invalid_spec()),
    }
}

/// Describes the REST operations and fields granted to one role.
pub(crate) async fn render(
    app: &Database,
    meta: &Database,
    cache: &SchemaCache,
    role: &str,
    now: i64,
) -> Result<Reply, CanopyError> {
    if role.is_empty()
        || role.len() > 200
        || !role.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    {
        return Err(err(ErrorCode::ValidationFailed, "role is not a role name"));
    }
    let mut roles = [role].into_iter().collect::<canopy_policy::Roles>();
    if !matches!(role, Role::ANON | Role::SERVICE | Role::AUTHENTICATED) {
        roles = [Role::AUTHENTICATED, role].into_iter().collect();
    }
    let ctx = RequestContext { roles, claims: None, ctx: None, now };
    let engine = PolicyEngine::new(canopy_mongo::load_policies(meta).await?);
    let mut names: Vec<_> = engine
        .set()
        .collections()
        .iter()
        .filter(|definition| engine.is_exposed(&definition.collection))
        .map(|definition| definition.collection.clone())
        .collect();
    if ctx.is_service() {
        names.extend(
            app.list_collection_names()
                .await
                .map_err(mongo)?
                .into_iter()
                .filter(|name| !name.starts_with("system.")),
        );
    }
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    names.dedup();

    let template =
        SPEC.get_or_init(|| parse_json(include_str!("openapi.json"))).as_ref().map_err(|_| invalid_spec())?;
    let components = template.get("components").ok_or_else(invalid_spec)?;
    let mut schemas = Document::new();
    for (key, value) in entries(components.get("schemas"))? {
        schemas.insert(key, plain_value(value.clone()));
    }
    let mut paths = BTreeMap::new();
    let mut writes = false;
    let declared_paths = entries(template.get("paths"))?;
    for name in names {
        let grants: Vec<_> =
            Operation::ALL.into_iter().filter(|op| engine.has_grant(&name, *op, &ctx)).collect();
        if grants.is_empty() {
            continue;
        }
        let component = component_name(&name);
        if grants.contains(&Operation::Read) || grants.contains(&Operation::Insert) {
            let shape = cache.get(&name).await?.shape;
            if grants.contains(&Operation::Read) {
                let shape = restrict_shape(&shape, &engine.readable(&name, &ctx), RestrictMode::Remove);
                schemas.insert(format!("{component}.Document"), object_schema(&shape, false));
            }
            if grants.contains(&Operation::Insert) {
                let shape = restrict_shape(
                    &shape,
                    &engine.writable(&name, Operation::Insert, &ctx),
                    RestrictMode::Remove,
                );
                schemas.insert(format!("{component}.Insert"), object_schema(&shape, true));
            }
        }
        for (path, methods) in declared_paths {
            let Some(suffix) = path.strip_prefix("/rest/v1/CANOPY_COLLECTION") else { continue };
            let mut route = Document::new();
            for (method, description) in entries(Some(methods))? {
                let op = operation(method, suffix);
                if !grants.contains(&op) {
                    continue;
                }
                writes |= op != Operation::Read;
                let policies = engine.collection(&name).filter(|_| !ctx.is_service()).map_or_else(
                    Vec::new,
                    |definition| {
                        definition
                            .policies
                            .iter()
                            .filter(|policy| {
                                policy.ops.contains(&op)
                                    && policy
                                        .roles
                                        .iter()
                                        .any(|role| role == Role::PUBLIC || ctx.roles.contains(role))
                            })
                            .map(|policy| string(&policy.name))
                            .collect()
                    },
                );
                route.insert(method, specialize(description, &name, &component, &policies));
            }
            if !route.is_empty() {
                paths.insert(format!("/rest/v1/{}{suffix}", path_name(&name)), Value::Document(route));
            }
        }
    }
    for (path, value) in declared_paths {
        if !path.contains(COLLECTION) && (path != "/rest/v1/_batch" || writes) {
            paths.insert(path.clone(), plain_value(value.clone()));
        }
    }
    let mut paths_document = Document::new();
    for (path, value) in paths {
        paths_document.insert(path, value);
    }
    let copy = |key| template.get(key).cloned().map(plain_value).ok_or_else(invalid_spec);
    let component = |key| components.get(key).cloned().map(plain_value).ok_or_else(invalid_spec);
    Ok(Reply::json(
        200,
        object([
            ("openapi", copy("openapi")?),
            ("info", copy("info")?),
            ("jsonSchemaDialect", copy("jsonSchemaDialect")?),
            ("security", copy("security")?),
            ("paths", Value::Document(paths_document)),
            (
                "components",
                object([
                    ("schemas", Value::Document(schemas)),
                    ("parameters", component("parameters")?),
                    ("securitySchemes", component("securitySchemes")?),
                ]),
            ),
        ]),
    ))
}
