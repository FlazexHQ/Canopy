//! Replays the R0 authoring vectors: every recorded canonical document validates, and the invalid inputs
//! the Rust validators see fail with the recorded code and path.

use canopy_authoring::{
    AuthoringCode, AuthoringError, validate_bundle, validate_collection_schema, validate_config,
    validate_policy_set, validate_policy_set_json, validate_policy_test_json,
};
use canopy_protocol::json::{Json, parse_json, write_json};

fn vectors(name: &str) -> Json {
    let path = format!("{}/../../conformance/authoring/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| unreachable!("{path}: {error}"));
    parse_json(&text).unwrap_or_else(|error| unreachable!("{path}: {}", error.message()))
}

fn items<'a>(value: &'a Json, key: &str) -> &'a [Json] {
    match value.get(key) {
        Some(Json::Array(items)) => items,
        _ => unreachable!("expected an array at {key}"),
    }
}

fn string<'a>(value: &'a Json, key: &str) -> &'a str {
    match value.get(key) {
        Some(Json::String(text)) => text,
        _ => unreachable!("expected a string at {key}"),
    }
}

fn text(value: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn named<'a>(list: &'a [Json], name: &str) -> &'a Json {
    list.iter()
        .find(|item| string(item, "name") == name)
        .unwrap_or_else(|| unreachable!("no vector named {name}"))
}

fn refusal(result: Result<(), AuthoringError>) -> AuthoringError {
    match result {
        Ok(()) => unreachable!("expected a refusal"),
        Err(error) => error,
    }
}

#[test]
fn every_recorded_policy_set_validates_and_hashes_as_published() {
    let policy = vectors("policy/vectors.json");
    let publishing = vectors("policy/publishing.json");
    let Json::Array(published) = &publishing else { unreachable!() };
    for set in items(&policy, "sets") {
        let name = string(set, "name");
        let document = set.get("document").unwrap_or_else(|| unreachable!());
        let compiled =
            validate_policy_set_json(document).unwrap_or_else(|error| unreachable!("{name}: {error}"));
        let expected = string(named(published, name), "bundleHash");
        assert_eq!(compiled.version(), expected, "{name}");
    }
}

#[test]
fn every_recorded_policy_test_case_validates() {
    let policy = vectors("policy/vectors.json");
    let mut count = 0;
    for suite in items(&policy, "suites") {
        for document in items(suite, "documents") {
            validate_policy_test_json(document)
                .unwrap_or_else(|error| unreachable!("{}: {error}", string(suite, "name")));
            count += 1;
        }
    }
    for case in items(&policy, "filterTests") {
        validate_policy_test_json(case.get("document").unwrap_or_else(|| unreachable!()))
            .unwrap_or_else(|error| unreachable!("{error}"));
        count += 1;
    }
    assert_eq!(count, 16);
}

fn policy_refusal(name: &str, document: &str) {
    let policy = vectors("policy/vectors.json");
    let vector = named(items(&policy, "invalid"), name);
    let error = vector.get("error").unwrap_or_else(|| unreachable!());
    let refused = if string(vector, "kind") == "set" {
        refusal(validate_policy_set(document).map(|_| ()))
    } else {
        refusal(canopy_authoring::validate_policy_test(document))
    };
    assert_eq!(refused.code().as_str(), string(error, "code"), "{name}: {refused}");
    assert_eq!(refused.path(), string(error, "path"), "{name}: {refused}");
}

