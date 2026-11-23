//! Replays the vectors recorded from the TypeScript `@canopy/policy` package
//! (`packages/testing/scripts/policy-vectors.ts`). For generated policy sets and callers both compilers must
//! give byte identical MongoDB filters (canonical EJSON), the same matcher decisions on generated documents,
//! the same explain output, field rules and hashes, and the same refusals with the same message and code.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use canopy_policy::{
    Compiled, EngineHooks, ExplainRequest, Explanation, FieldAccess, FieldRule, FieldRules, Operation,
    PolicyEngine, PolicyVariableIssue, RequestContext, Resolution, Roles, and, can_access, check_implied,
    claim_paths, context_names, context_query, contexts_from_stored, create_policy_set, denied_paths,
    denies_text_search, document_paths, equality_fields, explain_access, field_access, format_access_report,
    from_stored, immutable_violations, intersect_projection, lookup_values, project_readable, read_stored,
    resolve_clause, shift_date, to_projection, uses_now,
};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Document, Value};
use canopy_query::js_property_order;

fn text(json: &Json) -> &str {
    match json {
        Json::String(text) => text,
        _ => panic!("expected a string, got {json:?}"),
    }
}

fn value(source: &str) -> Value {
    js_property_order(&parse(source, DecodeOptions::default()).expect("EJSON"))
}

fn document(source: &str) -> Document {
    match value(source) {
        Value::Document(document) => document,
        other => panic!("expected a document, got {other:?}"),
    }
}

fn string(text: impl Into<String>) -> Json {
    Json::String(text.into())
}

fn strings(items: &[String]) -> Json {
    Json::Array(items.iter().cloned().map(Json::String).collect())
}

fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn canonical(document: &Document) -> String {
    canonical_string(&Value::Document(document.clone())).expect("canonical EJSON")
}

fn error(failure: &CanopyError) -> Vec<(&'static str, Json)> {
    let code = if failure.name() == "TypeError" { Json::Null } else { string(failure.code().as_str()) };
    vec![("error", string(failure.message())), ("name", string(failure.name())), ("code", code)]
}

fn answer(result: Result<Json, CanopyError>) -> Vec<(&'static str, Json)> {
    match result {
        Ok(result) => vec![("result", result)],
        Err(failure) => error(&failure),
    }
}

fn compiled(result: &Compiled) -> Json {
    match result {
        Compiled::Filter(filter) => string(canonical(filter)),
        other => string(other.kind()),
    }
}

fn access(result: &FieldAccess) -> Json {
    match result {
        FieldAccess::All => string("all"),
        FieldAccess::Only(paths) => object(vec![("only", strings(paths))]),
        FieldAccess::Omit(paths) => object(vec![("omit", strings(paths))]),
    }
}

fn decisions(result: &Compiled, docs: &[Document]) -> Json {
    let matcher = match result.matcher() {
        Ok(matcher) => matcher,
        Err(failure) => return Json::Array(vec![string(format!("compile:{}", failure.message()))]),
    };
    Json::Array(
        docs.iter()
            .map(|doc| match matcher.matches(doc) {
                Ok(flag) => Json::Bool(flag),
                Err(failure) => string(format!("error:{}", failure.message())),
            })
            .collect(),
    )
}

fn explanation(value: &Explanation) -> Json {
    let policies = value
        .policies
        .iter()
        .map(|policy| {
            Json::Array(vec![
                string(policy.name.clone()),
                string(policy.kind.as_str()),
                Json::Bool(policy.applies),
                string(policy.reason.clone()),
                policy.resolved.as_ref().map_or(Json::Null, |resolved| string(canonical(resolved))),
                policy
                    .issue
                    .as_ref()
                    .map_or(Json::Null, |issue| string(format!("{}:{}", issue.kind, issue.variable))),
            ])
        })
        .collect();
    object(vec![
        ("roles", strings(&value.roles)),
        ("bypass", Json::Bool(value.bypass)),
        ("exposed", Json::Bool(value.exposed)),
        ("result", compiled(&value.result)),
        ("policies", Json::Array(policies)),
    ])
}

