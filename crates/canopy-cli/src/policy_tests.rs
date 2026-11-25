use std::process::ExitCode;

use canopy_matcher::compile_filter;
use canopy_mongo::mongodb::bson::{Document as BsonDocument, doc};
use canopy_mongo::mongodb::{Client, Database};
use canopy_mongo::to_bson;
use canopy_policy::{
    Clause, Operation, PolicyEngine, RequestContext, Role, Roles, SimulationCase, can_access, document_paths,
    evaluate_in_memory, immutable_violations, project_readable,
};
use canopy_protocol::ejson::stringify;
use canopy_protocol::{Document, Value};
use canopy_query::{ParseUpdateOptions, parse_update};
use futures_util::TryStreamExt as _;

use crate::bundle::{Subject, TestCase};
use crate::invocation::Invocation;
use crate::output;
use crate::project::Project;
use crate::targets::to_canopy;

/// The most documents a filter case evaluates; a filter that matches more fails.
const FILTER_LIMIT: i64 = 1000;

struct Outcome {
    allowed: bool,
    reason: String,
    document: Option<Document>,
}

fn context(case: &TestCase, now: i64) -> RequestContext {
    let roles: Roles = case.actor.roles.iter().cloned().collect();
    RequestContext { roles, claims: case.actor.claims.clone(), ctx: case.actor.ctx.clone(), now }
}

fn memory(engine: &PolicyEngine, case: &TestCase, document: &Document, now: i64) -> Result<Outcome, String> {
    let context = context(case, now);
    let outcome = evaluate_in_memory(
        engine,
        &SimulationCase {
            collection: &case.collection,
            op: case.action,
            context: &context,
            document,
            update: case.update.as_ref(),
        },
    )
    .map_err(|error| error.message().to_owned())?;
    Ok(Outcome { allowed: outcome.allowed, reason: outcome.reason, document: outcome.document })
}

fn denied(reason: impl Into<String>) -> Outcome {
    Outcome { allowed: false, reason: reason.into(), document: None }
}

fn bson(document: &Document) -> Result<BsonDocument, String> {
    to_bson(document).map_err(|error| error.message().to_owned())
}

/// Evaluates a case against MongoDB: the document is stored in a throwaway collection and MongoDB decides
/// `USING` and `CHECK`; update cases run the real update.
async fn mongodb(
    engine: &PolicyEngine,
    db: &Database,
    counter: usize,
    case: &TestCase,
    document: &Document,
    now: i64,
) -> Result<Outcome, String> {
    let collection = db.collection::<BsonDocument>(&format!("case_{counter}"));
    let result = mongodb_case(engine, &collection, counter, case, document, now).await;
    let _ = collection.drop().await;
    result
}

