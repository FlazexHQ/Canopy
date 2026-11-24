//! Holds `ErrorCode` to `conformance/errors.json`, the one source of the error codes, which the TypeScript
//! `@canopy/protocol` is checked against too: the same codes in the same order, with the same HTTP status.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_protocol::ErrorCode;
use canopy_protocol::json::{Json, parse_json};

fn text<'a>(entry: &'a Json, name: &str) -> &'a str {
    match entry.get(name) {
        Some(Json::String(text)) => text,
        other => panic!("{name} is {other:?}"),
    }
}

#[test]
fn every_code_has_the_recorded_name_wire_form_and_status() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/errors.json");
    let recorded =
        parse_json(&std::fs::read_to_string(path).expect("conformance/errors.json")).expect("JSON");
    let Some(Json::Array(codes)) = recorded.get("codes") else { panic!("codes") };
    assert_eq!(codes.len(), ErrorCode::ALL.len(), "the same number of codes");
    for (entry, code) in codes.iter().zip(ErrorCode::ALL) {
        assert_eq!(format!("{code:?}"), text(entry, "name"));
        assert_eq!(code.as_str(), text(entry, "code"));
        assert_eq!(ErrorCode::parse(text(entry, "code")), Some(*code));
        let Some(Json::Number(status)) = entry.get("status") else { panic!("status") };
        assert_eq!(f64::from(code.http_status()), *status, "{code}");
    }
    assert_eq!(ErrorCode::parse("CANOPY_NOPE"), None);
}
