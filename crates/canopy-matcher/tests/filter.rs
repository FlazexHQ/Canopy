//! Filter cases the generated vectors do not reach: refusals, operators routed to MongoDB, regular
//! expressions and fail closed behavior under negation.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_matcher::{compile_filter, is_matcher_safe, is_unsupported};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{Document, ErrorCode, Value};

fn value(text: &str) -> Value {
    parse(text, DecodeOptions::default()).expect("EJSON")
}

fn matches(filter: &str, document: &str) -> bool {
    compile_filter(&value(filter)).expect("compiles").matches_value(&value(document)).expect("decides")
}

fn refusal(filter: &str) -> String {
    compile_filter(&value(filter)).expect_err("refused").message().to_owned()
}

#[test]
fn owned_top_level_string_equality_expands_only_the_immediate_array() {
    let string = Value::String("u42".into());
    let symbol = Value::Symbol("u42".into());
    let mut operators = Document::new();
    operators.insert("$eq", symbol.clone());
    for operand in [string.clone(), Value::Document(operators)] {
        let mut filter = Document::new();
        filter.insert("a", operand);
        let compiled = compile_filter(&Value::Document(filter)).expect("compiles");
        for (field, expected) in [
            (string.clone(), true),
            (symbol.clone(), true),
            (Value::Array(vec![Value::Null, symbol.clone()]), true),
            (Value::Array(vec![Value::Array(vec![string.clone()])]), false),
            (Value::String("u420".into()), false),
            (Value::Null, false),
            (Value::Undefined, false),
        ] {
            let mut document = Document::new();
            document.insert("a", field);
            assert_eq!(compiled.matches(&document), Ok(expected), "{document:?}");
        }
        assert_eq!(compiled.matches(&Document::new()), Ok(false));
    }
}

#[test]
fn operators_the_matcher_does_not_evaluate_are_reported_as_unsupported() {
    for filter in [
        r#"{"$expr":{"$eq":["$a",1]}}"#,
        r#"{"$where":"true"}"#,
        r#"{"$text":{"$search":"x"}}"#,
        r#"{"a":{"$geoWithin":{}}}"#,
        r#"{"a":{"$bitsAllSet":1}}"#,
        r#"{"a":{"$regex":"(a)\\1"}}"#,
    ] {
        let error = compile_filter(&value(filter)).expect_err(filter);
        assert!(is_unsupported(&error), "{filter}: {}", error.message());
        assert_eq!(is_matcher_safe(&value(filter)), Ok(false));
    }
}

#[test]
fn invalid_filters_are_refused_with_mongodb_like_messages() {
    assert_eq!(refusal(r#"{"$and":[]}"#), "$and must be a nonempty array");
    assert_eq!(refusal(r#"{"$foo":1}"#), "unknown top level operator: $foo");
    assert_eq!(refusal(r#"{"a":{"$foo":1}}"#), "unknown operator: $foo");
    assert_eq!(refusal(r#"{"a..b":1}"#), "Invalid field path: a..b");
    assert_eq!(refusal(r#"{"a":{"$options":"i"}}"#), "$options needs a $regex");
    assert_eq!(refusal(r#"{"a":{"$type":"nope"}}"#), "Unknown type name alias: nope");
    assert_eq!(refusal(r#"{"a":{"$type":1.5}}"#), "Invalid numerical type code: 1.5");
    assert_eq!(refusal(r#"{"a":{"$mod":[0,1]}}"#), "divisor cannot be 0");
    assert_eq!(refusal(r#"{"a":{"$size":-1}}"#), "$size may not be negative");
    assert_eq!(refusal(r#"{"a":{"$in":[{"$gt":1}]}}"#), "cannot nest $ under $in");
    assert_eq!(refusal(r#"{"a":{"$all":[{"$elemMatch":{}}, 1]}}"#), "$all/$elemMatch has to be consistent");
    assert_eq!(refusal(r#"{"a":{"$not":{}}}"#), "$not cannot be empty");
    assert!(is_matcher_safe(&value(r#"{"a":{"$foo":1}}"#)).is_err());
}

#[test]
fn regular_expressions_follow_mongodb() {
    assert!(matches(r#"{"a":{"$regex":"^ab","$options":"i"}}"#, r#"{"a":"ABc"}"#));
    assert!(matches(r#"{"a":{"$regularExpression":{"pattern":"b$","options":""}}}"#, r#"{"a":["x","ab"]}"#));
    assert!(!matches(r#"{"a":{"$not":{"$regex":"b"}}}"#, r#"{"a":"abc"}"#));
    assert!(matches(
        r#"{"a":{"$regularExpression":{"pattern":"x","options":"i"}}}"#,
        r#"{"a":{"$regularExpression":{"pattern":"x","options":"i"}}}"#
    ));
    assert_eq!(
        refusal(r#"{"a":{"$regex":{"$regularExpression":{"pattern":"x","options":"i"}},"$options":"m"}}"#),
        "options set in both $regex and $options"
    );
}

#[test]
fn an_undecidable_regex_fails_instead_of_matching_under_a_negation() {
    let filter = compile_filter(&value(r#"{"a":{"$not":{"$regex":"(x|y){1000}"}}}"#)).expect("compiles");
    let document =
        Value::Document([("a".to_owned(), Value::String("x".repeat(30_000)))].into_iter().collect());
    let error = filter.matches_value(&document).expect_err("must not decide");
    assert_eq!(error.code(), ErrorCode::Timeout);
}

#[test]
fn elem_match_reads_arrays_as_documents_of_positions() {
    assert!(matches(r#"{"a":{"$elemMatch":{"0":1}}}"#, r#"{"a":[[1,2]]}"#));
    assert!(!matches(r#"{"a":{"$elemMatch":{"01":1}}}"#, r#"{"a":[[1,2]]}"#));
    assert!(matches(r#"{"a":{"$elemMatch":{"$gt":1,"$lt":3}}}"#, r#"{"a":[0,2,5]}"#));
    assert!(!matches(r#"{"a":{"$elemMatch":{"$gt":1,"$lt":2}}}"#, r#"{"a":[0,2,5]}"#));
}

#[test]
fn numeric_equality_crosses_types_and_decimals() {
    assert!(matches(r#"{"a":{"$numberDecimal":"1.0"}}"#, r#"{"a":1}"#));
    assert!(matches(r#"{"a":{"$in":[{"$numberLong":"2"}]}}"#, r#"{"a":{"$numberDecimal":"2.00"}}"#));
    assert!(matches(r#"{"a":{"$numberDouble":"NaN"}}"#, r#"{"a":{"$numberDecimal":"NaN"}}"#));
    assert!(!matches(r#"{"a":{"$gt":{"$numberDouble":"NaN"}}}"#, r#"{"a":{"$numberDouble":"NaN"}}"#));
    assert!(matches(r#"{"a":{"$gte":{"$numberDouble":"NaN"}}}"#, r#"{"a":{"$numberDouble":"NaN"}}"#));
    assert!(matches(
        r#"{"a":{"$mod":[{"$numberLong":"4"},1]}}"#,
        r#"{"a":{"$numberLong":"9223372036854775805"}}"#
    ));
}