async fn mongodb_case(
    engine: &PolicyEngine,
    collection: &canopy_mongo::mongodb::Collection<BsonDocument>,
    counter: usize,
    case: &TestCase,
    document: &Document,
    now: i64,
) -> Result<Outcome, String> {
    let context = context(case, now);
    let name = case.collection.as_str();
    let service = context.roles.contains(Role::SERVICE);
    let id = document
        .get("_id")
        .cloned()
        .unwrap_or_else(|| Value::Int32(i32::try_from(counter).unwrap_or(i32::MAX)));
    let mut stored = document.clone();
    if !stored.contains_key("_id") {
        stored.insert("_id", id.clone());
    }
    let stored = bson(&stored)?;
    let mut id_filter = Document::new();
    id_filter.insert("_id", id.clone());
    let id_bson = bson(&id_filter)?;
    let visible = |filter: Document| {
        let id_bson = id_bson.clone();
        async move {
            let combined = doc! { "$and": [id_bson, bson(&filter)?] };
            let count = collection.count_documents(combined).await.map_err(|error| error.to_string())?;
            Ok::<bool, String>(count == 1)
        }
    };
    let insert = || async {
        collection.insert_one(stored.clone()).await.map(|_| ()).map_err(|error| error.to_string())
    };
    if !service && !engine.is_exposed(name) {
        return Ok(denied("the collection is not exposed"));
    }
    match case.action {
        Operation::Read => {
            insert().await?;
            if !visible(engine.using(name, Operation::Read, &context).to_filter()).await? {
                return Ok(denied("not returned by find()"));
            }
            let found = collection.find_one(id_bson.clone()).await.map_err(|error| error.to_string())?;
            let found = match found {
                Some(found) => to_canopy(&found).map_err(|error| error.message().to_owned())?,
                None => return Ok(denied("not returned by find()")),
            };
            let readable = project_readable(&engine.readable(name, &context), &found)
                .map_err(|error| error.message().to_owned())?;
            Ok(Outcome { allowed: true, reason: "returned by find()".to_owned(), document: Some(readable) })
        }
        Operation::Insert => {
            if !engine.has_grant(name, Operation::Insert, &context) {
                return Ok(denied("no policy grants insert"));
            }
            let writable = engine.writable(name, Operation::Insert, &context);
            let blocked: Vec<String> =
                document_paths(document).into_iter().filter(|path| !can_access(&writable, path)).collect();
            if !blocked.is_empty() {
                return Ok(denied(format!("fields not writable: {}", blocked.join(", "))));
            }
            insert().await?;
            if !visible(engine.check(name, Operation::Insert, &context).to_filter()).await? {
                return Ok(denied("MongoDB rejected CHECK(insert)"));
            }
            Ok(Outcome { allowed: true, reason: "inserted".to_owned(), document: None })
        }
        Operation::Update => {
            if !engine.has_grant(name, Operation::Update, &context) {
                return Ok(denied("no policy grants update"));
            }
            insert().await?;
            let target = engine
                .target(name, Operation::Update, &context)
                .map_err(|error| error.message().to_owned())?;
            if !visible(target.to_filter()).await? {
                return Ok(denied("not a target (matched 0)"));
            }
            let empty = Value::Document(Document::new());
            let update = case.update.as_ref().unwrap_or(&empty);
            let options = ParseUpdateOptions { allow_pipeline: service, ..ParseUpdateOptions::default() };
            let written = match parse_update(update, &options) {
                Ok(parsed) => parsed.written_paths,
                Err(error) => return Ok(denied(error.message())),
            };
            if !service {
                let writable = engine.writable(name, Operation::Update, &context);
                let blocked: Vec<String> =
                    written.iter().filter(|path| !can_access(&writable, path)).cloned().collect();
                if !blocked.is_empty() {
                    return Ok(denied(format!("fields not writable: {}", blocked.join(", "))));
                }
                let immutable = immutable_violations(&written, engine.immutable(name));
                if !immutable.is_empty() {
                    return Ok(denied(format!("immutable fields: {}", immutable.join(", "))));
                }
            }
            let applied = match update {
                Value::Document(update) => {
                    collection.update_one(id_bson.clone(), bson(update)?).await.map(|_| ())
                }
                Value::Array(stages) => {
                    let mut pipeline = Vec::new();
                    for stage in stages {
                        if let Value::Document(stage) = stage {
                            pipeline.push(bson(stage)?);
                        }
                    }
                    collection.update_one(id_bson.clone(), pipeline).await.map(|_| ())
                }
                _ => return Ok(denied("An update must be a document or a pipeline")),
            };
            if let Err(error) = applied {
                return Ok(denied(format!("MongoDB rejected the update: {error}")));
            }
            if !visible(engine.check(name, Operation::Update, &context).to_filter()).await? {
                return Ok(denied("MongoDB rejected CHECK(update)"));
            }
            Ok(Outcome { allowed: true, reason: "updated".to_owned(), document: None })
        }
        Operation::Delete => {
            if !engine.has_grant(name, Operation::Delete, &context) {
                return Ok(denied("no policy grants delete"));
            }
            insert().await?;
            let target = engine
                .target(name, Operation::Delete, &context)
                .map_err(|error| error.message().to_owned())?;
            if !visible(target.to_filter()).await? {
                return Ok(denied("not a target (matched 0)"));
            }
            Ok(Outcome { allowed: true, reason: "deleted".to_owned(), document: None })
        }
    }
}

fn has_path(document: &Document, path: &str) -> bool {
    let mut segments = path.split('.');
    let Some(first) = segments.next() else { return false };
    let mut value = match document.get(first) {
        Some(value) => value,
        None => return false,
    };
    for segment in segments {
        let Value::Document(inner) = value else { return false };
        let Some(next) = inner.get(segment) else { return false };
        value = next;
    }
    true
}

fn json(value: &Value) -> String {
    stringify(value).unwrap_or_else(|_| "?".to_owned())
}

fn describe(case: &TestCase, document: &Document) -> String {
    let verb = if case.expected { "can" } else { "cannot" };
    let shown = document.get("_id").cloned().unwrap_or_else(|| Value::Document(document.clone()));
    format!("{} {verb} {} {}", case.actor.label, case.action.as_str(), json(&shown))
}