#[test]
fn invalid_policy_documents_fail_at_the_recorded_paths() {
    policy_refusal(
        "service policy",
        r#"{"version":1,"collections":[{"collection":"notes","exposed":false,"realtime":false,"policies":[{"name":"permissive read #1","kind":"permissive","ops":["read"],"roles":["service"]}]}],"contexts":{}}"#,
    );
    policy_refusal(
        "ambiguous field rule",
        r#"{"version":1,"collections":[{"collection":"notes","exposed":false,"realtime":false,"policies":[],"fields":{"read":{"default":{"only":["text"],"omit":["secret"]}}}}],"contexts":{}}"#,
    );
    policy_refusal(
        "zero context max",
        r#"{"version":1,"collections":[],"contexts":{"projectIds":{"from":"memberships","where":{"subject":{"$auth":"sub"}},"select":"projectId","max":0,"ttl":"1m"}}}"#,
    );
    policy_refusal(
        "invalid claim path",
        r#"{"version":1,"collections":[{"collection":"notes","exposed":false,"realtime":false,"policies":[{"name":"permissive read #1","kind":"permissive","ops":["read"],"roles":["anon"],"using":{"owner":{"$auth":"bad..claim"}}}]}],"contexts":{}}"#,
    );
    policy_refusal(
        "custom assertion descriptor",
        r#"{"version":1,"suite":"notes","collection":"notes","actor":{"label":"anon","roles":["anon"],"claims":null},"action":"read","doc":{"public":true},"expected":true,"assert":"custom"}"#,
    );
}

#[test]
fn compiler_refusals_name_the_failing_clause() {
    let refused = refusal(
        validate_policy_set(
            r#"{"version":1,"collections":[{"collection":"notes","exposed":true,"realtime":false,"policies":[{"name":"open","kind":"permissive","ops":["read"],"roles":["anon"]},{"name":"bad","kind":"permissive","ops":["read"],"roles":["anon"],"using":{"$where":"true"}}]}],"contexts":{}}"#,
        )
        .map(|_| ()),
    );
    assert_eq!(refused.code(), AuthoringCode::InvalidQuery);
    assert_eq!(refused.path(), "/collections/0/policies/1/using");
    let duplicate = refusal(
        validate_policy_set(
            r#"{"version":1,"collections":[{"collection":"notes","exposed":true,"realtime":false,"policies":[]},{"collection":"notes","exposed":true,"realtime":false,"policies":[]}],"contexts":{}}"#,
        )
        .map(|_| ()),
    );
    assert_eq!(duplicate.path(), "/collections/1/collection");
    let unknown_context = refusal(
        validate_policy_set(
            r#"{"version":1,"collections":[{"collection":"notes","exposed":true,"realtime":false,"policies":[{"name":"mine","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":{"project":{"$in":{"$ctx":"missing"}}}}]}],"contexts":{}}"#,
        )
        .map(|_| ()),
    );
    assert_eq!(unknown_context.path(), "/collections/0/policies/0/using");
}

#[test]
fn every_recorded_config_document_validates() {
    let config = vectors("config/vectors.json");
    let Json::Array(fixtures) = &config else { unreachable!() };
    let mut count = 0;
    for fixture in fixtures {
        if let Some(document) = fixture.get("document") {
            validate_config(&text(document))
                .unwrap_or_else(|error| unreachable!("{}: {error}", string(fixture, "name")));
            count += 1;
        }
    }
    assert_eq!(count, 49);
}

