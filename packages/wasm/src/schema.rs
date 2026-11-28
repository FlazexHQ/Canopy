//! Converts the shared schema model into its authoring JSON form.

use canopy_policy::FieldAccess;
use canopy_port::value_of;
use canopy_protocol::CanopyError;
use canopy_protocol::bson::decode_document;
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_schema::{
    EnumOptions, Field, InferOptions, ObjectShape, RestrictMode, ScalarType, Shape, from_json_schema,
    infer_schema, restrict_shape,
};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::errors::thrown;

fn json_object(fields: impl IntoIterator<Item = (&'static str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn string(text: &str) -> Json {
    Json::String(text.to_owned())
}

fn shape_json(shape: Shape) -> Json {
    match shape {
        Shape::Any => json_object([("kind", string("any"))]),
        Shape::Array(items) => json_object([("kind", string("array")), ("items", shape_json(*items))]),
        Shape::Union(of) => json_object([
            ("kind", string("union")),
            ("of", Json::Array(of.into_iter().map(shape_json).collect())),
        ]),
        Shape::Scalar { scalar, values } => {
            let mut fields = vec![("kind", string("scalar")), ("type", string(scalar.name()))];
            if let Some(values) = values {
                fields.push(("values", Json::Array(values.into_iter().map(Json::String).collect())));
            }
            json_object(fields)
        }
        Shape::Object(object) => json_object([
            ("kind", string("object")),
            ("open", Json::Bool(object.open)),
            (
                "fields",
                Json::Object(
                    object
                        .fields
                        .into_iter()
                        .map(|(name, field)| {
                            (
                                name,
                                json_object([
                                    ("shape", shape_json(field.shape)),
                                    ("required", Json::Bool(field.required)),
                                ]),
                            )
                        })
                        .collect(),
                ),
            ),
        ]),
    }
}

fn json_text(value: Json) -> String {
    let mut text = String::new();
    write_json(&mut text, &value);
    text
}

/// Infers the schema of one collection from consecutive BSON documents.
#[wasm_bindgen(js_name = "inferSchema")]
pub fn infer(
    name: &str,
    documents: &[u8],
    enums: bool,
    max_values: Option<u32>,
    min_samples: Option<u32>,
) -> Result<String, JsValue> {
    let documents = canopy_port::split_documents(documents)
        .and_then(|items| items.into_iter().map(decode_document).collect::<Result<Vec<_>, _>>())
        .map_err(|error| thrown(&error))?;
    let defaults = EnumOptions::default();
    let options = InferOptions {
        enums: enums.then_some(EnumOptions {
            max_values: max_values.map_or(defaults.max_values, |value| value as usize),
            min_samples: min_samples.map_or(defaults.min_samples, |value| value as usize),
        }),
    };
    let sampled = documents.len();
    let schema = infer_schema(name, &documents, &options);
    Ok(json_text(json_object([
        ("name", Json::String(schema.name)),
        ("source", string("inferred")),
        ("sampled", Json::Number(sampled as f64)),
        ("shape", shape_json(Shape::Object(schema.shape))),
    ])))
}

/// Converts a MongoDB JSON Schema validator given as EJSON into an authoring shape.
#[wasm_bindgen(js_name = "shapeFromJsonSchema")]
pub fn shape_from_json_schema(text: &str) -> Result<String, JsValue> {
    let value = value_of(text).map_err(|error| thrown(&error))?;
    Ok(json_text(shape_json(from_json_schema(&value))))
}

fn invalid_shape() -> CanopyError {
    CanopyError::invalid_query("Invalid collection shape")
}

fn as_text(value: Option<&Json>) -> Option<&str> {
    match value {
        Some(Json::String(text)) => Some(text),
        _ => None,
    }
}

fn parse_strings(value: &Json) -> Result<Vec<String>, CanopyError> {
    let Json::Array(items) = value else {
        return Err(invalid_shape());
    };
    items.iter().map(|value| as_text(Some(value)).map(str::to_owned).ok_or_else(invalid_shape)).collect()
}

fn parse_shape(value: &Json, depth: usize) -> Result<Shape, CanopyError> {
    if depth >= 64 {
        return Err(invalid_shape());
    }
    match as_text(value.get("kind")) {
        Some("any") => Ok(Shape::Any),
        Some("scalar") => {
            let scalar =
                as_text(value.get("type")).and_then(ScalarType::from_name).ok_or_else(invalid_shape)?;
            let values = value.get("values").map(parse_strings).transpose()?;
            Ok(Shape::Scalar { scalar, values })
        }
        Some("array") => {
            let items = parse_shape(value.get("items").ok_or_else(invalid_shape)?, depth + 1)?;
            Ok(Shape::Array(Box::new(items)))
        }
        Some("union") => {
            let Some(Json::Array(items)) = value.get("of") else {
                return Err(invalid_shape());
            };
            let items = items.iter().map(|value| parse_shape(value, depth + 1)).collect::<Result<_, _>>()?;
            Ok(Shape::Union(items))
        }
        Some("object") => {
            let (Some(Json::Bool(open)), Some(Json::Object(fields))) =
                (value.get("open"), value.get("fields"))
            else {
                return Err(invalid_shape());
            };
            let fields = fields
                .iter()
                .map(|(name, value)| {
                    let Some(Json::Bool(required)) = value.get("required") else {
                        return Err(invalid_shape());
                    };
                    let shape = parse_shape(value.get("shape").ok_or_else(invalid_shape)?, depth + 1)?;
                    Ok((name.clone(), Field { shape, required: *required }))
                })
                .collect::<Result<_, _>>()?;
            Ok(Shape::Object(ObjectShape { fields, open: *open }))
        }
        _ => Err(invalid_shape()),
    }
}

/// Applies field access to a collection shape given as authoring JSON.
#[wasm_bindgen(js_name = "restrictSchema")]
pub fn restrict_schema(text: &str, access: &str, paths: Vec<String>, mode: &str) -> Result<String, JsValue> {
    let restrict = || {
        let Shape::Object(shape) = parse_shape(&parse_json(text)?, 0)? else {
            return Err(invalid_shape());
        };
        let access = match access {
            "all" if paths.is_empty() => FieldAccess::All,
            "only" => FieldAccess::Only(paths),
            "omit" => FieldAccess::Omit(paths),
            _ => return Err(CanopyError::invalid_query("Invalid schema field access")),
        };
        let mode = match mode {
            "remove" => RestrictMode::Remove,
            "optional" => RestrictMode::Optional,
            _ => return Err(CanopyError::invalid_query("Invalid schema restriction mode")),
        };
        Ok(json_text(shape_json(Shape::Object(restrict_shape(&shape, &access, mode)))))
    };
    restrict().map_err(|error| thrown(&error))
}
