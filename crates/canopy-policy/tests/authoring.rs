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
