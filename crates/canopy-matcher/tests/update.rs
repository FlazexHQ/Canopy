//! Update cases the generated vectors reach rarely, with the results MongoDB 8.0 gives for them.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_matcher::{UpdateOptions, apply_update, is_unsupported};
use canopy_protocol::ejson::{DecodeOptions, parse, stringify};
use canopy_protocol::{Document, Value};

fn value(text: &str) -> Value {
    parse(text, DecodeOptions::default()).expect("EJSON")
}

fn document(text: &str) -> Document {
    match value(text) {
        Value::Document(document) => document,
        other => panic!("not a document: {other:?}"),
    }
}

fn updated(doc: &str, update: &str) -> String {
    let after = apply_update(&document(doc), &value(update), &UpdateOptions::default()).expect(update);
    stringify(&Value::Document(after)).expect("EJSON")
}

fn refusal(doc: &str, update: &str) -> String {
    apply_update(&document(doc), &value(update), &UpdateOptions::default())
        .expect_err(update)
        .message()
        .to_owned()
}

#[test]
fn int_arithmetic_widens_to_long_and_long_overflow_is_refused() {
    let widened = apply_update(
        &document(r#"{"_id":1,"n":2147483647}"#),
        &value(r#"{"$inc":{"n":1}}"#),
        &UpdateOptions::default(),
    )
    .expect("applies");
    assert_eq!(widened.get("n"), Some(&Value::Int64(2_147_483_648)));
    assert_eq!(updated(r#"{"_id":1,"n":3}"#, r#"{"$mul":{"n":2}}"#), r#"{"_id":1,"n":6}"#);
    assert_eq!(
        refusal(r#"{"_id":1,"n":{"$numberLong":"9223372036854775807"}}"#, r#"{"$inc":{"n":1}}"#),
        "Failed to apply $inc operations to current value: integer overflow"
    );
    let zero = apply_update(
        &document(r#"{"_id":1}"#),
        &value(r#"{"$mul":{"n":{"$numberLong":"5"}}}"#),
        &UpdateOptions::default(),
    )
    .expect("applies");
    assert_eq!(zero.get("n"), Some(&Value::Int64(0)));
}

#[test]
fn arrays_are_padded_with_null_up_to_the_limit_mongodb_allows() {
    assert_eq!(updated(r#"{"_id":1,"a":[]}"#, r#"{"$set":{"a.2":1}}"#), r#"{"_id":1,"a":[null,null,1]}"#);
    assert_eq!(
        refusal(r#"{"_id":1,"a":[]}"#, r#"{"$set":{"a.1500001":1}}"#),
        "can't backfill more than 1500000 elements"
    );
}

#[test]
fn new_fields_are_created_in_lexicographic_order() {
    assert_eq!(
        updated(r#"{"_id":1}"#, r#"{"$set":{"b":1,"a.10":1,"a.9":2,"a.x":3,"a.B":4}}"#),
        r#"{"_id":1,"a":{"9":2,"10":1,"B":4,"x":3},"b":1}"#
    );
}

#[test]
fn the_id_field_is_immutable() {
    assert_eq!(
        refusal(r#"{"_id":1}"#, r#"{"$set":{"_id":2}}"#),
        "Performing an update on the path '_id' would modify the immutable field '_id'"
    );
    assert_eq!(
        refusal(r#"{"_id":1}"#, r#"{"_id":2,"a":1}"#),
        "After applying the update, the (immutable) field '_id' was found to have been altered"
    );
    assert_eq!(updated(r#"{"_id":1,"x":1}"#, r#"{"a":1}"#), r#"{"_id":1,"a":1}"#);
}

#[test]
fn array_filters_select_elements_and_must_all_be_used() {
    let options =
        UpdateOptions { array_filters: vec![value(r#"{"x":{"$gte":2}}"#)], ..UpdateOptions::default() };
    let after =
        apply_update(&document(r#"{"_id":1,"a":[1,2,3]}"#), &value(r#"{"$inc":{"a.$[x]":10}}"#), &options)
            .expect("applies");
    assert_eq!(stringify(&Value::Document(after)).expect("EJSON"), r#"{"_id":1,"a":[1,12,13]}"#);
    let unused = apply_update(&document(r#"{"_id":1,"a":[1]}"#), &value(r#"{"$set":{"b":1}}"#), &options);
    assert_eq!(
        unused.expect_err("unused filter").message(),
        "The array filter for identifier 'x' was not used in the update"
    );
}

#[test]
fn updates_the_updater_does_not_evaluate_are_reported_as_unsupported() {
    for update in
        [r#"[{"$set":{"a":1}}]"#, r#"{"$set":{"a.$":1}}"#, r#"{"$inc":{"a":{"$numberDecimal":"1"}}}"#]
    {
        let error =
            apply_update(&document(r#"{"_id":1,"a":[1]}"#), &value(update), &UpdateOptions::default())
                .expect_err(update);
        assert!(is_unsupported(&error), "{update}: {}", error.message());
    }
}

#[test]
fn current_date_uses_the_given_clock() {
    let options = UpdateOptions { now: Some(1_700_000_000_123), ..UpdateOptions::default() };
    let update = value(r#"{"$currentDate":{"d":true,"t":{"$type":"timestamp"}}}"#);
    let after = apply_update(&document(r#"{"_id":1}"#), &update, &options).expect("applies");
    assert_eq!(
        stringify(&Value::Document(after)).expect("EJSON"),
        r#"{"_id":1,"d":{"$date":"2023-11-14T22:13:20.123Z"},"t":{"$timestamp":{"t":1700000000,"i":1}}}"#
    );
}

#[test]
fn a_rename_target_that_is_not_a_string_is_refused_with_the_text_javascript_gives() {
    assert_eq!(
        refusal(r#"{"_id":1}"#, r#"{"$rename":{"":[{}]}}"#),
        "The 'to' field for $rename must be a string: : [object Object]"
    );
    assert_eq!(
        refusal(r#"{"_id":1}"#, r#"{"$rename":{"a":[null,1,[null,2]]}}"#),
        "The 'to' field for $rename must be a string: a: ,1,,2"
    );
    assert_eq!(
        refusal(r#"{"_id":1}"#, r#"{"$rename":{"a":5}}"#),
        "The 'to' field for $rename must be a string: a: 5"
    );
}