fn caller(source: &str) -> RequestContext {
    let caller = document(source);
    let roles: Roles = caller
        .get("roles")
        .and_then(Value::as_array)
        .expect("roles")
        .iter()
        .map(|role| role.as_str().expect("role").to_owned())
        .collect();
    let claims = caller.get("claims").and_then(Value::as_document).cloned();
    let ctx = caller.get("ctx").and_then(Value::as_document).cloned();
    let Some(Value::DateTime(now)) = caller.get("now") else { panic!("now") };
    RequestContext { roles, claims, ctx, now: *now }
}

#[derive(Default)]
struct Recorded {
    issues: Mutex<Vec<String>>,
    errors: Mutex<Vec<String>>,
}

struct Hooks(Arc<Recorded>);

impl EngineHooks for Hooks {
    fn on_variable_issue(&self, issue: &PolicyVariableIssue) {
        self.0
            .issues
            .lock()
            .unwrap()
            .push(format!("{}/{}/{}:{}", issue.collection, issue.policy, issue.kind, issue.variable));
    }

    fn on_evaluation_error(&self, failure: &CanopyError, _collection: &str, _op: Operation) {
        self.0.errors.lock().unwrap().push(failure.message().to_owned());
    }
}

fn texts(json: &Json) -> Vec<&str> {
    match json {
        Json::Array(items) => items.iter().map(text).collect(),
        _ => panic!("expected an array"),
    }
}

fn op_result(
    engine: &PolicyEngine,
    recorded: &Recorded,
    collection: &str,
    op: Operation,
    ctx: &RequestContext,
    user_filter: &Document,
    docs: &[Document],
) -> Json {
    recorded.issues.lock().unwrap().clear();
    recorded.errors.lock().unwrap().clear();
    let using = engine.using(collection, op, ctx);
    let writes = matches!(op, Operation::Insert | Operation::Update);
    let check = writes.then(|| engine.check(collection, op, ctx));
    let target = matches!(op, Operation::Update | Operation::Delete)
        .then(|| object(answer(engine.target(collection, op, ctx).map(|result| compiled(&result)))));
    let effective = (op == Operation::Read).then(|| {
        object(answer(engine.effective_read(collection, user_filter, ctx).map(|result| compiled(&result))))
    });
    let request = ExplainRequest {
        collection: collection.to_owned(),
        op,
        context: ctx.clone(),
        filter: (op == Operation::Read).then(|| user_filter.clone()),
    };
    let report = object(answer(explain_access(engine, &request).and_then(|report| {
        Ok(object(vec![
            ("text", string(format_access_report(&report)?)),
            ("using", explanation(&report.using)),
            ("check", report.check.as_ref().map_or(Json::Null, explanation)),
            ("effective", compiled(&report.effective)),
            ("writable", report.writable.as_ref().map_or(Json::Null, access)),
        ]))
    })));
    let mut fields = vec![
        ("op", string(op.as_str())),
        ("grant", Json::Bool(engine.has_grant(collection, op, ctx))),
        ("using", compiled(&using)),
        ("usingMatches", decisions(&using, docs)),
    ];
    if let Some(check) = &check {
        fields.push(("check", compiled(check)));
        fields.push(("checkMatches", decisions(check, docs)));
    }
    if let Some(target) = target {
        fields.push(("target", target));
    }
    if let Some(effective) = effective {
        fields.push(("effective", effective));
    }
    fields
        .push(("writable", if writes { access(&engine.writable(collection, op, ctx)) } else { Json::Null }));
    fields.push(("issues", strings(&recorded.issues.lock().unwrap())));
    fields.push(("errors", strings(&recorded.errors.lock().unwrap())));
    fields.push(("report", report));
    object(fields)
}

