//! The keyset cursor against the TypeScript implementation (the reference data of `conformance/cursor`) and
//! against the matcher (every generated position selects exactly the documents after it, in the order MongoDB
//! sorts).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::cmp::Ordering;

use canopy_data::{
    CursorKey, cursor_keys, cursor_query_hash, decode_cursor, encode_cursor, keyset_filter, position_of,
};
use canopy_matcher::{compile_filter, compile_sort};
use canopy_protocol::bson::encode_document;
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_protocol::{CanopyError, Document, ErrorCode, RawDocument, Value};

const HASHES: &str = include_str!("../../../conformance/cursor/hashes.json");
const KEYSETS: &str = include_str!("../../../conformance/cursor/keysets.json");
const CURSORS: &str = include_str!("../../../conformance/cursor/cursors.json");

/// The cases of a reference file.
fn cases(file: &str) -> Vec<Json> {
    match parse_json(file) {
        Ok(json) => match json.get("cases") {
            Some(Json::Array(cases)) => cases.clone(),
            other => unreachable!("the reference file has no cases: {other:?}"),
        },
        Err(error) => unreachable!("the reference file is valid JSON: {error}"),
    }
}

fn member<'a>(case: &'a Json, name: &str) -> &'a Json {
    case.get(name).unwrap_or_else(|| unreachable!("a case has no {name}: {case:?}"))
}

fn text_of(json: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, json);
    out
}

fn string_of<'a>(case: &'a Json, name: &str) -> &'a str {
    match member(case, name) {
        Json::String(text) => text,
        other => unreachable!("{name} is not a string: {other:?}"),
    }
}

fn ejson(text: &str) -> Value {
    match parse(text, DecodeOptions::default()) {
        Ok(value) => value,
        Err(error) => unreachable!("{text} is valid EJSON: {error}"),
    }
}

fn document(text: &str) -> Document {
    match ejson(text) {
        Value::Document(document) => document,
        other => unreachable!("{text} is not a document: {other:?}"),
    }
}

fn values(text: &str) -> Vec<Value> {
    match ejson(text) {
        Value::Array(items) => items,
        other => unreachable!("{text} is not an array: {other:?}"),
    }
}

fn keys_of_json(sort: &Json) -> Vec<CursorKey> {
    match sort {
        Json::Null => cursor_keys(None),
        other => cursor_keys(Some(&document(&text_of(other)))),
    }
}

fn keys_of(sort: &str) -> Vec<CursorKey> {
    let sort = match parse_json(sort) {
        Ok(canopy_protocol::json::Json::Null) => None,
        Ok(_) => Some(document(sort)),
        Err(error) => unreachable!("{sort} is valid JSON: {error}"),
    };
    cursor_keys(sort.as_ref())
}

fn refusal(result: Result<impl std::fmt::Debug, CanopyError>) -> String {
    match result {
        Ok(value) => unreachable!("expected a refusal, got {value:?}"),
        Err(error) => {
            assert_eq!(error.code(), ErrorCode::InvalidQuery);
            error.message().to_owned()
        }
    }
}

#[test]
fn the_query_hash_equals_the_typescript_hash() {
    let cases = cases(HASHES);
    assert!(cases.len() >= 10, "{} hash cases", cases.len());
    for case in &cases {
        let collection = string_of(case, "collection");
        let filter = text_of(member(case, "filter"));
        let keys = keys_of_json(member(case, "sort"));
        let hash = cursor_query_hash(collection, &document(&filter), &keys);
        assert_eq!(hash.as_deref(), Ok(string_of(case, "hash")), "{collection} {filter}");
    }
}

