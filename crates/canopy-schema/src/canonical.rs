use std::collections::HashSet;

use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, ErrorCode};

use crate::{CollectionSchema, Field, ObjectShape, ScalarType, SchemaSource, Shape, field_cmp};

fn invalid(what: &str) -> CanopyError {
    CanopyError::new(ErrorCode::ConfigInvalid, format!("Invalid collection schema: {what}"))
}

fn object(value: &Json, keys: &[&str]) -> bool {
    matches!(value, Json::Object(entries) if entries.iter().all(|(key, _)| keys.contains(&key.as_str())))
}

fn string(value: Option<&Json>) -> Option<&str> {
    match value {
        Some(Json::String(value)) => Some(value),
        _ => None,
    }
}

fn parse_object(value: &Json) -> Result<ObjectShape, CanopyError> {
    let (Some(Json::Object(entries)), Some(Json::Bool(open))) = (value.get("fields"), value.get("open"))
    else {
        return Err(invalid("object fields or open flag"));
    };
    if !object(value, &["kind", "fields", "open"]) || string(value.get("kind")) != Some("object") {
        return Err(invalid("object shape"));
    }
    let mut fields = Vec::with_capacity(entries.len());
    for (name, field) in entries {
        let (Some(Json::Bool(required)), Some(shape)) = (field.get("required"), field.get("shape")) else {
            return Err(invalid("field shape or required flag"));
        };
        if !object(field, &["required", "shape"]) {
            return Err(invalid("field"));
        }
        fields.push((name.clone(), Field { required: *required, shape: parse_shape(shape)? }));
    }
    fields.sort_by(|(a, _), (b, _)| field_cmp(a, b));
    Ok(ObjectShape { fields, open: *open })
}

fn parse_scalar(value: &Json) -> Result<Shape, CanopyError> {
    let scalar =
        string(value.get("type")).and_then(ScalarType::from_name).ok_or_else(|| invalid("scalar type"))?;
    let values = match value.get("values") {
        None => None,
        Some(Json::Array(values)) if scalar == ScalarType::String && !values.is_empty() => {
            let mut seen = HashSet::new();
            let values = values
                .iter()
                .map(|value| {
                    string(Some(value))
                        .filter(|text| seen.insert(*text))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("scalar literal values"))
                })
                .collect::<Result<_, _>>()?;
            Some(values)
        }
        _ => return Err(invalid("scalar literal values")),
    };
    Ok(Shape::Scalar { scalar, values })
}

fn parse_shape(value: &Json) -> Result<Shape, CanopyError> {
    match string(value.get("kind")) {
        Some("any") if object(value, &["kind"]) => Ok(Shape::Any),
        Some("scalar") if object(value, &["kind", "type", "values"]) => parse_scalar(value),
        Some("object") => parse_object(value).map(Shape::Object),
        Some("array") if object(value, &["kind", "items"]) => {
            let items = value.get("items").ok_or_else(|| invalid("array items"))?;
            Ok(Shape::Array(Box::new(parse_shape(items)?)))
        }
        Some("union") if object(value, &["kind", "of"]) => match value.get("of") {
            Some(Json::Array(members)) if members.len() >= 2 => {
                Ok(Shape::Union(members.iter().map(parse_shape).collect::<Result<_, _>>()?))
            }
            _ => Err(invalid("union members")),
        },
        _ => Err(invalid("shape kind")),
    }
}

fn parse_collection(value: &Json) -> Result<CollectionSchema, CanopyError> {
    if !object(value, &["name", "source", "sampled", "shape"]) {
        return Err(invalid("collection"));
    }
    let name = string(value.get("name"))
        .filter(|name| !name.is_empty() && !name.starts_with("system.") && !name.contains(['$', '\0']))
        .ok_or_else(|| invalid("collection name"))?
        .to_owned();
    let source = match string(value.get("source")) {
        Some("config") => SchemaSource::Config,
        Some("validator") => SchemaSource::Validator,
        Some("inferred") => SchemaSource::Inferred,
        _ => return Err(invalid("collection source")),
    };
    let sampled = match value.get("sampled") {
        None => None,
        Some(Json::Number(n)) if *n >= 0.0 && n.fract() == 0.0 && *n < 2.0_f64.powi(usize::BITS as i32) => {
            Some(*n as usize)
        }
        _ => return Err(invalid("sample count")),
    };
    let shape = parse_object(value.get("shape").ok_or_else(|| invalid("collection shape"))?)?;
    Ok(CollectionSchema { name, shape, source, sampled })
}

/// Decodes a version 1 canonical collection schema JSON document.
pub fn parse_collection_schemas(text: &str) -> Result<Vec<CollectionSchema>, CanopyError> {
    let value = parse_json(text)?;
    if !object(&value, &["version", "collections"]) || value.get("version") != Some(&Json::Number(1.0)) {
        return Err(invalid("document version"));
    }
    let Some(Json::Array(collections)) = value.get("collections") else {
        return Err(invalid("collections"));
    };
    collections.iter().map(parse_collection).collect()
}
