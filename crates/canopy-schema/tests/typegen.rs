//! Replays the schema generator and pull file oracles.

#![allow(clippy::unwrap_used, clippy::panic)]

use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_protocol::{ErrorCode, Value};
use canopy_schema::{
    CollectionSchema, DEFAULT_SAMPLE_SIZE, EmitOptions, EnumOptions, GenerateOptions, InferOptions,
    PullUpdate, SchemaSource, Shape, emit_schema_file, from_json_schema, generate_types, infer_schema,
    parse_collection_schemas, parse_sample_size, update_schema_file,
};

fn entries(value: &Json) -> &[(String, Json)] {
    let Json::Object(entries) = value else { panic!("expected an object: {value:?}") };
    entries
}

fn array(value: &Json) -> &[Json] {
    let Json::Array(items) = value else { panic!("expected an array: {value:?}") };
    items
}

fn string(value: &Json) -> &str {
    let Json::String(text) = value else { panic!("expected a string: {value:?}") };
    text
}

fn get<'a>(value: &'a Json, name: &str) -> &'a Json {
    value.get(name).unwrap()
}

fn json(value: &Json) -> String {
    let mut text = String::new();
    write_json(&mut text, value);
    text
}

#[test]
fn generated_types_match_every_vector() {
    let vectors = parse_json(include_str!("../../../conformance/typegen/generate.json")).unwrap();
    let examples = array(get(&vectors, "examples"));
    assert!(!examples.is_empty());
    for example in examples {
        let canonical = format!("{{\"version\":1,\"collections\":{}}}", json(get(example, "schemas")));
        let schemas = parse_collection_schemas(&canonical).unwrap();
        let options = get(example, "options");
        let options = GenerateOptions {
            import_from: options.get("importFrom").map(string),
            note: options.get("note").map(string),
        };
        assert_eq!(
            generate_types(&schemas, &options),
            string(get(example, "typescript")),
            "{}",
            string(get(example, "name")),
        );
    }
}

fn infer_fixture(fixture: &Json, sample: usize, infer: &InferOptions) -> Vec<CollectionSchema> {
    entries(fixture)
        .iter()
        .map(|(name, collection)| {
            if let Some(validator) = collection.get("validator") {
                let value = decode(get(validator, "$jsonSchema"), DecodeOptions::default()).unwrap();
                let Shape::Object(shape) = from_json_schema(&value) else { panic!("validator object") };
                CollectionSchema { name: name.clone(), shape, source: SchemaSource::Validator, sampled: None }
            } else {
                let mut docs: Vec<_> = array(get(collection, "documents"))
                    .iter()
                    .map(|value| {
                        let Value::Document(document) = decode(value, DecodeOptions::default()).unwrap()
                        else {
                            panic!("fixture document")
                        };
                        document
                    })
                    .collect();
                docs.sort_by_key(|doc| {
                    let Some(Value::Int32(id)) = doc.get("_id") else { panic!("fixture integer _id") };
                    std::cmp::Reverse(*id)
                });
                docs.truncate(sample);
                infer_schema(name, &docs, infer)
            }
        })
        .collect()
}

fn file_text(entry: &Json) -> String {
    let text = string(get(entry, "text"));
    match string(get(entry, "eol")) {
        "LF" => text.to_owned(),
        "CRLF" => text.replace('\n', "\r\n"),
        eol => panic!("unsupported line ending {eol}"),
    }
}

#[test]
fn pull_matches_every_vector() {
    let vectors = parse_json(include_str!("../../../conformance/typegen/pull.json")).unwrap();
    let fixture = get(&vectors, "fixture");
    let examples = array(get(&vectors, "examples"));
    assert!(!examples.is_empty());
    for example in examples {
        let name = string(get(example, "name"));
        let args: Vec<_> = array(get(example, "args")).iter().map(string).collect();
        let flag = |name: &str| {
            args.windows(2).find_map(|pair| match pair {
                [flag, value] if *flag == name => Some(*value),
                _ => None,
            })
        };
        let collection = flag("--collection");
        let js = args.contains(&"--js");
        let options = EmitOptions { js, ..EmitOptions::default() };
        let infer = InferOptions { enums: args.contains(&"--infer-enums").then(EnumOptions::default) };
        let file = flag("--out").unwrap_or(if js { "canopy.schema.js" } else { "canopy.schema.ts" });
        let existing = array(get(example, "before"))
            .iter()
            .find(|entry| string(get(entry, "path")) == file)
            .map(file_text);
        let result = flag("--sample").map_or(Ok(DEFAULT_SAMPLE_SIZE), parse_sample_size).and_then(|size| {
            let schemas = infer_fixture(fixture, usize::try_from(size).unwrap(), &infer);
            update_schema_file(
                &schemas,
                collection,
                existing.as_deref(),
                file,
                args.contains(&"--force"),
                &options,
            )
            .map(|update| (update, if collection.is_some() { 1 } else { schemas.len() }))
        });

        let (stdout, stderr, exit, output) = match result {
            Ok((PullUpdate::Write(text), count)) => {
                (format!("wrote {file} ({count} collections)\n"), String::new(), 0, Some(text))
            }
            Ok((PullUpdate::Append(text), _)) => {
                (format!("added {} to {file}\n", collection.unwrap()), String::new(), 0, Some(text))
            }
            Ok((PullUpdate::Current, _)) => (format!("{file} is up to date\n"), String::new(), 0, None),
            Ok((PullUpdate::Edited(_), _)) => panic!("{name}: unexpected edited file"),
            Err(error) => (String::new(), format!("{}\n", error.message()), 1, None),
        };
        assert_eq!(stdout, string(get(example, "stdout")), "{name}");
        assert_eq!(stderr, string(get(example, "stderr")), "{name}");
        assert_eq!(Json::Number(f64::from(exit)), *get(example, "exitCode"), "{name}");
        let written = array(get(example, "filesWritten"));
        match (output, written) {
            (None, []) => {}
            (Some(text), [entry]) => {
                assert_eq!(file, string(get(entry, "path")), "{name}");
                assert_eq!(text, file_text(entry), "{name}");
            }
            other => panic!("{name}: unexpected file changes {other:?}"),
        }
    }
}

