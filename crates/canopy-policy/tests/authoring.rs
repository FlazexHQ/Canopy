//! Replays the canonical policy authoring and publishing fixtures.

#![allow(clippy::unwrap_used)]

use canopy_policy::{StoredMeta, parse_policy_set, to_stored};
use canopy_protocol::Value;
use canopy_protocol::ejson::to_canonical;
use canopy_protocol::json::{Json, parse_json, write_json};

#[test]
fn typescript_authoring_sets_produce_the_same_stored_documents_and_hashes() {
    let input = parse_json(include_str!("../../../conformance/authoring/policy/vectors.json")).unwrap();
    let oracle = parse_json(include_str!("../../../conformance/authoring/policy/publishing.json")).unwrap();
    let (Some(Json::Array(sets)), Json::Array(expected)) = (input.get("sets"), oracle) else {
        unreachable!()
    };
    assert!(!sets.is_empty());
    assert_eq!(sets.len(), expected.len());
    let meta = StoredMeta {
        version: 7,
        updated_at: Some(1_767_225_600_000),
        updated_by: Some("fixture".to_owned()),
    };
    for (vector, expected) in sets.iter().zip(&expected) {
        let name = vector.get("name");
        assert_eq!(name, expected.get("name"));
        let mut text = String::new();
        write_json(&mut text, vector.get("document").unwrap());
        let set = parse_policy_set(&text).unwrap();
        assert_eq!(Some(&Json::String(set.version().to_owned())), expected.get("bundleHash"), "{name:?}");
        let stored = set
            .collections()
            .iter()
            .map(|definition| {
                to_canonical(&Value::Document(to_stored(definition, &meta).unwrap().to_document())).unwrap()
            })
            .collect();
        assert_eq!(Some(&Json::Array(stored)), expected.get("stored"), "{name:?}");
    }
}

#[test]
fn canonical_schema_refuses_invalid_shapes_before_compilation() {
    let valid = r#"{"version":1,"collections":[{"collection":"notes","exposed":true,"realtime":false,"policies":[{"name":"read","kind":"permissive","ops":["read"],"roles":["anon"],"using":{"owner":{"$auth":"sub"}}}]}],"contexts":{}}"#;
    assert!(parse_policy_set(valid).is_ok());
    for (from, to) in [
        ("\"version\":1", "\"version\":2"),
        ("\"exposed\":true,", ""),
        ("\"exposed\":true", "\"exposed\":null"),
        ("\"ops\":[\"read\"]", "\"ops\":[\"read\",\"read\"]"),
        ("\"roles\":[\"anon\"]", "\"roles\":[\"service\"]"),
        ("\"using\":{\"owner\":{\"$auth\":\"sub\"}}", "\"using\":null"),
        ("\"$auth\":\"sub\"", "\"$auth\":\"sub\",\"as\":null"),
        ("\"$auth\":\"sub\"", "\"$auth\":\"sub..id\""),
        ("\"$auth\":\"sub\"", "\"$auth\":\"sub\",\"extra\":true"),
        (
            "\"realtime\":false",
            "\"realtime\":false,\"fields\":{\"read\":{\"default\":{\"omit\":[],\"only\":[]}}}",
        ),
        (
            "\"contexts\":{}",
            "\"contexts\":{\"ids\":{\"from\":\"members\",\"where\":{\"subject\":{\"$auth\":\"sub\"}},\"select\":\"id\",\"max\":0,\"ttl\":\"30s\"}}",
        ),
    ] {
        let invalid = valid.replace(from, to);
        assert_ne!(invalid, valid);
        assert!(parse_policy_set(&invalid).is_err(), "{invalid}");
    }
}

fn value(document: &canopy_protocol::Document, key: &str) -> Value {
    document.get(key).unwrap().clone()
}

fn array<'a>(document: &'a canopy_protocol::Document, key: &str) -> &'a [Value] {
    document.get(key).unwrap().as_array().unwrap()
}

fn text<'a>(document: &'a canopy_protocol::Document, key: &str) -> &'a str {
    document.get(key).unwrap().as_str().unwrap()
}

fn strings(values: &[Value]) -> Vec<String> {
    values.iter().map(|value| value.as_str().unwrap().to_owned()).collect()
}