#[test]
fn equivalent_filters_are_the_same_query_and_other_queries_differ() {
    let keys = cursor_keys(None);
    let a = cursor_query_hash("todos", &document(r#"{"a":1,"b":{"$in":[2,1]}}"#), &keys);
    let b = cursor_query_hash("todos", &document(r#"{"b":{"$in":[1,2]},"a":1}"#), &keys);
    assert_eq!(a, b);
    let other_collection = cursor_query_hash("notes", &document(r#"{"a":1,"b":{"$in":[2,1]}}"#), &keys);
    let other_sort = cursor_query_hash(
        "todos",
        &document(r#"{"a":1,"b":{"$in":[2,1]}}"#),
        &keys_of(r#"{"createdAt":-1}"#),
    );
    let other_filter = cursor_query_hash("todos", &document(r#"{"a":2,"b":{"$in":[2,1]}}"#), &keys);
    for other in [other_collection, other_sort, other_filter] {
        assert_ne!(a, other);
    }
}

#[test]
fn keyset_filters_equal_the_typescript_forms_byte_for_byte() {
    let cases = cases(KEYSETS);
    assert!(cases.len() >= 20, "{} keyset cases", cases.len());
    let (mut filters, mut refusals) = (0, 0);
    for case in &cases {
        let keys = keys_of_json(member(case, "sort"));
        let position = text_of(member(case, "position"));
        let result = keyset_filter(&keys, &values(&position));
        let context = format!("sort {} position {position}", text_of(member(case, "sort")));
        match (case.get("filter"), case.get("error")) {
            (Some(Json::String(expected)), None) => {
                let actual = result.and_then(|filter| canonical_string(&Value::Document(filter)));
                assert_eq!(actual.as_deref(), Ok(expected.as_str()), "{context}");
                filters += 1;
            }
            (None, Some(Json::String(message))) => {
                assert_eq!(&refusal(result), message, "{context}");
                refusals += 1;
            }
            other => unreachable!("a case holds a filter or an error: {other:?}"),
        }
    }
    assert!(filters >= 20 && refusals >= 3, "{filters} filters and {refusals} refusals");
}

#[test]
fn the_first_key_is_bounded_only_where_it_bounds_something() {
    let bounded = |sort: &str, position: &str| {
        let filter = keyset_filter(&keys_of(sort), &values(position)).map(Value::Document);
        canonical_string(&filter.unwrap_or(Value::Null)).unwrap_or_default().contains("$not")
    };
    assert!(bounded(r#"{"k":1}"#, "[7,1]"));
    assert!(bounded(r#"{"k":-1}"#, r#"["x",1]"#));
    assert!(!bounded("null", "[3]"), "a plain _id sort has no first key to bound");
    assert!(!bounded(r#"{"k":1}"#, "[null,1]"));
    assert!(!bounded(r#"{"k":1}"#, r#"[{"$minKey":1},1]"#));
    assert!(!bounded(r#"{"k":1}"#, r#"[{"$maxKey":1},1]"#));
    assert!(!bounded(r#"{"k":1}"#, r#"[{"$numberDouble":"NaN"},1]"#));
    assert!(!bounded(r#"{"k":-1}"#, r#"[{"$numberDecimal":"NaN"},1]"#));
}

#[test]
fn a_document_sort_value_is_compared_through_eq() {
    let keys = cursor_keys(Some(&document(r#"{"a":1}"#)));
    let filter = keyset_filter(&keys, &[ejson(r#"{"$gt":5}"#), Value::Int32(1)])
        .map(Value::Document)
        .and_then(|filter| canonical_string(&filter));
    let text = filter.unwrap_or_default();
    assert!(text.contains(r#"{"a":{"$eq":{"$gt":{"$numberInt":"5"}}}}"#), "{text}");
}

#[test]
fn a_regular_expression_position_cannot_continue_in_either_direction() {
    let regex = ejson(r#"{"$regularExpression":{"pattern":"x","options":""}}"#);
    for direction in ["1", "-1"] {
        let keys = keys_of(&format!(r#"{{"a":{direction}}}"#));
        let message = refusal(keyset_filter(&keys, &[regex.clone(), Value::Int32(1)]));
        assert!(message.contains("regular expression sort value"), "{message}");
        assert!(message.contains("\"a\""), "{message}");
        assert!(message.contains("next page cannot be read"), "{message}");
    }
}

#[test]
fn an_array_position_cannot_continue() {
    let keys = keys_of(r#"{"a":1}"#);
    let message = refusal(keyset_filter(&keys, &[Value::Array(vec![]), Value::Int32(1)]));
    assert_eq!(message, "A cursor value may not be an array");
}

#[test]
fn a_sort_gets_the_id_tie_breaker_unless_it_has_one() {
    let shape = |sort: &str| {
        keys_of(sort)
            .into_iter()
            .map(|key| (key.path, key.direction == canopy_matcher::Direction::Ascending))
            .collect::<Vec<_>>()
    };
    assert_eq!(shape(r#"{"a":-1}"#), [("a".to_owned(), false), ("_id".to_owned(), true)]);
    assert_eq!(shape(r#"{"_id":-1,"a":1}"#), [("_id".to_owned(), false), ("a".to_owned(), true)]);
    assert_eq!(shape("null"), [("_id".to_owned(), true)]);
}

fn raw(document: &Document) -> Vec<u8> {
    match encode_document(document) {
        Ok(bytes) => bytes,
        Err(error) => unreachable!("encodes: {error}"),
    }
}

#[test]
fn a_position_reads_a_missing_value_as_null_and_a_symbol_as_itself() {
    let keys = keys_of(r#"{"a":1}"#);
    let bytes = raw(&document(r#"{"_id":1}"#));
    let missing = RawDocument::new(&bytes).map(|doc| position_of(&doc, &keys));
    assert_eq!(missing, Ok(Ok(vec![Value::Null, Value::Int32(1)])));
    let mut with_symbol = Document::new();
    with_symbol.insert("_id", Value::String("y1".to_owned()));
    with_symbol.insert("a", Value::Symbol("sym".to_owned()));
    let bytes = raw(&with_symbol);
    let position = RawDocument::new(&bytes).map(|doc| position_of(&doc, &keys));
    assert_eq!(position, Ok(Ok(vec![Value::Symbol("sym".to_owned()), Value::String("y1".to_owned())])));
    let hash = cursor_query_hash("symbols", &Document::new(), &keys).unwrap_or_default();
    let cursor = encode_cursor(&[Value::Symbol("sym".to_owned()), Value::String("y1".to_owned())], &hash);
    let decoded = cursor.and_then(|cursor| decode_cursor(&cursor, &keys, &hash));
    assert_eq!(decoded, Ok(vec![Value::String("sym".to_owned()), Value::String("y1".to_owned())]));
}

#[test]
fn cursors_equal_the_typescript_cursors_and_decode_back() {
    let cases = cases(CURSORS);
    assert!(cases.len() >= 3, "{} cursor cases", cases.len());
    for case in &cases {
        let position = values(&text_of(member(case, "position")));
        let (hash, expected) = (string_of(case, "hash"), string_of(case, "cursor"));
        assert_eq!(position.len(), 2, "the cursors are cut for one sort key and the _id tie breaker");
        let keys = keys_of(r#"{"createdAt":-1}"#);
        assert_eq!(encode_cursor(&position, hash).as_deref(), Ok(expected));
        let decoded = decode_cursor(expected, &keys, hash).map(|decoded| {
            decoded.iter().map(|value| canonical_string(value).unwrap_or_default()).collect::<Vec<_>>()
        });
        let wanted: Vec<String> =
            position.iter().map(|value| canonical_string(value).unwrap_or_default()).collect();
        assert_eq!(decoded, Ok(wanted));
    }
}

fn plain_cursor(json: &str) -> String {
    let standard = canopy_protocol::ejson::base64_encode(json.as_bytes());
    standard.replace('+', "-").replace('/', "_").trim_end_matches('=').to_owned()
}

#[test]
fn malformed_and_foreign_cursors_are_refused() {
    let keys = keys_of(r#"{"createdAt":-1}"#);
    let hash = "1cb4abd0e981f7e24003bfc0584f24ce";
    let malformed = |cursor: &str| {
        let message = refusal(decode_cursor(cursor, &keys, hash));
        assert_eq!(message, "Malformed cursor", "{cursor}");
    };
    malformed("");
    malformed("not base64!");
    malformed(&"x".repeat(5000));
    malformed("x");
    malformed(&plain_cursor("[1]"));
    malformed(&plain_cursor(r#"{"s":"x","q":"1cb4abd0e981f7e24003bfc0584f24ce"}"#));
    malformed(&plain_cursor(r#"{"s":[1,2],"q":3}"#));
    malformed(&plain_cursor(r#"{"q":"1cb4abd0e981f7e24003bfc0584f24ce"}"#));
    malformed(&plain_cursor(r#"{"s":[[1],2],"q":"1cb4abd0e981f7e24003bfc0584f24ce"}"#));
    malformed(&plain_cursor("{bad"));
    malformed("_w");
    let different = |cursor: &str| {
        assert_eq!(
            refusal(decode_cursor(cursor, &keys, hash)),
            "The cursor belongs to a different query",
            "{cursor}"
        );
    };
    different(&plain_cursor(r#"{"s":[1],"q":"1cb4abd0e981f7e24003bfc0584f24ce"}"#));
    different(&plain_cursor(r#"{"s":[1,2],"q":"ffffffffffffffffffffffffffffffff"}"#));
    let planted = refusal(decode_cursor(
        &plain_cursor(r#"{"s":[{"$where":"x"},1],"q":"1cb4abd0e981f7e24003bfc0584f24ce"}"#),
        &keys,
        hash,
    ));
    assert!(planted.contains('$'), "{planted}");
}

const SORT_VALUES: [&str; 14] = [
    "null",
    "-3",
    "0",
    "2",
    r#"{"$numberDouble":"0.5"}"#,
    r#"{"$numberDouble":"Infinity"}"#,
    r#"{"$numberDouble":"-Infinity"}"#,
    r#"{"$numberDouble":"NaN"}"#,
    r#""""#,
    r#""ab""#,
    "true",
    r#"{"$date":{"$numberLong":"1000"}}"#,
    r#"{"$oid":"000000000000000000000002"}"#,
    r#"{"x":1}"#,
];

fn rows() -> Vec<Document> {
    let mut missing_and_edges: Vec<Option<Value>> = vec![None];
    missing_and_edges.extend(SORT_VALUES.iter().map(|text| Some(ejson(text))));
    missing_and_edges.push(Some(ejson(r#"{"$minKey":1}"#)));
    missing_and_edges.push(Some(ejson(r#"{"$maxKey":1}"#)));
    let mut out = Vec::new();
    let mut id = 0;
    for k in &missing_and_edges {
        for j in missing_and_edges.iter().step_by(3) {
            let mut document = Document::new();
            document.insert("_id", Value::Int32(id));
            if let Some(k) = k {
                document.insert("k", k.clone());
            }
            if let Some(j) = j {
                document.insert("j", j.clone());
            }
            out.push(document);
            id += 1;
        }
    }
    out
}

#[test]
fn a_position_selects_exactly_the_documents_after_it_in_mongodb_order() {
    let specs = [
        r#"{}"#,
        r#"{"k":1}"#,
        r#"{"k":-1}"#,
        r#"{"k":1,"j":-1}"#,
        r#"{"k":-1,"j":1}"#,
        r#"{"_id":-1}"#,
        r#"{"k":1,"_id":-1}"#,
    ];
    let documents = rows();
    assert!(documents.len() > 100);
    for spec in specs {
        let sort = document(spec);
        let keys = cursor_keys(Some(&sort));
        let order = compile_sort(&Value::Document(sort.clone())).expect("a valid sort");
        let mut ordered = documents.clone();
        ordered.sort_by(|a, b| {
            order
                .compare(canopy_protocol::DocRef::Owned(a), canopy_protocol::DocRef::Owned(b))
                .unwrap_or(Ordering::Equal)
        });
        for (index, current) in ordered.iter().enumerate() {
            let bytes = raw(current);
            let position = RawDocument::new(&bytes)
                .map(|doc| position_of(&doc, &keys))
                .expect("raw")
                .expect("a position");
            let filter = match keyset_filter(&keys, &position) {
                Ok(filter) => filter,
                Err(error) => {
                    unreachable!("{spec} {current:?}: {error}");
                }
            };
            let matcher = compile_filter(&Value::Document(filter)).expect("a matcher safe filter");
            let selected: Vec<&Value> = ordered
                .iter()
                .filter(|candidate| matcher.matches(candidate).unwrap_or(false))
                .filter_map(|candidate| candidate.get("_id"))
                .collect();
            let expected: Vec<&Value> =
                ordered[index + 1..].iter().filter_map(|candidate| candidate.get("_id")).collect();
            assert_eq!(selected, expected, "sort {spec} after {current:?}");
        }
    }
}
