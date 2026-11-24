//! Replays the graphql-js introspection answers without a database.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use apollo_compiler::validation::Valid;
use apollo_compiler::{ExecutableDocument, Schema, request, response::JsonMap};
use canopy_data::schema::{CollectionSchema, Field, ObjectShape, ScalarType, SchemaSource, Shape};
use canopy_graphql::build::{CollectionConfig, RelationConfig, SchemaInput, build_schema};
use canopy_graphql::introspection;
use canopy_policy::{PolicyEngine, RequestContext, contexts_from_stored, create_policy_set, from_stored};
use canopy_protocol::Value;
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json};

const VECTORS: &str = include_str!("../../../conformance/graphql/schema.json");

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
fn document(value: &Json) -> Option<canopy_protocol::Document> {
    match decode(value, DecodeOptions::default()).unwrap() {
        Value::Null => None,
        Value::Document(document) => Some(document),
        value => panic!("expected a document: {value:?}"),
    }
}

fn engine(policies: &Json) -> PolicyEngine {
    let definitions = array(get(policies, "collections"))
        .iter()
        .map(|value| from_stored(&decode(value, DecodeOptions::default()).unwrap()).unwrap())
        .collect::<Vec<_>>();
    let contexts = decode(get(policies, "contexts"), DecodeOptions::default()).unwrap();
    let contexts = contexts_from_stored(Some(&contexts)).unwrap();
    PolicyEngine::new(create_policy_set(definitions, contexts).unwrap())
}

fn collection_schema(value: &Json) -> CollectionSchema {
    CollectionSchema {
        name: string(get(value, "name")).into(),
        shape: object_shape(get(value, "shape")),
        source: match string(get(value, "source")) {
            "validator" => SchemaSource::Validator,
            "inferred" => SchemaSource::Inferred,
            "config" => SchemaSource::Config,
            source => panic!("unknown collection schema source {source}"),
        },
        sampled: value.get("sampled").map(number),
    }
}

fn config(value: &Json) -> CollectionConfig {
    CollectionConfig {
        type_name: value.get("typeName").map(string).map(str::to_owned),
        relations: value
            .get("relations")
            .into_iter()
            .flat_map(object)
            .map(|(name, spec)| {
                (
                    name.clone(),
                    RelationConfig {
                        to: string(get(spec, "to")).into(),
                        local: string(get(spec, "local")).into(),
                        foreign: spec.get("foreign").map(string).map(str::to_owned),
                        many: spec.get("many").is_some_and(boolean),
                    },
                )
            })
            .collect(),
    }
}

fn assert_answer(expected: &Json, actual: &Json, path: &str) {
    match (expected, actual) {
        (Json::Array(expected), Json::Array(actual)) => {
            assert_eq!(expected.len(), actual.len(), "{path}");
            for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                let label = expected.get("name").and_then(|name| match name {
                    Json::String(name) => Some(name.as_str()),
                    _ => None,
                });
                let item = label.map_or_else(|| index.to_string(), str::to_owned);
                assert_answer(expected, actual, &format!("{path}[{item}]"));
            }
        }
        (Json::Object(expected), Json::Object(actual)) => {
            let keys =
                |fields: &[(String, Json)]| fields.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>();
            assert_eq!(keys(expected), keys(actual), "{path}");
            for ((key, expected), (_, actual)) in expected.iter().zip(actual) {
                assert_answer(expected, actual, &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(expected, actual, "{path}"),
    }
}

fn replay(schema: &Valid<Schema>, query: &str, expected: &Json, name: &str) {
    let executable = ExecutableDocument::parse_and_validate(schema, query, "introspection.graphql")
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    let operation = executable.operations.get(None).unwrap();
    let variables = request::coerce_variable_values(schema, operation, &JsonMap::new()).unwrap();
    let response = introspection::partial_execute(schema, &executable, operation, &variables).unwrap();
    assert!(response.errors.is_empty(), "{name}: {:?}", response.errors);
    let actual = parse_json(&serde_json_bytes::Value::Object(response.data.unwrap()).to_string()).unwrap();
    assert_answer(expected, &actual, name);
}

#[test]
fn introspection_matches_graphql_js() {
    let vectors = parse_json(VECTORS).unwrap();
    for case in array(get(&vectors, "cases")) {
        let name = string(get(case, "name"));
        let caller = get(case, "caller");
        let ctx = RequestContext {
            roles: array(get(caller, "roles")).iter().map(string).collect(),
            claims: document(get(caller, "claims")),
            ctx: document(get(caller, "ctx")),
            now: 0,
        };
        let generated = build_schema(&SchemaInput {
            engine: &engine(get(case, "policies")),
            ctx: &ctx,
            collections: &array(get(case, "collections"))
                .iter()
                .map(string)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
            schemas: &array(get(case, "schemas"))
                .iter()
                .map(collection_schema)
                .map(|schema| (schema.name.clone(), schema))
                .collect(),
            config: &object(get(case, "config"))
                .iter()
                .map(|(name, value)| (name.clone(), config(value)))
                .collect(),
            subscriptions: boolean(get(case, "subscriptions")),
            default_limit: number(get(case, "defaultLimit")).try_into().unwrap(),
            max_limit: number(get(case, "maxLimit")).try_into().unwrap(),
        });
        let sdl = generated.sdl();
        let schema = Schema::parse_and_validate(&sdl, "generated.graphql")
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let expected = get(case, "expected");
        let printed = Schema::parse_and_validate(string(get(expected, "sdl")), "graphql-js.graphql")
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(schema, printed, "{name}: SDL schema definitions");
        let schema = introspection::prepare_schema(schema, &generated);
        replay(&schema, string(get(&vectors, "fullQuery")), get(expected, "introspection"), name);
        if matches!(name, "alice" | "empty") {
            replay(&schema, string(get(&vectors, "standardQuery")), get(expected, "standard"), name);
        }
        if name == "all-writes" {
            replay(&schema, string(get(&vectors, "aliasQuery")), get(expected, "aliases"), name);
        }
    }
}
