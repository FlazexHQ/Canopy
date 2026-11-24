//! Holds the Problem Details of every error code to `conformance/errors.json`, which the TypeScript
//! `@canopy/rest` is checked against too: the title, type, status, hint and docs page of each code.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_http::{DEFAULT_PROBLEM_TYPE_BASE, Problem, problem_slug};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, ErrorCode};

fn text<'a>(entry: &'a Json, name: &str) -> Option<&'a str> {
    match entry.get(name) {
        Some(Json::String(text)) => Some(text),
        None => None,
        other => panic!("{name} is {other:?}"),
    }
}

#[test]
fn every_code_answers_with_the_recorded_problem() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/errors.json");
    let recorded =
        parse_json(&std::fs::read_to_string(path).expect("conformance/errors.json")).expect("JSON");
    let Some(Json::Array(codes)) = recorded.get("codes") else { panic!("codes") };
    assert_eq!(codes.len(), ErrorCode::ALL.len());
    for entry in codes {
        let code = ErrorCode::parse(text(entry, "code").expect("code")).expect("a known code");
        let slug = text(entry, "slug").expect("slug");
        let problem =
            Problem::new(&CanopyError::new(code, "detail"), "/rest/v1/x", "r1", DEFAULT_PROBLEM_TYPE_BASE);
        assert_eq!(problem_slug(code), slug);
        assert_eq!(problem.type_uri, format!("urn:canopy:error:{slug}"));
        assert_eq!(Some(problem.title), text(entry, "title"), "{code}");
        assert_eq!(Some(Json::Number(f64::from(problem.status))).as_ref(), entry.get("status"));
        if code == ErrorCode::Internal {
            assert_eq!(problem.detail, "Internal error");
            assert_eq!((problem.hint, problem.docs), (None, None));
        } else {
            assert_eq!(problem.detail, "detail");
            assert_eq!(problem.hint, text(entry, "hint"), "{code}");
            assert_eq!(problem.docs, text(entry, "docs").map(|docs| format!("errors/{docs}")), "{code}");
        }
    }
}
