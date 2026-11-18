//! The cost per change event of the Rust matcher alone, with no boundary: the documents and filters of
//! `scripts/bench.ts`, encoded as BSON, checked with `RawDocument::new` and matched in place (and matched
//! again with the check done beforehand), so the difference to the Node-API and WebAssembly numbers is the
//! cost of the boundary.
//!
//!   cargo run --release --example raw_cost

#![allow(clippy::print_stdout, clippy::expect_used, clippy::cast_precision_loss, missing_docs)]

use std::time::Instant;

use canopy_matcher::compile_filter;
use canopy_protocol::bson::encode_document;
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{RawDocument, Value};

const FILTERS: [(&str, &str); 6] = [
    ("equality (DLS owner)", r#"{"ownerId":"u42"}"#),
    ("range and $in", r#"{"amount":{"$gte":100,"$lt":500},"status":{"$in":["open","paid"]}}"#),
    ("$or of 3 branches", r#"{"$or":[{"status":"open"},{"amount":{"$gt":900}},{"tags":"k3"}]}"#),
    ("dotted path", r#"{"address.city":"Lisbon","address.zip":{"$regex":"^1"}}"#),
    ("$elemMatch", r#"{"items":{"$elemMatch":{"sku":"s7","qty":{"$gte":2}}}}"#),
    ("DLS and user filter", r#"{"$and":[{"tenantId":"t8"},{"status":"open","amount":{"$lt":250}}]}"#),
];

fn event(i: u64) -> Vec<u8> {
    const STATUSES: [&str; 4] = ["open", "paid", "shipped", "closed"];
    let amount = ((i * 2_654_435_761) % 100_000) as f64 / 100.0;
    let text = format!(
        r#"{{"_id":{i},"ownerId":"u{}","tenantId":"t{}","status":"{}","amount":{},"tags":["k{}","k{}"],
        "address":{{"city":"{}","zip":"{}"}},
        "items":[{{"sku":"s{}","qty":{}}},{{"sku":"s{}","qty":{}}}]}}"#,
        i % 1000,
        i % 100,
        STATUSES[(i % 4) as usize],
        canopy_protocol::json::js_number_string(amount),
        i % 13,
        i % 17,
        if i % 2 == 0 { "Lisbon" } else { "Osaka" },
        10_000 + i % 89_999,
        i % 50,
        i % 5,
        (i + 7) % 50,
        (i + 3) % 5,
    );
    let Value::Document(document) = parse(&text, DecodeOptions::default()).expect("document") else {
        unreachable!()
    };
    encode_document(&document).expect("encodes")
}

fn main() {
    let count: u64 =
        std::env::var("CANOPY_BENCH_DOCS").ok().and_then(|text| text.parse().ok()).unwrap_or(200_000);
    let events: Vec<Vec<u8>> = (0..count).map(event).collect();
    let checked: Vec<RawDocument<'_>> =
        events.iter().map(|bytes| RawDocument::new(bytes).expect("raw BSON")).collect();
    for (name, filter) in FILTERS {
        let compiled =
            compile_filter(&parse(filter, DecodeOptions::default()).expect("filter")).expect("compiles");
        let mut best = f64::INFINITY;
        let mut matched = 0;
        for _ in 0..4 {
            matched = 0;
            let start = Instant::now();
            for bytes in &events {
                let raw = RawDocument::new(bytes).expect("raw BSON");
                if compiled.matches_raw(raw).expect("decides") {
                    matched += 1;
                }
            }
            best = best.min(start.elapsed().as_secs_f64());
        }
        let mut matched_only = f64::INFINITY;
        for _ in 0..4 {
            let start = Instant::now();
            let mut hits = 0;
            for raw in &checked {
                if compiled.matches_raw(*raw).expect("decides") {
                    hits += 1;
                }
            }
            assert_eq!(hits, matched);
            matched_only = matched_only.min(start.elapsed().as_secs_f64());
        }
        println!(
            "{name:<28} {:>6.0} ns per event checked and matched, {:>6.0} ns matched only, {matched} matched",
            best * 1e9 / count as f64,
            matched_only * 1e9 / count as f64
        );
    }
}