#[test]
fn typescript_authoring_diagnostics_and_simulations_match() {
    use canopy_policy::{
        ExplainRequest, LintEnvironment, LintFinding, Operation, PolicyEngine, RequestContext,
        SimulationCase, access_report_document, contexts_from_stored, evaluate_in_memory, explain_access,
        explain_context, from_stored, lint_policies,
    };
    use canopy_protocol::ejson::{DecodeOptions, parse, stringify};

    let vectors = parse_json(include_str!("../../../conformance/authoring/policy/vectors.json")).unwrap();
    let Some(Json::Array(sets)) = vectors.get("sets") else { unreachable!() };
    let diagnostics = parse(
        include_str!("../../../conformance/authoring/policy/diagnostics.json"),
        DecodeOptions::default(),
    )
    .unwrap();
    let diagnostics = diagnostics.as_document().unwrap();
    let now = 1_767_225_600_000;
    let lint_values =
        |findings: &[LintFinding]| Value::Array(findings.iter().map(LintFinding::to_value).collect());
    assert_eq!(sets.len(), array(diagnostics, "sets").len());
    let mut engines = std::collections::HashMap::new();
    for (set, oracle) in sets.iter().zip(array(diagnostics, "sets")) {
        let oracle = oracle.as_document().unwrap();
        let name = text(oracle, "name");
        assert_eq!(set.get("name"), Some(&Json::String(name.to_owned())));
        let mut canonical = String::new();
        write_json(&mut canonical, set.get("document").unwrap());
        let set = parse_policy_set(&canonical).unwrap();
        assert_eq!(
            lint_values(&lint_policies(set.collections(), set.contexts(), &LintEnvironment::default())),
            value(oracle, "findings"),
            "{name}"
        );
        let engine = PolicyEngine::new(set);
        let reports = array(oracle, "reports");
        assert_eq!(reports.len(), engine.set().collections().len() * Operation::ALL.len());
        for expected in reports {
            let report = expected.as_document().unwrap();
            let mut claims = canopy_protocol::Document::new();
            claims.insert("sub", Value::String("alice".to_owned()));
            let request = ExplainRequest {
                collection: text(report, "collection").to_owned(),
                op: Operation::parse(text(report, "op")).unwrap(),
                context: explain_context(Some(claims), &[], None, now),
                filter: None,
            };
            let actual = access_report_document(&explain_access(&engine, &request).unwrap()).unwrap();
            assert_eq!(
                stringify(&Value::Document(actual)).unwrap(),
                stringify(expected).unwrap(),
                "{name}, {}, {}",
                request.collection,
                request.op
            );
        }
        engines.insert(name, engine);
    }

    let lint = diagnostics.get("lint").unwrap().as_document().unwrap();
    let definitions = array(lint, "definitions")
        .iter()
        .map(|definition| {
            let mut stored = definition.as_document().unwrap().clone();
            stored.insert("_id", value(&stored, "collection"));
            let policies = array(&stored, "policies")
                .iter()
                .map(|policy| {
                    let mut policy = policy.as_document().unwrap().clone();
                    if let Some(using) = policy.get("using") {
                        policy.insert("using", Value::String(stringify(using).unwrap()));
                    }
                    Value::Document(policy)
                })
                .collect();
            stored.insert("policies", Value::Array(policies));
            from_stored(&Value::Document(stored)).unwrap()
        })
        .collect::<Vec<_>>();
    let contexts = contexts_from_stored(lint.get("contexts")).unwrap();
    let env = lint.get("env").unwrap().as_document().unwrap();
    let fields = env.get("fields").unwrap().as_document().unwrap();
    let indexes = env.get("indexes").unwrap().as_document().unwrap();
    let env = LintEnvironment {
        known_roles: Some(&strings(array(env, "knownRoles"))),
        fields: &[("notes".to_owned(), strings(array(fields, "notes")))],
        indexes: &[(
            "notes".to_owned(),
            array(indexes, "notes").iter().map(|index| strings(index.as_array().unwrap())).collect(),
        )],
    };
    assert_eq!(lint_values(&lint_policies(&definitions, &contexts, &env)), value(lint, "findings"));

    for suite in array(diagnostics, "simulations") {
        let suite = suite.as_document().unwrap();
        let engine = engines.get(text(suite, "policy")).unwrap();
        for case in array(suite, "cases") {
            let case = case.as_document().unwrap();
            let input = case.get("input").unwrap().as_document().unwrap();
            let actor = input.get("actor").unwrap().as_document().unwrap();
            let context = RequestContext {
                roles: array(actor, "roles").iter().map(|role| role.as_str().unwrap()).collect(),
                claims: actor.get("claims").and_then(Value::as_document).cloned(),
                ctx: actor.get("ctx").and_then(Value::as_document).cloned(),
                now,
            };
            let observed = evaluate_in_memory(
                engine,
                &SimulationCase {
                    collection: text(input, "collection"),
                    op: Operation::parse(text(input, "action")).unwrap(),
                    context: &context,
                    document: input.get("doc").unwrap().as_document().unwrap(),
                    update: input.get("update"),
                },
            )
            .unwrap();
            let expected = case.get("outcome").unwrap().as_document().unwrap();
            assert_eq!(Value::Bool(observed.allowed), value(expected, "allowed"));
            assert_eq!(observed.reason, text(expected, "reason"));
            assert_eq!(observed.document.as_ref(), expected.get("document").and_then(Value::as_document));
        }
    }
}