#[test]
fn authored_schemas_and_invalid_canonical_inputs() {
    let vectors = parse_json(include_str!("../../../conformance/authoring/schema/vectors.json")).unwrap();
    for example in array(get(&vectors, "authored")) {
        parse_collection_schemas(&json(get(example, "document"))).unwrap();
    }
    let invalid = [
        r#"{"version":2,"collections":[]}"#,
        r#"{"version":1,"collections":[],"extra":true}"#,
        r#"{"version":1,"collections":[{"name":"system.bad","source":"config","shape":{"kind":"object","open":true,"fields":{}}}]}"#,
        r#"{"version":1,"collections":[{"name":"test","source":"config","shape":{"kind":"object","open":true,"fields":{"a":{"required":false,"shape":{"kind":"scalar","type":"string","values":["a","a"]}}}}}]}"#,
    ];
    for text in invalid {
        assert_eq!(parse_collection_schemas(text).unwrap_err().code(), ErrorCode::ConfigInvalid);
    }
}

#[test]
fn editable_schema_handles_binding_collisions_bson_and_nested_fields() {
    let source = r#"{"version":1,"collections":[
        {"name":"42 HTTPItems","source":"config","shape":{"kind":"object","open":true,"fields":{
          "_id":{"required":true,"shape":{"kind":"scalar","type":"objectId"}},
          "__proto__":{"required":true,"shape":{"kind":"scalar","type":"binData"}},
          "one field":{"required":false,"shape":{"kind":"union","of":[{"kind":"scalar","type":"null"},{"kind":"array","items":{"kind":"object","open":false,"fields":{
            "_id":{"required":false,"shape":{"kind":"scalar","type":"objectId"}},
            "at":{"required":true,"shape":{"kind":"scalar","type":"date"}},
            "cost":{"required":true,"shape":{"kind":"scalar","type":"decimal"}}
          }}}]}}
        }}},
        {"name":"42_http_items","source":"config","shape":{"kind":"object","open":true,"fields":{}}},
        {"name":"class","source":"config","shape":{"kind":"object","open":true,"fields":{}}},
        {"name":"雪","source":"config","shape":{"kind":"object","open":true,"fields":{}}}
    ]}"#;
    let schemas = parse_collection_schemas(source).unwrap();
    assert_eq!(
        emit_schema_file(&schemas, &EmitOptions { js: true, ..EmitOptions::default() }),
        r#"// Written by canopy pull. This file is yours now: edit it, review it and commit it.
import { collection, defineSchema, t } from "canopy.js/schema"

export const _42HttpItemsCollection = collection("42 HTTPItems", {
  ["__proto__"]: t.binary(),
  "one field": t.array(t.object({
    _id: t.objectId().optional(),
    at: t.date(),
    cost: t.decimal(),
  })).nullable().optional(),
})

export const _42HttpItemsCollection2 = collection("42_http_items", {})

export const classCollection = collection("class", {})

export const Collection = collection("雪", {})

export const schema = defineSchema(_42HttpItemsCollection, _42HttpItemsCollection2, classCollection, Collection)
"#
    );
}

#[test]
fn append_preserves_existing_source_and_adds_missing_builders() {
    let canonical = r#"{"version":1,"collections":[{"name":"notes","source":"config","shape":{"kind":"object","open":false,"fields":{"body":{"required":true,"shape":{"kind":"scalar","type":"string"}}}}}]}"#;
    let schemas = parse_collection_schemas(canonical).unwrap();
    let source = "import { defineSchema } from 'canopy.js/schema'\r\n\r\nconst notes = 42\r\nexport const schema = defineSchema(\r\n)\r\n";
    let result =
        update_schema_file(&schemas, Some("notes"), Some(source), "test.ts", false, &EmitOptions::default())
            .unwrap();
    assert_eq!(result, PullUpdate::Append(
        "import { defineSchema, collection, t } from 'canopy.js/schema'\r\n\r\nconst notes = 42\r\nexport const notes2 = collection(\"notes\", {\r\n  body: t.string(),\r\n})\r\n\r\nexport const schema = defineSchema(notes2)\r\n".to_owned()
    ));
    assert!(matches!(
        update_schema_file(&schemas, None, Some(source), "test.ts", false, &EmitOptions::default()).unwrap(),
        PullUpdate::Edited(_),
    ));
    assert!(matches!(
        update_schema_file(&schemas, None, Some(source), "test.ts", true, &EmitOptions::default()).unwrap(),
        PullUpdate::Write(_),
    ));
}