fn run_set(case: &Json) -> Json {
    let collections = texts(case.get("collections").expect("collections"));
    let contexts = value(text(case.get("contexts").expect("contexts")));
    let built = (|| {
        let definitions =
            collections.iter().map(|source| from_stored(&value(source))).collect::<Result<Vec<_>, _>>()?;
        let lookups = contexts_from_stored(Some(&contexts))?;
        let set = create_policy_set(definitions.clone(), lookups)?;
        Ok::<_, CanopyError>((definitions, set))
    })();
    let (definitions, set) = match built {
        Ok(built) => built,
        Err(failure) => return object(error(&failure)),
    };
    let docs: Vec<Document> = texts(case.get("docs").expect("docs")).into_iter().map(document).collect();
    let user_filter = document(text(case.get("filter").expect("filter")));
    let requests = texts(case.get("requests").expect("requests"));
    let recorded = Arc::new(Recorded::default());
    let engine = PolicyEngine::with_hooks(set, Box::new(Hooks(Arc::clone(&recorded))));
    let mut names: Vec<String> = Vec::new();
    for name in definitions.iter().map(|def| def.collection.clone()).chain(["missing".to_owned()]) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let results = requests
        .into_iter()
        .map(|source| {
            let ctx = caller(source);
            let per_collection = names
                .iter()
                .map(|collection| {
                    let ops = Operation::ALL
                        .into_iter()
                        .map(|op| op_result(&engine, &recorded, collection, op, &ctx, &user_filter, &docs))
                        .collect();
                    let readable = engine.readable(collection, &ctx);
                    let projected = docs
                        .iter()
                        .map(|doc| match project_readable(&readable, doc) {
                            Ok(projected) => string(canonical(&projected)),
                            Err(failure) => string(format!("error:{}", failure.message())),
                        })
                        .collect();
                    object(vec![
                        ("collection", string(collection.clone())),
                        ("exposed", Json::Bool(engine.is_exposed(collection))),
                        ("realtime", Json::Bool(engine.is_realtime(collection))),
                        ("readable", access(&readable)),
                        ("projected", Json::Array(projected)),
                        ("immutable", strings(engine.immutable(collection))),
                        (
                            "contextNames",
                            strings(&engine.context_names(Some(&[collection.as_str()]), &ctx.roles)),
                        ),
                        ("ops", Json::Array(ops)),
                    ])
                })
                .collect();
            object(vec![
                ("contextNames", strings(&engine.context_names(None, &ctx.roles))),
                ("collections", Json::Array(per_collection)),
            ])
        })
        .collect();
    let hashes = engine
        .set()
        .hashes()
        .iter()
        .map(|(name, hash)| Json::Array(vec![string(name.clone()), string(hash.clone())]))
        .collect();
    object(vec![(
        "result",
        object(vec![
            ("version", string(engine.version())),
            ("hashes", Json::Array(hashes)),
            (
                "authoring",
                Json::Array(definitions.iter().map(|def| string(canonical(&def.to_document()))).collect()),
            ),
            ("results", Json::Array(results)),
        ]),
    )])
}

fn run_stored(case: &Json) -> Json {
    let input = value(text(case.get("input").expect("input")));
    object(vec![
        ("fromStored", object(answer(from_stored(&input).map(|def| string(canonical(&def.to_document())))))),
        (
            "readStored",
            object(answer(read_stored(&input).map(|stored| string(canonical(&stored.to_document()))))),
        ),
    ])
}

fn run_lookup(case: &Json) -> Json {
    let input = value(text(case.get("input").expect("input")));
    let ctx = caller(text(case.get("request").expect("request")));
    let docs: Vec<Document> = match value(text(case.get("docs").expect("docs"))) {
        Value::Array(items) => {
            items.into_iter().map(|item| item.as_document().cloned().expect("doc")).collect()
        }
        _ => panic!("docs"),
    };
    object(answer((|| {
        let lookups = contexts_from_stored(Some(&input))?;
        create_policy_set(Vec::new(), lookups.clone())?;
        let mut out = Vec::new();
        for (name, lookup) in &lookups {
            let (key, value) = match context_query(name, lookup, &ctx)? {
                None => (Json::Null, Json::Null),
                Some(query) => {
                    let value = lookup_values(&docs, &lookup.select, lookup.max)?
                        .map(|values| canonical_string(&Value::Array(values)))
                        .transpose()?
                        .map_or(Json::Null, string);
                    (string(query.key), value)
                }
            };
            out.push(Json::Array(vec![string(name.clone()), key, value]));
        }
        Ok(Json::Array(out))
    })()))
}

