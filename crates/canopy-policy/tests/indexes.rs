//! Index advice, confirmation, and replay of the MongoDB CLI oracle.

#![allow(clippy::unwrap_used, clippy::print_stderr)]

use std::collections::BTreeMap;

use canopy_policy::{IndexMode, IndexPlan, advise_indexes, parse_policy_set, plan_indexes};
use canopy_protocol::bson::encode_document;
use canopy_protocol::json::{Json, parse_json};
use mongodb::bson::{Document, doc, oid::ObjectId};
use mongodb::{Client, Database};

const FIXTURE: &str = r#"{
    "version":1,"contexts":{},"collections":[{
        "collection":"notes","exposed":true,"realtime":false,"policies":[
            {"name":"owner read","kind":"permissive","ops":["read"],"roles":["authenticated"],
             "using":{"ownerId":{"$auth":"sub"}}}
        ]
    }]
}"#;

#[test]
fn compound_indexes_merge_reasons_and_respect_existing_prefixes() {
    let set = parse_policy_set(
        r#"{
        "version":1,
        "collections":[{
            "collection":"notes","exposed":true,"realtime":false,"policies":[
                {"name":"compound","kind":"permissive","ops":["read"],"roles":["authenticated"],
                 "using":{"profile.team":{"$auth":"team"},"$and":[{"status":{"$in":["open","draft"]}},
                     {"profile.team":{"$eq":"support"},"_id":"note","age":{"$gt":10}},
                     {"$or":[{"a":1},{"b":2}]}]}},
                {"name":"same fields","kind":"permissive","ops":["read"],"roles":["authenticated"],
                 "using":{"status":"open","profile.team":"support"}},
                {"name":"prefix","kind":"permissive","ops":["read"],"roles":["authenticated"],
                 "using":{"profile.team":"support"}},
                {"name":"status only","kind":"permissive","ops":["read"],"roles":["authenticated"],
                 "using":{"status":"open"}},
                {"name":"write only","kind":"permissive","ops":["insert"],"roles":["authenticated"],
                 "check":{"title":"note"}}
            ]
        }],
        "contexts":{"memberships":{"from":"members","where":{"subject":{"$auth":"sub"},"active":true},
            "select":"group","max":100,"ttl":"30s"}}
    }"#,
    )
    .unwrap();
    let existing = BTreeMap::from([("notes".to_owned(), vec![vec!["age".to_owned(), "status".to_owned()]])]);
    let advice = advise_indexes(&set, &existing);
    assert_eq!(advice.len(), 3);
    assert_eq!(advice[0].collection, "members");
    assert_eq!(advice[0].fields, ["subject", "active"]);
    assert_eq!(advice[0].reasons, ["context lookup memberships"]);
    assert_eq!(advice[1].fields, ["profile.team", "status"]);
    assert_eq!(advice[1].reasons, [r#"policy "compound""#, r#"policy "same fields""#, r#"policy "prefix""#]);
    assert_eq!(advice[2].fields, ["status"]);
    assert_eq!(advice[2].reasons, [r#"policy "status only""#]);

    let existing = BTreeMap::from([(
        "notes".to_owned(),
        vec![["status", "profile.team", "extra"].map(String::from).to_vec()],
    )]);
    let advice = advise_indexes(&set, &existing);
    assert_eq!(advice.len(), 2);
    assert_eq!(advice[1].fields, ["profile.team"]);
    assert_eq!(advice[1].reasons, [r#"policy "prefix""#]);
}

#[test]
fn creation_requires_confirmation_and_an_existing_collection() {
    let set = parse_policy_set(FIXTURE).unwrap();
    let absent = BTreeMap::new();
    let advise = plan_indexes("app", &set, &absent, IndexMode::Advise);
    assert_eq!(
        advise.logs,
        [
            r#"notes does not exist yet; once it does, index ownerId (for policy "owner read")"#,
            "0 indexes suggested on app.",
        ]
    );
    let create = plan_indexes("app", &set, &absent, IndexMode::CreateConfirmed);
    assert_eq!(create.logs, advise.logs[..1]);
    assert_eq!(create.exit_code, 0);
    assert!(create.creations.is_empty());

    let existing = BTreeMap::from([("notes".to_owned(), vec![vec!["_id".to_owned()]])]);
    let refusal = plan_indexes("app", &set, &existing, IndexMode::CreateWithoutTerminal);
    assert_eq!(
        refusal.logs,
        [r#"db.getCollection("notes").createIndex({"ownerId":1})"#, r#"  for policy "owner read""#,]
    );
    assert_eq!(
        refusal.errors,
        ["Not applied: no terminal to confirm on. Pass --yes to apply without a prompt."]
    );
    assert_eq!(refusal.exit_code, 1);
    assert!(refusal.creations.is_empty());

    let prompt = plan_indexes("app", &set, &existing, IndexMode::CreatePrompt);
    assert_eq!(prompt.confirmation_question.as_deref(), Some("Create 1 index on app?"));
    assert_eq!(prompt.logs, refusal.logs);
    assert!(prompt.creations.is_empty());
    let declined = plan_indexes("app", &set, &existing, IndexMode::CreateDeclined);
    assert_eq!(declined.logs.last().map(String::as_str), Some("Not applied."));
    assert_eq!(declined.exit_code, 1);
    assert!(declined.creations.is_empty());
}

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn existing(db: &Database) -> TestResult<BTreeMap<String, Vec<Vec<String>>>> {
    let mut existing = BTreeMap::new();
    for name in db.list_collection_names().await? {
        let mut fields = Vec::new();
        if !name.starts_with("system.") {
            let mut cursor = db.collection::<Document>(&name).list_indexes().await?;
            while cursor.advance().await? {
                let index = cursor.deserialize_current()?;
                fields.push(index.keys.keys().cloned().collect());
            }
        }
        existing.insert(name, fields);
    }
    Ok(existing)
}

fn lines(lines: &[String]) -> String {
    lines.iter().map(|line| format!("{line}\n")).collect()
}

async fn replay(db: &Database) -> TestResult {
    let source = include_str!("../../../conformance/cli/fixture/policies/notes.ts");
    assert!(source.contains(r#"where({ ownerId: auth("sub") }).named("read own")"#));
    let set = parse_policy_set(FIXTURE)?;
    let notes = db.collection::<Document>("notes");
    notes.insert_one(doc! {"_id":"fixture","ownerId":"alice","title":"Fixture note"}).await?;

    let vectors = parse_json(include_str!("../../../conformance/cli/vectors.json"))?;
    let Some(Json::Array(steps)) = vectors.get("steps") else { return Err("Missing CLI steps".into()) };
    let edit =
        steps.iter().find(|step| step.get("id") == Some(&Json::String("push-conflict".to_owned()))).unwrap();
    assert_eq!(
        edit.get("fileInput").and_then(|input| input.get("content")),
        Some(&Json::String(
            source.replace("\r\n", "\n").replace(r#"named("read own")"#, r#"named("owner read")"#)
        )),
    );
    for (id, mode) in [("indexes-advise", IndexMode::Advise), ("indexes-create", IndexMode::CreateConfirmed)]
    {
        let step = steps.iter().find(|step| step.get("id") == Some(&Json::String(id.to_owned()))).unwrap();
        let IndexPlan { logs, errors, exit_code, creations, .. } =
            plan_indexes(db.name(), &set, &existing(db).await?, mode);
        let mut stdout = lines(&logs);
        if mode == IndexMode::CreateConfirmed {
            assert_eq!(creations.len(), 1);
        } else {
            assert!(creations.is_empty());
        }
        for creation in creations {
            let command = Document::from_reader(&mut encode_document(&creation.command)?.as_slice())?;
            assert_eq!(
                command,
                doc! {
                    "createIndexes":"notes",
                    "indexes":[{"name":"ownerId_1","key":{"ownerId":1}}],
                }
            );
            let response = db.run_command(command).await?;
            assert_eq!(response.get_i32("numIndexesAfter")?, 2);
            stdout.push_str(&creation.applied_line);
            stdout.push('\n');
        }
        assert_eq!(step.get("stdout"), Some(&Json::String(stdout.replace(db.name(), "<app-db>"))), "{id}");
        assert_eq!(step.get("stderr"), Some(&Json::String(lines(&errors))), "{id}");
        assert_eq!(step.get("exitCode"), Some(&Json::Number(f64::from(exit_code))), "{id}");
    }
    let mut names = notes.list_index_names().await?;
    names.sort();
    assert_eq!(names, ["_id_", "ownerId_1"]);
    let plan = plan_indexes(db.name(), &set, &existing(db).await?, IndexMode::CreateWithoutTerminal);
    assert_eq!(plan.logs, ["Every policy equality field is served by an index."]);
    assert_eq!(plan.exit_code, 0);
    assert!(plan.errors.is_empty() && plan.creations.is_empty());
    Ok(())
}

#[tokio::test]
async fn replays_index_cli_oracle_against_mongodb() -> TestResult {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping indexes CLI MongoDB replay: CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await?;
    let build_info = client.database("admin").run_command(doc! {"buildInfo":1}).await?;
    eprintln!("Indexes CLI replay on MongoDB {}", build_info.get_str("version")?);
    let db = client.database(&format!("canopy_test_indexes_{}", ObjectId::new().to_hex()));
    let replay_db = db.clone();
    let result = tokio::spawn(async move { replay(&replay_db).await }).await;
    let cleanup = db.drop().await;
    result??;
    cleanup?;
    Ok(())
}
