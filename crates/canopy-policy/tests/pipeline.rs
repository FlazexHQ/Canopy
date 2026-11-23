//! Replays `conformance/policy/pipeline.json`, recorded from the TypeScript `securePipeline`
//! (`bun run vectors:pipeline`): for fixed and generated aggregation pipelines, callers and search settings,
//! `secure_pipeline` must return the same pipeline, byte for byte as canonical EJSON, or the same refusal.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_policy::{
    DEFAULT_PIPELINE_LIMITS, PipelineLimits, PolicyEngine, RequestContext, Roles, SecurePipelineOptions,
    create_policy_set, from_stored, secure_pipeline,
};
use canopy_protocol::Value;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_query::js_property_order;

fn value(source: &str) -> Value {
    js_property_order(&parse(source, DecodeOptions::default()).expect("EJSON"))
}

fn text<'a>(json: &'a Json, name: &str) -> Option<&'a str> {
    match json.get(name) {
        Some(Json::String(text)) => Some(text),
        _ => None,
    }
}

fn number(json: &Json, name: &str) -> Option<f64> {
    match json.get(name) {
        Some(Json::Number(number)) => Some(*number),
        _ => None,
    }
}

fn caller(source: &str) -> RequestContext {
    let Value::Document(caller) = value(source) else { panic!("a caller document") };
    let roles: Roles = caller
        .get("roles")
        .and_then(Value::as_array)
        .expect("roles")
        .iter()
        .map(|role| role.as_str().expect("role").to_owned())
        .collect();
    let claims = caller.get("claims").and_then(Value::as_document).cloned();
    let Some(Value::DateTime(now)) = caller.get("now") else { panic!("now") };
    RequestContext { roles, claims, ctx: None, now: *now }
}

#[test]
fn secure_pipeline_matches_the_typescript_sanitizer() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/policy/pipeline.json");
    let source = std::fs::read_to_string(path).expect("conformance/policy/pipeline.json");
    let recorded = parse_json(&source).expect("JSON");
    let Some(Json::Array(collections)) = recorded.get("collections") else { panic!("collections") };
    let definitions = collections
        .iter()
        .map(|item| {
            from_stored(&value(match item {
                Json::String(text) => text,
                other => panic!("a stored collection, got {other:?}"),
            }))
            .expect("stored policies")
        })
        .collect();
    let engine = PolicyEngine::new(create_policy_set(definitions, Default::default()).expect("policy set"));
    let callers = recorded.get("callers").expect("callers");
    let Some(Json::Array(cases)) = recorded.get("cases") else { panic!("cases") };
    assert!(cases.len() > 2000, "the file holds the generated cases too");
    let mut accepted = 0;
    let mut mismatches = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let collection = text(case, "collection").expect("collection");
        let name = text(case, "caller").expect("caller");
        let ctx = caller(text(callers, name).expect("a known caller"));
        let search = matches!(case.get("search"), Some(Json::Bool(true)));
        let mut limits: PipelineLimits = DEFAULT_PIPELINE_LIMITS;
        if let Some(max) = number(case, "maxStages") {
            limits.max_stages = max as usize;
        }
        if let Some(max) = number(case, "maxSample") {
            limits.max_sample = max as u64;
        }
        let pipeline = value(text(case, "pipeline").expect("pipeline"));
        let options = SecurePipelineOptions { search, max_search_results: 1000 };
        let actual = secure_pipeline(&engine, collection, &pipeline, &ctx, &limits, options).map(|stages| {
            canonical_string(&Value::Array(stages.into_iter().map(Value::Document).collect())).expect("EJSON")
        });
        let matched = match (&actual, text(case, "result"), text(case, "error")) {
            (Ok(stages), Some(expected), None) => {
                accepted += 1;
                stages == expected
            }
            (Err(error), None, Some(expected)) => {
                error.message() == expected && text(case, "code") == Some(error.code().as_str())
            }
            _ => false,
        };
        if !matched {
            mismatches.push(format!(
                "case {index} ({name} on {collection}, search {search}): {} gave {actual:?}, expected {:?} {:?}",
                text(case, "pipeline").unwrap_or_default(),
                text(case, "result"),
                text(case, "error"),
            ));
        }
    }
    assert!(accepted > 300, "accepted pipelines are compared too");
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches[..mismatches.len().min(15)].join("\n")
    );
}