fn run_resolve(case: &Json) -> Json {
    let input = value(text(case.get("input").expect("input")));
    let clause = input.as_document().cloned().expect("clause");
    let ctx = caller(text(case.get("request").expect("request")));
    let mut fields = answer(resolve_clause(&clause, &ctx).map(|resolution| match resolution {
        Resolution::Resolved(filter) => string(canonical(&filter)),
        Resolution::Unresolvable(issue) => string(format!("{}:{}", issue.kind, issue.variable)),
    }));
    fields.push(("usesNow", Json::Bool(uses_now(&input))));
    fields.push(("claimPaths", strings(&claim_paths(&input))));
    fields.push(("contextNames", strings(&context_names(&input))));
    fields.push(("equalityFields", strings(&equality_fields(&input))));
    object(fields)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn run_shift(case: &Json) -> Json {
    let Some(Json::Number(now)) = case.get("now") else { panic!("now") };
    let offset = text(case.get("offset").expect("offset"));
    object(answer(
        shift_date(*now as i64, offset)
            .map(|shifted| shifted.map_or(Json::Null, |ms| Json::Number(ms as f64))),
    ))
}

fn field_rules(source: &str) -> FieldRules {
    document(source)
        .iter()
        .map(|(role, rule)| {
            let rule = rule.as_document().expect("rule");
            let paths = |key: &str| -> Option<Vec<String>> {
                rule.get(key)
                    .and_then(Value::as_array)
                    .map(|items| items.iter().map(|item| item.as_str().expect("path").to_owned()).collect())
            };
            let rule = match (paths("only"), paths("omit")) {
                (Some(only), None) => FieldRule::Only(only),
                (None, Some(omit)) => FieldRule::Omit(omit),
                _ => panic!("rule"),
            };
            (role.to_owned(), rule)
        })
        .collect()
}

fn run_fields(case: &Json) -> Json {
    let rules = field_rules(text(case.get("rules").expect("rules")));
    let roles: Roles = texts(case.get("roles").expect("roles")).into_iter().collect();
    let paths: Vec<String> =
        texts(case.get("paths").expect("paths")).into_iter().map(str::to_owned).collect();
    let docs: Vec<Document> = texts(case.get("docs").expect("docs")).into_iter().map(document).collect();
    let projection = match case.get("projection") {
        Some(Json::String(source)) => Some(document(source)),
        _ => None,
    };
    let result = field_access(Some(&rules), &roles);
    let immutable = ["a.b".to_owned(), "c".to_owned(), "b.0.c".to_owned()];
    let mut text_filter = Document::new();
    text_filter.insert("$text", Value::Document(Document::new()));
    object(vec![
        ("access", access(&result)),
        ("canAccess", Json::Array(paths.iter().map(|path| Json::Bool(can_access(&result, path))).collect())),
        ("denied", strings(&denied_paths(&result, &paths))),
        ("immutable", strings(&immutable_violations(&paths, &immutable))),
        (
            "toProjection",
            to_projection(&result).map_or(Json::Null, |projection| string(canonical(&projection))),
        ),
        (
            "intersect",
            intersect_projection(projection.as_ref(), &result)
                .map_or(Json::Null, |projection| string(canonical(&projection))),
        ),
        (
            "projected",
            Json::Array(
                docs.iter()
                    .map(|doc| match project_readable(&result, doc) {
                        Ok(projected) => string(canonical(&projected)),
                        Err(failure) => string(format!("error:{}", failure.message())),
                    })
                    .collect(),
            ),
        ),
        ("documentPaths", Json::Array(docs.iter().map(|doc| strings(&document_paths(doc))).collect())),
        ("deniesText", Json::Bool(denies_text_search(&result, &text_filter))),
    ])
}

fn compiled_from(source: &str) -> Compiled {
    match source {
        "all" => Compiled::All,
        "deny" => Compiled::Deny,
        filter => Compiled::Filter(document(filter)),
    }
}

fn run_compose(case: &Json) -> Json {
    let parts: Vec<Compiled> =
        texts(case.get("parts").expect("parts")).into_iter().map(compiled_from).collect();
    let check = compiled_from(text(case.get("check").expect("check")));
    let target = compiled_from(text(case.get("target").expect("target")));
    let written: Vec<String> =
        texts(case.get("written").expect("written")).into_iter().map(str::to_owned).collect();
    object(vec![
        ("and", object(answer(and(&parts).map(|result| compiled(&result))))),
        ("implied", object(answer(check_implied(&check, &target, &written).map(Json::Bool)))),
    ])
}

/// The first place where two JSON values differ, ignoring the order of object keys.
fn difference(path: &str, expected: &Json, actual: &Json) -> Option<String> {
    match (expected, actual) {
        (Json::Number(x), Json::Number(y)) if x == y => None,
        (Json::Array(x), Json::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: {} items expected, {} found", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(index, (x, y))| difference(&format!("{path}[{index}]"), x, y))
        }
        (Json::Object(x), Json::Object(y)) => {
            for (key, inner) in x {
                match y.iter().find(|(other, _)| other == key) {
                    Some((_, other)) => {
                        if let Some(found) = difference(&format!("{path}.{key}"), inner, other) {
                            return Some(found);
                        }
                    }
                    None => return Some(format!("{path}.{key}: missing in Rust")),
                }
            }
            y.iter()
                .find(|(key, _)| !x.iter().any(|(other, _)| other == key))
                .map(|(key, _)| format!("{path}.{key}: only in Rust"))
        }
        _ if expected == actual => None,
        _ => Some(format!("{path}:\n    TypeScript {expected:?}\n    Rust       {actual:?}")),
    }
}

fn expected(case: &Json, keys: &[&str]) -> Json {
    Json::Object(
        keys.iter().filter_map(|key| case.get(key).map(|value| ((*key).to_owned(), value.clone()))).collect(),
    )
}

#[test]
fn the_compiler_agrees_with_typescript() {
    let vectors = parse_json(include_str!("../../../conformance/policy/policy.json")).expect("vector file");
    let Some(Json::Array(cases)) = vectors.get("cases") else { panic!("cases") };
    let mut mismatches = Vec::new();
    let mut compiled_sets = 0;
    for (index, case) in cases.iter().enumerate() {
        let kind = text(case.get("kind").expect("kind"));
        let (wanted, actual) = match kind {
            "set" => {
                let actual = run_set(case);
                if actual.get("result").is_some() {
                    compiled_sets += 1;
                }
                (expected(case, &["result", "error", "name", "code"]), actual)
            }
            "stored" => (expected(case, &["fromStored", "readStored"]), run_stored(case)),
            "lookup" => (expected(case, &["result", "error", "name", "code"]), run_lookup(case)),
            "resolve" => (
                expected(
                    case,
                    &[
                        "result",
                        "error",
                        "name",
                        "code",
                        "usesNow",
                        "claimPaths",
                        "contextNames",
                        "equalityFields",
                    ],
                ),
                run_resolve(case),
            ),
            "shift" => (expected(case, &["result", "error", "name", "code"]), run_shift(case)),
            "fields" => (
                expected(
                    case,
                    &[
                        "access",
                        "canAccess",
                        "denied",
                        "immutable",
                        "toProjection",
                        "intersect",
                        "projected",
                        "documentPaths",
                        "deniesText",
                    ],
                ),
                run_fields(case),
            ),
            "compose" => (expected(case, &["and", "implied"]), run_compose(case)),
            other => panic!("unknown kind {other}"),
        };
        if let Some(found) = difference("", &wanted, &actual) {
            let label = case.get("label").map_or_else(String::new, |name| format!(" ({})", text(name)));
            mismatches.push(format!("case {index} {kind}{label} {found}"));
        }
    }
    let source = vectors.get("source").map(text).unwrap_or_default();
    assert!(
        mismatches.is_empty(),
        "{} mismatches of {} against {source}:\n{}",
        mismatches.len(),
        cases.len(),
        mismatches.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(compiled_sets > 150, "too few policy sets compiled: {compiled_sets}");
}