#[test]
fn config_refusals_carry_paths() {
    let refused = refusal(validate_config(r#"{"version":1,"config":{"server":{"port":"eighty"}}}"#));
    assert_eq!(refused.code(), AuthoringCode::ConfigInvalid);
    assert!(refused.path().starts_with("/config/server/port"), "{refused}");
    let unknown = refusal(validate_config(r#"{"version":1,"config":{"servers":{}}}"#));
    assert_eq!(unknown.path(), "/config/servers");
    let envelope = refusal(validate_config(
        r#"{"version":1,"config":{"webhooks":{"triggers":{"t":{"collection":"notes","url":"https://hooks.example.test/t","filter":{"$ejson":{"at":{"$date":"tomorrow"}}}}}}}}"#,
    ));
    assert_eq!(envelope.path(), "/config/webhooks/triggers/t/filter/$ejson/at", "{envelope}");
}

#[test]
fn every_recorded_collection_schema_validates() {
    let schema = vectors("schema/vectors.json");
    let mut documents: Vec<&Json> =
        items(&schema, "authored").iter().filter_map(|vector| vector.get("document")).collect();
    let pull = schema.get("pull").unwrap_or_else(|| unreachable!());
    documents.extend(pull.get("document"));
    documents.extend(pull.get("editableDocument"));
    documents.extend(schema.get("typegen").and_then(|typegen| typegen.get("document")));
    assert_eq!(documents.len(), 5);
    for document in documents {
        validate_collection_schema(&text(document)).unwrap_or_else(|error| unreachable!("{error}"));
    }
}

fn schema_refusal(name: &str, document: &str) {
    let schema = vectors("schema/vectors.json");
    let vector = named(items(&schema, "invalid"), name);
    let error = vector.get("error").unwrap_or_else(|| unreachable!());
    let refused = refusal(validate_collection_schema(document));
    assert_eq!(refused.code().as_str(), string(error, "code"), "{name}");
    assert_eq!(refused.path(), string(vector, "path"), "{name}");
    assert_eq!(refused.message(), string(error, "message"), "{name}");
}

#[test]
fn invalid_collection_schemas_fail_with_the_recorded_code_path_and_message() {
    let id = r#""_id":{"shape":{"kind":"scalar","type":"objectId"},"required":true}"#;
    schema_refusal(
        "collection-name",
        &format!(
            r#"{{"version":1,"collections":[{{"name":"system.notes","shape":{{"kind":"object","fields":{{{id}}},"open":true}},"source":"config"}}]}}"#
        ),
    );
    schema_refusal(
        "field-name",
        &format!(
            r#"{{"version":1,"collections":[{{"name":"notes","shape":{{"kind":"object","fields":{{{id},"a.b":{{"shape":{{"kind":"scalar","type":"int"}},"required":true}}}},"open":true}},"source":"config"}}]}}"#
        ),
    );
    schema_refusal(
        "optional-id",
        r#"{"version":1,"collections":[{"name":"notes","shape":{"kind":"object","fields":{"_id":{"shape":{"kind":"scalar","type":"string"},"required":false}},"open":true},"source":"config"}]}"#,
    );
    schema_refusal(
        "empty-enum",
        &format!(
            r#"{{"version":1,"collections":[{{"name":"notes","shape":{{"kind":"object","fields":{{{id},"kind":{{"shape":{{"kind":"scalar","type":"string","values":[]}},"required":true}}}},"open":true}},"source":"config"}}]}}"#
        ),
    );
    schema_refusal(
        "duplicate",
        &format!(
            r#"{{"version":1,"collections":[{{"name":"notes","shape":{{"kind":"object","fields":{{{id}}},"open":true}},"source":"config"}},{{"name":"notes","shape":{{"kind":"object","fields":{{{id}}},"open":true}},"source":"config"}}]}}"#
        ),
    );
}

#[test]
fn a_bundle_validates_each_part_with_paths_from_its_root() {
    let policy = vectors("policy/vectors.json");
    let set = named(items(&policy, "sets"), "deploy/dev/policies/notes.ts")
        .get("document")
        .unwrap_or_else(|| unreachable!());
    let case = items(&items(&policy, "suites")[0], "documents")[0].clone();
    let bundle = format!(
        r#"{{"version":1,"context":{{"mode":"development","command":"start"}},"files":{{"config":null,"policies":"policies","tests":["policies/notes.test.ts"],"schema":null}},"config":null,"policies":{},"tests":[{}],"schema":null}}"#,
        text(set),
        text(&case),
    );
    let validated = validate_bundle(&bundle).unwrap_or_else(|error| unreachable!("{error}"));
    assert!(validated.policies.is_some());
    let broken = bundle.replacen(r#""roles":["anon"]"#, r#""roles":["service"]"#, 1);
    assert_ne!(broken, bundle);
    let refused = match validate_bundle(&broken) {
        Ok(_) => unreachable!("expected a refusal"),
        Err(error) => error,
    };
    assert_eq!(refused.code(), AuthoringCode::InvalidQuery);
    assert!(refused.path().starts_with("/policies/collections/0/policies/"), "{refused}");
    let bad_mode = bundle.replace(r#""mode":"development""#, r#""mode":"staging""#);
    let refused = match validate_bundle(&bad_mode) {
        Ok(_) => unreachable!("expected a refusal"),
        Err(error) => error,
    };
    assert_eq!(refused.path(), "/context/mode");
}