/// Checks one concrete document on every backend and returns the failures.
fn judge(case: &TestCase, document: &Document, outcomes: &[(&str, Result<Outcome, String>)]) -> Vec<String> {
    let mut failures = Vec::new();
    let mut verdicts = Vec::new();
    for (backend, outcome) in outcomes {
        let failed;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(message) => {
                failed = denied(format!("backend error: {message}"));
                failures.push(format!("{backend}: {}", failed.reason));
                &failed
            }
        };
        verdicts.push((*backend, outcome.allowed, outcome.reason.clone()));
        if outcome.allowed != case.expected {
            failures.push(format!(
                "{backend}: expected {}, but {}",
                describe(case, document),
                outcome.reason
            ));
        }
        if let (true, Some(visible)) = (outcome.allowed, &outcome.document) {
            for field in &case.without_fields {
                if has_path(visible, field) {
                    failures.push(format!("{backend}: {field} should be hidden"));
                }
            }
            for field in &case.with_fields {
                if !has_path(visible, field) {
                    failures.push(format!("{backend}: {field} should be visible"));
                }
            }
        }
    }
    if verdicts.iter().any(|(_, allowed, _)| *allowed) && verdicts.iter().any(|(_, allowed, _)| !*allowed) {
        let parts: Vec<String> = verdicts
            .iter()
            .map(|(backend, allowed, reason)| {
                format!("{backend} {} ({reason})", if *allowed { "allowed" } else { "denied" })
            })
            .collect();
        failures.push(format!("backends disagree: {}", parts.join(", ")));
    }
    failures
}

enum Verdict {
    Passed,
    Failed(Vec<String>),
    NotRun,
}

fn label(case: &TestCase) -> String {
    let verb = if case.expected { "can" } else { "cannot" };
    format!("{}: {} {verb} {}", case.suite, case.actor.label, case.action.as_str())
}

