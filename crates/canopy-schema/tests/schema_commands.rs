//! Compatibility tests for schema drift and validator commands.

#![allow(clippy::unwrap_used, clippy::panic)]

use canopy_policy::parse_policy_set;
use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{Document, Value};
use canopy_schema::{
    CollectionSchema, SchemaDiffOptions, SchemaSource, parse_collection_schemas, parse_diff_sample_size,
    schema_diff, schema_diff_actual, schema_diff_collections, schema_push,
};
use mongodb::bson::{Document as DriverDocument, RawDocumentBuf, doc, oid::ObjectId};
use mongodb::{Client, Database};

fn document(text: &str) -> Document {
    let json = parse_json(text).unwrap();
    let Value::Document(document) = decode(&json, DecodeOptions::default()).unwrap() else {
        panic!("expected a document");
    };
    document
}

fn fixture() -> Vec<CollectionSchema> {
    let source = include_str!("../../../conformance/cli/fixture/fixture.schema.ts");
    assert!(source.contains(r#"collection("notes", { ownerId: t.string(), title: t.string() })"#));
    parse_collection_schemas(
        r#"{"version":1,"collections":[{"name":"notes","source":"config","shape":{
        "kind":"object","open":true,"fields":{
            "_id":{"required":true,"shape":{"kind":"scalar","type":"objectId"}},
            "ownerId":{"required":true,"shape":{"kind":"scalar","type":"string"}},
            "title":{"required":true,"shape":{"kind":"scalar","type":"string"}}
        }}}]}"#,
    )
    .unwrap()
}

fn output(lines: &[String]) -> String {
    lines.iter().map(|line| format!("{line}\n")).collect()
}

fn check_step(step: &Json, exit: i32, logs: &[String], errors: &[String]) {
    assert_eq!(step.get("stdout"), Some(&Json::String(output(logs))));
    assert_eq!(step.get("stderr"), Some(&Json::String(output(errors))));
    assert_eq!(step.get("exitCode"), Some(&Json::Number(f64::from(exit))));
}

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn validator(db: &Database) -> TestResult<Option<Document>> {
    let mut cursor = db.list_collections().filter(doc! { "name": "notes" }).await?;
    assert!(cursor.advance().await?);
    let info = cursor.deserialize_current()?;
    info.options.validator.map(|validator| Ok(decode_document(&validator.to_vec()?)?)).transpose()
}

async fn replay(db: &Database) -> TestResult {
    let fixture = fixture();
    let notes = db.collection::<RawDocumentBuf>("notes");
    db.collection::<DriverDocument>("notes")
        .insert_one(doc! { "_id": "fixture", "ownerId": "alice", "title": "Fixture note" })
        .await?;
    let oracle = parse_json(include_str!("../../../conformance/cli/vectors.json"))?;
    let Some(Json::Array(steps)) = oracle.get("steps") else { panic!("expected steps") };
    let mut checked = Vec::new();
    for step in steps {
        let Some(Json::String(id)) = step.get("id") else { panic!("expected step identifier") };
        if !matches!(id.as_str(), "schema-diff" | "schema-push-refused" | "schema-push") {
            continue;
        }
        let before = validator(db).await?;
        match id.as_str() {
            "schema-diff" => {
                let mut cursor = notes.find(doc! {}).sort(doc! { "_id": -1 }).limit(1_000).await?;
                let mut documents = Vec::new();
                while cursor.advance().await? {
                    let raw = cursor.deserialize_current()?;
                    documents.push(decode_document(raw.as_bytes())?);
                }
                let actual =
                    schema_diff_actual("notes", before.as_ref(), &documents, SchemaDiffOptions::default());
                let report = schema_diff("fixture.schema.ts", "<app-db>", &fixture, &[actual], None);
                check_step(step, report.exit_code, &report.logs, &report.errors);
            }
            "schema-push-refused" | "schema-push" => {
                let plan = schema_push("<app-db>", &fixture, &[("notes", before.as_ref())]);
                assert_eq!(plan.question.as_deref(), Some("Apply these validators to <app-db>?"));
                assert_eq!(plan.changes.len(), 1);
                let mut logs = plan.logs;
                let Some(Json::Array(args)) = step.get("args") else { panic!("expected arguments") };
                if args.contains(&Json::String("--yes".into())) {
                    for change in plan.changes {
                        let command =
                            DriverDocument::from_reader(&mut encode_document(&change.command)?.as_slice())?;
                        db.run_command(command).await?;
                        logs.push(change.applied_line);
                    }
                    check_step(step, 0, &logs, &[]);
                    let after = validator(db).await?.unwrap();
                    assert_eq!(
                        after,
                        document(
                            r#"{"$jsonSchema":{"bsonType":"object",
                        "required":["_id","ownerId","title"],"properties":{
                            "_id":{"bsonType":"objectId"},"ownerId":{"bsonType":"string"},"title":{"bsonType":"string"}
                        }}}"#
                        )
                    );
                    let current = schema_push("<app-db>", &fixture, &[("notes", Some(&after))]);
                    assert_eq!(current.logs, ["validators are up to date"]);
                    assert_eq!(current.question, None);
                    assert!(current.changes.is_empty());
                    let actual = schema_diff_actual("notes", Some(&after), &[], SchemaDiffOptions::default());
                    assert_eq!(actual.source, SchemaSource::Validator);
                    let report = schema_diff("fixture.schema.ts", "<app-db>", &fixture, &[actual], None);
                    assert_eq!(report.logs, ["no drift between fixture.schema.ts and <app-db>"]);
                    assert_eq!(report.exit_code, 0);
                } else {
                    assert!(before.is_none());
                    assert!(validator(db).await?.is_none());
                    check_step(
                        step,
                        1,
                        &logs,
                        &["Not applied: no terminal to confirm on. Pass --yes to apply without a prompt."
                            .to_owned()],
                    );
                }
            }
            _ => continue,
        }
        checked.push(id.as_str());
    }
    assert_eq!(checked, ["schema-diff", "schema-push-refused", "schema-push"]);

    let absent = schema_push(db.name(), &fixture, &[]);
    assert_eq!(absent.logs, ["create notes"]);
    assert_eq!(absent.changes[0].applied_line, "created notes");
    notes.drop().await?;
    let command = DriverDocument::from_reader(&mut encode_document(&absent.changes[0].command)?.as_slice())?;
    db.run_command(command).await?;
    let after_create = validator(db).await?.unwrap();
    assert!(schema_push(db.name(), &fixture, &[("notes", Some(&after_create))]).changes.is_empty());
    Ok(())
}

