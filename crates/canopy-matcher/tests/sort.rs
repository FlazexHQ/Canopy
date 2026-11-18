//! Sort and projection cases the generated vectors reach rarely, with the decisions and orders MongoDB 8.0
//! gives for them.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_matcher::{compile_projection, compile_sort};
use canopy_protocol::ejson::{DecodeOptions, parse, stringify};
use canopy_protocol::{DocRef, Document, Value};

fn value(text: &str) -> Value {
    parse(text, DecodeOptions::default()).expect("EJSON")
}

fn document(text: &str) -> Document {
    match value(text) {
        Value::Document(document) => document,
        other => panic!("not a document: {other:?}"),
    }
}

fn key_error(spec: &str, doc: &str) -> Option<String> {
    let sort = compile_sort(&value(spec)).expect("compiles");
    sort.key(DocRef::Owned(&document(doc))).err().map(|error| error.message().to_owned())
}

fn order(spec: &str, docs: &[&str]) -> Vec<String> {
    let sort = compile_sort(&value(spec)).expect("compiles");
    let mut documents: Vec<Document> = docs.iter().map(|doc| document(doc)).collect();
    sort.sort(&mut documents).expect("sorts");
    documents.into_iter().map(|doc| stringify(doc.get("_id").expect("_id")).expect("EJSON")).collect()
}

const PARALLEL: &str = "cannot sort with keys that are parallel arrays";

#[test]
fn arrays_are_told_apart_by_identity_not_by_content() {
    assert_eq!(key_error(r#"{"a":1,"b":1}"#, r#"{"_id":1,"a":[1,2],"b":[1,2]}"#).as_deref(), Some(PARALLEL));
    assert_eq!(key_error(r#"{"a":1,"b":1}"#, r#"{"_id":1,"a":[],"b":[]}"#).as_deref(), Some(PARALLEL));
    assert_eq!(
        key_error(r#"{"a.b":1,"a.0.b":1}"#, r#"{"_id":1,"a":[{"b":[1]},{"b":[1]}]}"#).as_deref(),
        Some(PARALLEL)
    );
}

#[test]
fn a_positional_path_reads_inside_the_array_the_other_keys_expand() {
    assert_eq!(key_error(r#"{"a.b":1,"a.0.b":1}"#, r#"{"_id":1,"a":[{"b":[1,2]},{"b":3}]}"#), None);
    assert_eq!(
        key_error(r#"{"a.b":1,"a.0.c":1}"#, r#"{"_id":1,"a":[{"b":1,"c":[1,2]},{"b":3,"c":[1]}]}"#),
        None
    );
    assert_eq!(key_error(r#"{"a.0.b":1,"a.b":1}"#, r#"{"_id":1,"a":[[{"b":1}],{"b":2}]}"#), None);
    assert_eq!(
        key_error(r#"{"a.b":1,"a.0.b":1}"#, r#"{"_id":1,"a":[{"b":[1,2]},{"b":[3,4]}]}"#).as_deref(),
        Some(PARALLEL)
    );
    assert_eq!(
        key_error(r#"{"a.0.b":1,"a.1.b":1}"#, r#"{"_id":1,"a":[{"b":[1]},{"b":[2]}]}"#).as_deref(),
        Some(PARALLEL)
    );
    let docs = [
        r#"{"_id":1,"a":[{"b":[5,2]},{"b":3}]}"#,
        r#"{"_id":2,"a":[{"b":4},{"b":1}]}"#,
        r#"{"_id":3,"a":[{"b":[5]},{"b":6}]}"#,
    ];
    assert_eq!(order(r#"{"a.0.b":-1,"a.b":1}"#, &docs), ["1", "3", "2"]);
}

#[test]
fn numeric_field_names_inside_an_array_addressed_by_position_are_refused() {
    let error = key_error(r#"{"a.0.b":1,"a.b":1}"#, r#"{"_id":1,"a":[{"0":{"b":1}},{"b":2}]}"#);
    assert!(error.is_some_and(|message| message.starts_with("Ambiguous field name found in array")));
}

#[test]
fn empty_arrays_order_like_mongodb() {
    let docs = [
        r#"{"_id":1,"a":[[],5]}"#,
        r#"{"_id":2,"a":null}"#,
        r#"{"_id":3,"a":[[1],0]}"#,
        r#"{"_id":4,"a":[[]]}"#,
    ];
    assert_eq!(order(r#"{"a.0":1}"#, &docs), ["1", "4", "2", "3"]);
    assert_eq!(order(r#"{"a":1}"#, &docs), ["2", "3", "1", "4"]);
    let missing = [r#"{"_id":3,"v":1}"#, r#"{"_id":1}"#, r#"{"_id":2,"v":[]}"#, r#"{"_id":0,"v":null}"#];
    assert_eq!(order(r#"{"v":1}"#, &missing), ["2", "0", "1", "3"]);
}

#[test]
fn ascending_sorts_use_the_smallest_element_and_descending_the_largest() {
    let docs = [r#"{"_id":1,"v":[1,10]}"#, r#"{"_id":2,"v":5}"#, r#"{"_id":3,"v":[3,4]}"#];
    assert_eq!(order(r#"{"v":1}"#, &docs), ["1", "3", "2"]);
    assert_eq!(order(r#"{"v":-1}"#, &docs), ["1", "2", "3"]);
}

#[test]
fn invalid_sorts_are_refused() {
    for (spec, message) in [
        (r#"{"a":2}"#, "The sort direction for a must be 1 or -1"),
        (r#"{"a.":1}"#, "Invalid sort path: a."),
        (r#"{"$a":1}"#, "Invalid sort path: $a"),
        ("[]", "A sort must be a document"),
    ] {
        assert_eq!(compile_sort(&value(spec)).expect_err(spec).message(), message);
    }
}

#[test]
fn projections_refuse_collisions_and_mixed_modes() {
    for (spec, message) in [
        (r#"{"a":1,"b":0}"#, "Cannot mix inclusion and exclusion in a projection"),
        (r#"{"a":1,"a.b":1}"#, "Path collision at a.b"),
        (r#"{"_id.x":1,"_id":1}"#, "Path collision at _id.x"),
        (r#"{"_id":0,"_id.x":0}"#, "Path collision at _id.x"),
    ] {
        assert_eq!(compile_projection(&value(spec)).expect_err(spec).message(), message);
    }
    let projection = compile_projection(&value(r#"{"_id.x":0}"#)).expect("compiles");
    let projected = projection.apply(DocRef::Owned(&document(r#"{"_id":{"x":1,"y":2},"a":1}"#)));
    assert_eq!(stringify(&Value::Document(projected)).expect("EJSON"), r#"{"_id":{"y":2},"a":1}"#);
}
