use std::collections::HashSet;

use canopy_protocol::{Document, Value};

use super::{Field, ObjectShape, ScalarType, Shape, field_cmp, js_cmp, union};

/// Reads the shape described by a MongoDB validator or plain JSON Schema.
pub fn from_json_schema(schema: &Value) -> Shape {
    let Some(schema) = document(schema) else { return Shape::Any };
    let alternatives = schema
        .get("anyOf")
        .filter(|value| !matches!(value, Value::Null | Value::Undefined))
        .or_else(|| schema.get("oneOf"));
    if let Some(Value::Array(alternatives)) = alternatives {
        return union(alternatives.iter().map(from_json_schema));
    }
    if let Some(Value::Array(values)) = schema.get("enum")
        && !values.is_empty()
    {
        let mut strings: Vec<_> = values.iter().filter_map(string).map(str::to_owned).collect();
        strings.sort_unstable_by(|a, b| js_cmp(a, b));
        strings.dedup();
        let literals = (!strings.is_empty())
            .then_some(Shape::Scalar { scalar: ScalarType::String, values: Some(strings) });
        return union(literals.into_iter().chain(values.iter().filter_map(|value| match value {
            Value::String(_) => None,
            Value::Null => Some(Shape::scalar(ScalarType::Null)),
            _ => Some(Shape::Any),
        })));
    }
    let bson_type = schema.get("bsonType").filter(|value| !matches!(value, Value::Undefined));
    let types = bson_type.and_then(type_names).or_else(|| schema.get("type").and_then(type_names));
    let Some(types) = types else {
        return if schema.get("properties").and_then(document).is_some() {
            object_shape(schema)
        } else {
            Shape::Any
        };
    };
    union(types.into_iter().map(|name| match name {
        "object" => object_shape(schema),
        "array" => Shape::Array(Box::new(schema.get("items").map_or(Shape::Any, from_json_schema))),
        _ => scalar_shape(name, bson_type.is_some()),
    }))
}

fn document(value: &Value) -> Option<&Document> {
    match value {
        Value::Document(doc) if !matches!(doc.get("_bsontype"), Some(Value::String(_))) => Some(doc),
        _ => None,
    }
}

fn string(value: &Value) -> Option<&str> {
    match value {
        Value::String(name) => Some(name),
        _ => None,
    }
}

fn type_names(value: &Value) -> Option<Vec<&str>> {
    match value {
        Value::Array(values) => values.iter().map(string).collect(),
        _ => string(value).map(|name| vec![name]),
    }
}

fn scalar_shape(name: &str, bson: bool) -> Shape {
    match (name, bson) {
        ("number", true) => union(
            [ScalarType::Int, ScalarType::Long, ScalarType::Double, ScalarType::Decimal].map(Shape::scalar),
        ),
        ("integer", false) => union([ScalarType::Int, ScalarType::Long].map(Shape::scalar)),
        ("number", false) => Shape::scalar(ScalarType::Double),
        ("boolean", false) => Shape::scalar(ScalarType::Bool),
        ("uuid", _) => Shape::Any,
        _ => ScalarType::from_name(name).map_or(Shape::Any, Shape::scalar),
    }
}

fn object_shape(schema: &Document) -> Shape {
    let required: HashSet<_> = match schema.get("required") {
        Some(Value::Array(items)) => items.iter().filter_map(string).collect(),
        _ => HashSet::new(),
    };
    let mut fields: Vec<_> = schema
        .get("properties")
        .and_then(document)
        .into_iter()
        .flat_map(Document::iter)
        .filter(|(key, _)| *key != "__proto__")
        .map(|(key, value)| {
            (key.to_owned(), Field { shape: from_json_schema(value), required: required.contains(key) })
        })
        .collect();
    fields.sort_unstable_by(|(a, _), (b, _)| field_cmp(a, b));
    let open = !matches!(schema.get("additionalProperties"), Some(Value::Bool(false)));
    Shape::Object(ObjectShape { fields, open })
}