#[tokio::test]
async fn replays_schema_cli_oracle_against_mongodb() -> TestResult {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping schema CLI MongoDB replay: CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await?;
    let db = client.database(&format!("canopy_test_schema_{}", ObjectId::new().to_hex()));
    let replay_db = db.clone();
    let result = tokio::spawn(async move { replay(&replay_db).await }).await;
    let cleanup = db.drop().await;
    result??;
    cleanup?;
    Ok(())
}

#[test]
fn sample_limits_and_enum_inference_affect_drift() {
    let declared = parse_collection_schemas(
        r#"{"version":1,"collections":[{"name":"notes","source":"config",
        "shape":{"kind":"object","open":true,"fields":{
            "status":{"required":true,"shape":{"kind":"scalar","type":"string","values":["open"]}}
        }}}]}"#,
    )
    .unwrap();
    let mut documents = vec![document(r#"{"status":"open"}"#); 200];
    documents.push(document(r#"{"status":"closed","extra":true}"#));
    let compare = |options| {
        let actual = schema_diff_actual("notes", None, &documents, options);
        schema_diff("notes.ts", "app", &declared, &[actual], None)
    };
    let capped = compare(SchemaDiffOptions { sample_size: 200, infer_enums: true });
    assert_eq!(capped.logs, ["no drift between notes.ts and app"]);
    let plain = compare(SchemaDiffOptions { sample_size: 201, infer_enums: false });
    assert_eq!(
        plain.errors,
        [
            "notes.extra is in the database (bool) but not in the schema file",
            "1 differences; edit notes.ts or run canopy schema push",
        ]
    );
    let enums = compare(SchemaDiffOptions { sample_size: 201, infer_enums: true });
    assert_eq!(
        enums.errors,
        [
            "notes.extra is in the database (bool) but not in the schema file",
            r#"notes.status is "open" in the schema file but "closed" | "open" in the database"#,
            "2 differences; edit notes.ts or run canopy schema push",
        ]
    );
    for invalid in ["", "0", "01", "-1", "1.5", "1e2", "9007199254740992"] {
        assert_eq!(
            parse_diff_sample_size(invalid).unwrap_err().message(),
            "--sample needs a positive integer"
        );
    }
    assert_eq!(parse_diff_sample_size("9007199254740991").unwrap(), 9_007_199_254_740_991);
}

#[test]
fn role_reports_nested_fields_and_preserves_drift_exit_status() {
    let mut declared = fixture();
    declared[0].shape = schema_diff_actual(
        "notes",
        Some(&document(
            r#"{"$jsonSchema":{
        "bsonType":"object","properties":{
            "_id":{"bsonType":"objectId"},"ownerId":{"bsonType":"string"},
            "lines":{"bsonType":"array","items":{"bsonType":"object","properties":{
                "cost":{"bsonType":"int"},"sku":{"bsonType":"string"}
            }}}
        }}}"#,
        )),
        &[],
        SchemaDiffOptions::default(),
    )
    .shape;
    let policies = parse_policy_set(
        r#"{"version":1,"contexts":{},"collections":[{
        "collection":"notes","exposed":true,"realtime":false,"policies":[
            {"name":"read","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":{}},
            {"name":"insert","kind":"permissive","ops":["insert"],"roles":["editor"],"check":{}}
        ],"fields":{"read":{"default":{"omit":["lines.cost"]}},
                    "write":{"default":{"only":["lines.sku"]}},
                    "update":{"default":{"only":["ownerId"]}}}
    }]}"#,
    )
    .unwrap();
    assert_eq!(schema_diff_collections(["other", "system.views"], Some(&policies)), ["notes"]);
    assert_eq!(schema_diff_collections(["other", "system.views"], None), ["other"]);
    let report = schema_diff("notes.ts", "app", &declared, &[], Some(("editor", &policies)));
    assert_eq!(report.exit_code, 1);
    assert_eq!(
        report.logs,
        [
            "role editor on notes:",
            "  cannot read: lines.cost",
            "  cannot write: lines.cost, ownerId (on insert)",
        ]
    );
    let anon = schema_diff("notes.ts", "app", &declared, &declared, Some(("anon", &policies)));
    assert_eq!(anon.exit_code, 0);
    assert_eq!(
        anon.logs,
        [
            "no drift between notes.ts and app",
            "role anon on notes:",
            "  cannot read the collection",
            "  cannot write: _id, lines, lines.cost, lines.sku, ownerId (on insert)",
        ]
    );
    let service = schema_diff("notes.ts", "app", &declared, &declared, Some(("service", &policies)));
    assert_eq!(service.logs[1], "role service can read and write every declared field");
}