/// `canopy policies test`: runs every test case of the bundle in memory and, with `--mongodb-uri`, against
/// MongoDB. A case in filter form runs only against MongoDB, over the app documents its filter matches.
pub(crate) fn run(call: &Invocation, project: &Project) -> Result<ExitCode, String> {
    let cases = &project.bundle.tests;
    if cases.is_empty() {
        return Err("No policy tests found (files named *.test.ts calling describePolicies)".to_owned());
    }
    let set = project.bundle.policy_set()?;
    let engine = PolicyEngine::new(set);
    let now = canopy_mongo::mongodb::bson::DateTime::now().timestamp_millis();
    let verdicts = match call.text("mongodb-uri") {
        None => cases
            .iter()
            .map(|case| match &case.subject {
                Subject::Document(document) => {
                    let failures = judge(case, document, &[("memory", memory(&engine, case, document, now))]);
                    if failures.is_empty() { Verdict::Passed } else { Verdict::Failed(failures) }
                }
                Subject::Filter(_) => Verdict::NotRun,
            })
            .collect::<Vec<_>>(),
        Some(uri) => {
            let (_, app) = crate::meta::app_target(call, project, "policies test").unwrap_or_default();
            let scratch = format!(
                "canopy_policy_test_{}_{}",
                now,
                canopy_mongo::mongodb::bson::oid::ObjectId::new().to_hex()
            );
            let engine = &engine;
            crate::meta::with_client(uri, |client| async move {
                let db = client.database(&scratch);
                let result = against_mongodb(engine, &client, &db, &app, cases, now).await;
                let _ = db.drop().await;
                result
            })?
        }
    };
    let backends = if call.text("mongodb-uri").is_some() { "memory and mongodb" } else { "memory" };
    let mut failed = 0;
    let mut not_run = 0;
    for (case, verdict) in cases.iter().zip(&verdicts) {
        let label = label(case);
        match verdict {
            Verdict::Passed => output(format_args!("pass  {label}"))?,
            Verdict::NotRun => {
                not_run += 1;
                output(format_args!(
                    "skip  {label}: a filter case runs only against MongoDB (pass --mongodb-uri)"
                ))?;
            }
            Verdict::Failed(failures) => {
                failed += 1;
                for failure in failures {
                    crate::error_line(format_args!("FAIL  {label}: {failure}"))?;
                }
            }
        }
    }
    coverage(&engine, cases, now)?;
    let skipped = if not_run > 0 { format!(", {not_run} not run") } else { String::new() };
    output(format_args!("{} cases on {backends}, {failed} failed{skipped}", cases.len() - not_run))?;
    Ok(if failed > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

async fn against_mongodb(
    engine: &PolicyEngine,
    client: &Client,
    db: &Database,
    app: &str,
    cases: &[TestCase],
    now: i64,
) -> Result<Vec<Verdict>, String> {
    let mut counter = 0;
    let mut verdicts = Vec::new();
    for case in cases {
        match &case.subject {
            Subject::Document(document) => {
                counter += 1;
                let outcomes = [
                    ("memory", memory(engine, case, document, now)),
                    ("mongodb", mongodb(engine, db, counter, case, document, now).await),
                ];
                let failures = judge(case, document, &outcomes);
                verdicts.push(if failures.is_empty() { Verdict::Passed } else { Verdict::Failed(failures) });
            }
            Subject::Filter(filter) => {
                if app.is_empty() {
                    verdicts.push(Verdict::Failed(vec![
                        "a filter case needs the app database: pass --database or set CANOPY_DB".to_owned(),
                    ]));
                    continue;
                }
                let found: Vec<BsonDocument> = client
                    .database(app)
                    .collection::<BsonDocument>(&case.collection)
                    .find(bson(filter)?)
                    .limit(FILTER_LIMIT + 1)
                    .await
                    .map_err(|error| error.to_string())?
                    .try_collect()
                    .await
                    .map_err(|error| error.to_string())?;
                if found.is_empty() {
                    verdicts.push(Verdict::Failed(vec!["the filter matched no documents".to_owned()]));
                    continue;
                }
                if i64::try_from(found.len()).unwrap_or(i64::MAX) > FILTER_LIMIT {
                    verdicts.push(Verdict::Failed(vec![format!(
                        "the filter matched more than {FILTER_LIMIT} documents; narrow it"
                    )]));
                    continue;
                }
                let mut disagreeing = Vec::new();
                let mut details = Vec::new();
                for document in &found {
                    let document = to_canopy(document).map_err(|error| error.message().to_owned())?;
                    counter += 1;
                    let outcomes = [
                        ("memory", memory(engine, case, &document, now)),
                        ("mongodb", mongodb(engine, db, counter, case, &document, now).await),
                    ];
                    let failures = judge(case, &document, &outcomes);
                    if !failures.is_empty() {
                        disagreeing.push(json(document.get("_id").unwrap_or(&Value::Null)));
                        details.extend(failures);
                    }
                }
                if disagreeing.is_empty() {
                    verdicts.push(Verdict::Passed);
                } else {
                    let mut failures = vec![format!(
                        "{} of {} matched documents disagree: {}",
                        disagreeing.len(),
                        found.len(),
                        disagreeing.join(", ")
                    )];
                    failures.extend(details);
                    verdicts.push(Verdict::Failed(failures));
                }
            }
        }
    }
    Ok(verdicts)
}

/// Reports which policies the concrete cases exercised, per collection in the order they first appear.
fn coverage(engine: &PolicyEngine, cases: &[TestCase], now: i64) -> Result<(), String> {
    let mut collections: Vec<(String, Vec<String>)> = Vec::new();
    for case in cases {
        let Some(definition) = engine.collection(&case.collection) else { continue };
        let index = match collections.iter().position(|(name, _)| *name == definition.collection) {
            Some(index) => index,
            None => {
                collections.push((definition.collection.clone(), Vec::new()));
                collections.len() - 1
            }
        };
        let Subject::Document(document) = &case.subject else { continue };
        let explanation = engine
            .explain(&definition.collection, case.action, &context(case, now), Clause::Using)
            .map_err(|error| error.message().to_owned())?;
        for policy in explanation.policies {
            let Some(resolved) = policy.resolved.filter(|_| policy.applies) else { continue };
            let matched = compile_filter(&Value::Document(resolved))
                .and_then(|filter| filter.matches(document))
                .unwrap_or(false);
            if let (true, Some((_, exercised))) = (matched, collections.get_mut(index))
                && !exercised.contains(&policy.name)
            {
                exercised.push(policy.name);
            }
        }
    }
    for (name, exercised) in collections {
        let Some(definition) = engine.collection(&name) else { continue };
        let unexercised: Vec<&str> = definition
            .policies
            .iter()
            .map(|policy| policy.name.as_str())
            .filter(|policy| !exercised.iter().any(|known| known == policy))
            .collect();
        output(format_args!(
            "coverage  {name}: {}/{} policies exercised",
            exercised.len(),
            exercised.len() + unexercised.len()
        ))?;
        if !unexercised.is_empty() {
            output(format_args!("          not exercised: {}", unexercised.join(", ")))?;
        }
    }
    Ok(())
}
