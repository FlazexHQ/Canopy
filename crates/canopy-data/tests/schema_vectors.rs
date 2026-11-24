//! Replays the collection schema answers from TypeScript.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_data::schema::{
    EnumOptions, Field, InferOptions, ObjectShape, RestrictMode, ScalarType, SchemaSource, Shape,
    from_json_schema, infer_schema, restrict_shape,
};
use canopy_policy::FieldAccess;
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{DbPointer, Document, JavaScript, Value};

const VECTORS: &str = include_str!("../../../conformance/schema/schema.json");

fn get<'a>(doc: &'a Json, key: &str) -> &'a Json {
    doc.get(key).unwrap_or_else(|| panic!("missing {key} in {doc:?}"))
}

fn array(value: &Json) -> &[Json] {
    let Json::Array(values) = value else { panic!("expected an array: {value:?}") };
    values
}

fn string(value: &Json) -> &str {
    let Json::String(text) = value else { panic!("expected a string: {value:?}") };
    text
}

fn boolean(value: &Json) -> bool {
    let Json::Bool(flag) = value else { panic!("expected a boolean: {value:?}") };
    *flag
}

fn number(value: &Json) -> usize {
    let Json::Number(value) = value else { panic!("expected a number: {value:?}") };
    value.to_string().parse().expect("a nonnegative integer")
}

fn object(value: &Json) -> &[(String, Json)] {
    let Json::Object(fields) = value else { panic!("expected an object: {value:?}") };
    fields
}

fn shape(value: &Json) -> Shape {
    match string(get(value, "kind")) {
        "any" => Shape::Any,
        "array" => Shape::Array(Box::new(shape(get(value, "items")))),
        "union" => Shape::Union(array(get(value, "of")).iter().map(shape).collect()),
        "scalar" => Shape::Scalar {
            scalar: ScalarType::from_name(string(get(value, "type"))).expect("a scalar type"),
            values: value
                .get("values")
                .map(|values| array(values).iter().map(string).map(str::to_owned).collect()),
        },
        "object" => Shape::Object(object_shape(value)),
        kind => panic!("unknown shape {kind}"),
    }
}

fn object_shape(value: &Json) -> ObjectShape {
    assert_eq!(string(get(value, "kind")), "object");
    let fields = object(get(value, "fields"))
        .iter()
        .map(|(name, field)| {
            (
                name.clone(),
                Field { shape: shape(get(field, "shape")), required: boolean(get(field, "required")) },
            )
        })
        .collect();
    ObjectShape { fields, open: boolean(get(value, "open")) }
}

fn ejson(value: &Json) -> Value {
    match value {
        Json::Array(items) => Value::Array(items.iter().map(ejson).collect()),
        Json::Object(fields) => {
            if let Some(undefined) = value.get("$undefined") {
                assert!(boolean(undefined));
                return Value::Undefined;
            }
            if let Some(symbol) = value.get("$symbol") {
                return Value::Symbol(string(symbol).to_owned());
            }
            if let Some(code) = value.get("$code") {
                return Value::JavaScript(Box::new(JavaScript {
                    code: string(code).to_owned(),
                    scope: value.get("$scope").map(document),
                }));
            }
            if let Some(pointer) = value.get("$dbPointer") {
                let Value::ObjectId(id) = ejson(get(pointer, "$id")) else { panic!("expected an ObjectId") };
                return Value::DbPointer(Box::new(DbPointer {
                    namespace: string(get(pointer, "$ref")).to_owned(),
                    id,
                }));
            }
            if fields.iter().any(|(key, _)| key.starts_with('$')) {
                return decode(value, DecodeOptions::default()).expect("canonical EJSON");
            }
            Value::Document(document(value))
        }
        _ => decode(value, DecodeOptions::default()).expect("canonical EJSON scalar"),
    }
}

fn document(value: &Json) -> Document {
    object(value).iter().map(|(key, value)| (key.clone(), ejson(value))).collect()
}

#[test]
fn inference_matches_typescript() {
    let vectors = parse_json(VECTORS).expect("schema vectors");
    for case in array(get(&vectors, "inference")) {
        let name = string(get(case, "name"));
        let docs: Vec<_> = array(get(case, "docs")).iter().map(document).collect();
        let defaults = EnumOptions::default();
        let enums = match get(case, "options").get("enums") {
            Some(Json::Bool(true)) => Some(defaults),
            Some(options @ Json::Object(_)) => Some(EnumOptions {
                max_values: options.get("maxValues").map_or(defaults.max_values, number),
                min_samples: options.get("minSamples").map_or(defaults.min_samples, number),
            }),
            None | Some(Json::Bool(false)) => None,
            other => panic!("invalid enum options: {other:?}"),
        };
        let actual = infer_schema(name, &docs, &InferOptions { enums });
        let expected = get(case, "expected");
        assert_eq!(actual.name, string(get(expected, "name")), "{name}");
        assert_eq!(string(get(expected, "source")), "inferred", "{name}");
        assert_eq!(actual.source, SchemaSource::Inferred, "{name}");
        assert_eq!(actual.sampled, Some(number(get(expected, "sampled"))), "{name}");
        assert_eq!(actual.shape, object_shape(get(expected, "shape")), "{name}");
    }
}

#[test]
fn json_schema_matches_typescript() {
    let vectors = parse_json(VECTORS).expect("schema vectors");
    for case in array(get(&vectors, "validators")) {
        let input = get(case, "schema");
        assert_eq!(from_json_schema(&ejson(input)), shape(get(case, "expected")), "{input:?}");
    }
}

#[test]
fn restrictions_match_typescript() {
    let vectors = parse_json(VECTORS).expect("schema vectors");
    for case in array(get(&vectors, "restrictions")) {
        let access = get(case, "access");
        let paths = || array(get(access, "paths")).iter().map(string).map(str::to_owned).collect();
        let access = match string(get(access, "kind")) {
            "all" => FieldAccess::All,
            "only" => FieldAccess::Only(paths()),
            "omit" => FieldAccess::Omit(paths()),
            kind => panic!("unknown field access {kind}"),
        };
        let mode = match string(get(case, "mode")) {
            "remove" => RestrictMode::Remove,
            "optional" => RestrictMode::Optional,
            mode => panic!("unknown restriction mode {mode}"),
        };
        let actual = restrict_shape(&object_shape(get(case, "shape")), &access, mode);
        assert_eq!(actual, object_shape(get(case, "expected")), "{access:?} {mode:?}");
    }
}