#[test]
fn validator_equality_ignores_document_order_and_preserves_array_order() {
    let declared = fixture();
    let reordered = document(
        r#"{"$jsonSchema":{
        "properties":{"title":{"bsonType":"string"},"_id":{"bsonType":"objectId"},"ownerId":{"bsonType":"string"}},
        "required":["_id","ownerId","title"],"bsonType":"object"
    }}"#,
    );
    assert!(schema_push("app", &declared, &[("notes", Some(&reordered))]).changes.is_empty());
    let mut wrong = reordered;
    let Some(Value::Document(schema)) = wrong.get_mut("$jsonSchema") else { panic!("expected schema") };
    let Some(Value::Array(required)) = schema.get_mut("required") else { panic!("expected required array") };
    required.reverse();
    assert_eq!(schema_push("app", &declared, &[("notes", Some(&wrong))]).logs, ["update validator of notes"]);
}

#[test]
fn drift_reports_closed_fields_requiredness_and_nested_types_in_order() {
    let declared = parse_collection_schemas(
        r#"{"version":1,"collections":[
        {"name":"z","source":"config","shape":{"kind":"object","open":true,"fields":{}}},
        {"name":"a","source":"config","shape":{"kind":"object","open":true,"fields":{
            "optional":{"required":false,"shape":{"kind":"scalar","type":"string"}},
            "data":{"required":true,"shape":{"kind":"array","items":{"kind":"object","open":true,"fields":{
                "binary":{"required":true,"shape":{"kind":"scalar","type":"uuid"}},
                "name":{"required":true,"shape":{"kind":"scalar","type":"string"}}
            }}}}
        }}}
    ]}"#,
    )
    .unwrap();
    let validator = document(
        r#"{"$jsonSchema":{"bsonType":"object","additionalProperties":false,"properties":{
        "data":{"bsonType":"array","items":{"bsonType":"object","required":["binary","name"],"properties":{
            "binary":{"bsonType":"binData"},"name":{"bsonType":"int"}
        }}}
    }}}"#,
    );
    let actual = [
        schema_diff_actual("a", Some(&validator), &[], SchemaDiffOptions::default()),
        schema_diff_actual("b", None, &[], SchemaDiffOptions::default()),
    ];
    let report = schema_diff("schema.ts", "app", &declared, &actual, None);
    assert_eq!(
        report.errors,
        [
            "a.data is required in the schema file but optional in the database",
            "a.data.name is string in the schema file but int in the database",
            "a.optional is in the schema file but the database does not allow it",
            "z is in the schema file but not in the database",
            "b is in the database but not in the schema file",
            "5 differences; edit schema.ts or run canopy schema push",
        ]
    );
}

#[test]
fn validators_preserve_enum_order_and_encode_bson_unions() {
    use canopy_schema::{ScalarType, Shape, to_validator};
    let enum_doc = to_validator(&Shape::Union(vec![
        Shape::Scalar { scalar: ScalarType::String, values: Some(vec!["z".into(), "a".into()]) },
        Shape::scalar(ScalarType::Null),
    ]));
    assert_eq!(
        enum_doc,
        document(r#"{"anyOf":[{"bsonType":"string","enum":["z","a"]},{"bsonType":"null"}]}"#)
    );
    let binary = to_validator(&Shape::Union(
        [ScalarType::Uuid, ScalarType::Null, ScalarType::BinData].map(Shape::scalar).to_vec(),
    ));
    assert_eq!(binary, document(r#"{"bsonType":["binData","null"]}"#));
    assert!(to_validator(&Shape::Union(vec![Shape::scalar(ScalarType::Null), Shape::Any])).is_empty());
}
