//! Policy sets and policy test cases.

use canopy_policy::{PolicySet, parse_policy_set};
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, write_json};

use crate::pointer::Pointer;
use crate::{AuthoringCode, AuthoringError, Kind, check_schema, parse};

const CODE: AuthoringCode = AuthoringCode::InvalidQuery;

fn text(value: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn compiles(collections: Vec<Json>, contexts: Json) -> bool {
    let set = object(vec![
        ("version", Json::Number(1.0)),
        ("collections", Json::Array(collections)),
        ("contexts", contexts),
    ]);
    parse_policy_set(&text(&set)).is_ok()
}

fn with_fields(collection: &Json, keep: impl Fn(&str) -> bool, policies: Vec<Json>) -> Json {
    let Json::Object(fields) = collection else { return collection.clone() };
    let mut out: Vec<(String, Json)> =
        fields.iter().filter(|(key, _)| key != "policies" && keep(key)).cloned().collect();
    out.push(("policies".to_owned(), Json::Array(policies)));
    Json::Object(out)
}

fn without(policy: &Json, dropped: &str) -> Json {
    match policy {
        Json::Object(fields) => {
            Json::Object(fields.iter().filter(|(key, _)| key != dropped).cloned().collect())
        }
        other => other.clone(),
    }
}

/// Narrows a compiler refusal of a whole set down to the context, collection, policy or clause that causes
/// it, by compiling each part on its own.
fn locate(document: &Json) -> Pointer {
    let empty = Json::Object(Vec::new());
    let contexts = document.get("contexts").cloned().unwrap_or_else(|| empty.clone());
    if let Json::Object(lookups) = &contexts {
        for (name, lookup) in lookups {
            if !compiles(Vec::new(), Json::Object(vec![(name.clone(), lookup.clone())])) {
                return Pointer::of(&["contexts", name]);
            }
        }
    }
    let Some(Json::Array(collections)) = document.get("collections") else { return Pointer::default() };
    for (index, collection) in collections.iter().enumerate() {
        let name = collection.get("collection");
        if collections[..index].iter().any(|earlier| earlier.get("collection") == name) {
            return Pointer::of(&["collections", &index.to_string(), "collection"]);
        }
    }
    for (index, collection) in collections.iter().enumerate() {
        let here = Pointer::of(&["collections", &index.to_string()]);
        if compiles(vec![collection.clone()], contexts.clone()) {
            continue;
        }
        let policies = match collection.get("policies") {
            Some(Json::Array(policies)) => policies.as_slice(),
            _ => &[],
        };
        let bare = |key: &str| key != "fields" && key != "immutable";
        for (position, policy) in policies.iter().enumerate() {
            let named = here.child("policies").child(&position.to_string());
            if policies[..position].iter().any(|earlier| earlier.get("name") == policy.get("name")) {
                return named.child("name");
            }
            if compiles(vec![with_fields(collection, bare, vec![policy.clone()])], contexts.clone()) {
                continue;
            }
            for (clause, other) in [("using", "check"), ("check", "using")] {
                if policy.get(clause).is_some()
                    && !compiles(
                        vec![with_fields(collection, bare, vec![without(policy, other)])],
                        contexts.clone(),
                    )
                    && compiles(
                        vec![with_fields(
                            collection,
                            bare,
                            vec![without(&without(policy, "using"), "check")],
                        )],
                        contexts.clone(),
                    )
                {
                    return named.child(clause);
                }
            }
            return named;
        }
        for key in ["fields", "immutable"] {
            if collection.get(key).is_some()
                && !compiles(
                    vec![with_fields(collection, |field| field == key || bare(field), Vec::new())],
                    contexts.clone(),
                )
            {
                return here.child(key);
            }
        }
        return here;
    }
    Pointer::default()
}

/// Validates a version 1 policy set given as JSON and compiles it.
pub fn validate_policy_set_json(document: &Json) -> Result<PolicySet, AuthoringError> {
    check_schema(Kind::PolicySet, CODE, document)?;
    parse_policy_set(&text(document))
        .map_err(|error| AuthoringError::new(CODE, locate(document).to_string(), error.message().to_owned()))
}

/// Validates a version 1 policy set given as JSON text (the canonical document of `canopy.js/policy`) and
/// compiles it.
pub fn validate_policy_set(text: &str) -> Result<PolicySet, AuthoringError> {
    validate_policy_set_json(&parse(CODE, text)?)
}

fn decodes(value: Option<&Json>, path: &[&str]) -> Result<(), AuthoringError> {
    match value {
        Some(value @ Json::Object(_)) => {
            decode(value, DecodeOptions::default()).map(|_| ()).map_err(|error| {
                AuthoringError::new(CODE, Pointer::of(path).to_string(), error.message().to_owned())
            })
        }
        _ => Ok(()),
    }
}

/// Validates one version 1 policy test case given as JSON.
pub fn validate_policy_test_json(document: &Json) -> Result<(), AuthoringError> {
    check_schema(Kind::PolicyTest, CODE, document)?;
    let actor = document.get("actor");
    decodes(actor.and_then(|actor| actor.get("claims")), &["actor", "claims"])?;
    decodes(actor.and_then(|actor| actor.get("ctx")), &["actor", "ctx"])?;
    for field in ["doc", "filter", "update"] {
        decodes(document.get(field), &[field])?;
    }
    Ok(())
}

/// Validates one version 1 policy test case given as JSON text (a document of `canopy.js/policy/testing`).
pub fn validate_policy_test(text: &str) -> Result<(), AuthoringError> {
    validate_policy_test_json(&parse(CODE, text)?)
}
