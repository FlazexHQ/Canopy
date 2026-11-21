//! In process matcher throughput, with the same documents and filters as the TypeScript benchmark
//! (`packages/matcher/bench/throughput.ts`), so the two can be compared on one machine:
//!
//!   cargo run --release -p canopy-matcher --example throughput
//!   bun packages/matcher/bench/throughput.ts
//!
//! `CANOPY_BENCH_DOCS` sets the number of documents (default 1000000); `CANOPY_BENCH_FILTER` runs one filter
//! of your own (EJSON) instead of the standard set.

#![allow(clippy::print_stdout, clippy::expect_used, clippy::cast_precision_loss)]

use std::time::Instant;

use canopy_matcher::compile_filter;
use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{Document, RawDocument, Value};

fn text(value: String) -> Value {
    Value::String(value)
}

fn document(fields: Vec<(&str, Value)>) -> Value {
    Value::Document(fields.into_iter().map(|(name, value)| (name.to_owned(), value)).collect())
}

fn generate(count: u64) -> Vec<Document> {
    const STATUSES: [&str; 4] = ["open", "paid", "shipped", "closed"];
    (0..count)
        .map(|i| {
            let amount = ((i * 2_654_435_761) % 100_000) as f64 / 100.0;
            let Value::Document(doc) = document(vec![
                ("_id", Value::from_js_number(i as f64)),
                ("ownerId", text(format!("u{}", i % 1000))),
                ("tenantId", text(format!("t{}", i % 100))),
                ("status", text(STATUSES[(i % 4) as usize].to_owned())),
                ("amount", Value::from_js_number(amount)),
                ("tags", Value::Array(vec![text(format!("k{}", i % 13)), text(format!("k{}", i % 17))])),
                (
                    "address",
                    document(vec![
                        ("city", text(if i % 2 == 0 { "Lisbon" } else { "Osaka" }.to_owned())),
                        ("zip", text((10_000 + i % 89_999).to_string())),
                    ]),
                ),
                (
                    "items",
                    Value::Array(vec![
                        document(vec![
                            ("sku", text(format!("s{}", i % 50))),
                            ("qty", Value::from_js_number((i % 5) as f64)),
                        ]),
                        document(vec![
                            ("sku", text(format!("s{}", (i + 7) % 50))),
                            ("qty", Value::from_js_number(((i + 3) % 5) as f64)),
                        ]),
                    ]),
                ),
            ]) else {
                unreachable!()
            };
            doc
        })
        .collect()
}

fn main() {
    let count: u64 =
        std::env::var("CANOPY_BENCH_DOCS").ok().and_then(|text| text.parse().ok()).unwrap_or(1_000_000);
    let docs = generate(count);
    let filters = [
        ("equality (DLS owner)", r#"{"ownerId":"u42"}"#),
        ("range and $in", r#"{"amount":{"$gte":100,"$lt":500},"status":{"$in":["open","paid"]}}"#),
        ("$or of 3 branches", r#"{"$or":[{"status":"open"},{"amount":{"$gt":900}},{"tags":"k3"}]}"#),
        ("dotted path", r#"{"address.city":"Lisbon","address.zip":{"$regex":"^1"}}"#),
        ("$elemMatch", r#"{"items":{"$elemMatch":{"sku":"s7","qty":{"$gte":2}}}}"#),
        ("DLS and user filter", r#"{"$and":[{"tenantId":"t8"},{"status":"open","amount":{"$lt":250}}]}"#),
    ];
    let custom = std::env::var("CANOPY_BENCH_FILTER").ok();
    let selected: Vec<(&str, &str)> = match &custom {
        Some(filter) => vec![("custom", filter.as_str())],
        None => filters.to_vec(),
    };
    for (name, filter) in selected {
        let compiled =
            compile_filter(&parse(filter, DecodeOptions::default()).expect("filter")).expect("compiles");
        for doc in docs.iter().take(100_000) {
            let _ = compiled.matches(doc);
        }
        let mut best = f64::INFINITY;
        let mut matched = 0;
        for _ in 0..3 {
            matched = 0;
            let start = Instant::now();
            for doc in &docs {
                if compiled.matches(doc).expect("decides") {
                    matched += 1;
                }
            }
            best = best.min(start.elapsed().as_secs_f64());
        }
        println!("{name:<28} {:.2} M evals/s, {matched} matched", count as f64 / best / 1e6);
    }
    let events: Vec<Vec<u8>> =
        docs.iter().take(200_000).map(|doc| encode_document(doc).expect("encodes")).collect();
    println!("per change event, BSON decoded then matched ({} events):", events.len());
    for (name, filter) in filters {
        let compiled =
            compile_filter(&parse(filter, DecodeOptions::default()).expect("filter")).expect("compiles");
        let mut best = f64::INFINITY;
        let mut matched = 0;
        for _ in 0..3 {
            matched = 0;
            let start = Instant::now();
            for bytes in &events {
                let doc = decode_document(bytes).expect("decodes");
                if compiled.matches(&doc).expect("decides") {
                    matched += 1;
                }
            }
            best = best.min(start.elapsed().as_secs_f64());
        }
        println!("{name:<28} {:.0} ns per event, {matched} matched", best * 1e9 / events.len() as f64);
    }
    println!("per change event, raw BSON checked then matched in place ({} events):", events.len());
    for (name, filter) in filters {
        let compiled =
            compile_filter(&parse(filter, DecodeOptions::default()).expect("filter")).expect("compiles");
        let mut best = f64::INFINITY;
        let mut matched = 0;
        for _ in 0..3 {
            matched = 0;
            let start = Instant::now();
            for bytes in &events {
                let doc = RawDocument::new(bytes).expect("valid");
                if compiled.matches_raw(doc).expect("decides") {
                    matched += 1;
                }
            }
            best = best.min(start.elapsed().as_secs_f64());
        }
        println!("{name:<28} {:.0} ns per event, {matched} matched", best * 1e9 / events.len() as f64);
    }
    let rounds = 100_000;
    let start = Instant::now();
    for i in 0..rounds {
        let filter = format!(r#"{{"ownerId":"u{i}","amount":{{"$gte":{}}}}}"#, i % 100);
        let _ = compile_filter(&parse(&filter, DecodeOptions::default()).expect("filter"));
    }
    println!(
        "compile {:.2} us per filter (EJSON parse included)",
        start.elapsed().as_secs_f64() * 1e6 / f64::from(rounds)
    );
}
