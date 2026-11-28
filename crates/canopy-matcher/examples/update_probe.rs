//! Native cost of one optimistic update, phase by phase: decoding the update and the document, cloning the
//! document, applying the update and encoding the result. The document is the six field note of the R2 engine
//! benchmark and the update is `{ $set: { title: "edited" }, $inc: { n: 1 } }`.
//!
//! Run with `cargo run -j 2 --release -p canopy-matcher --example update_probe`.

#![allow(clippy::print_stdout, clippy::unwrap_used, missing_docs)]

use std::hint::black_box;
use std::time::Instant;

use canopy_matcher::update::{UpdateOptions, apply_update};
use canopy_protocol::bson::{decode_document, encode_document};
use canopy_protocol::{Document, Value};

const ITERATIONS: u32 = 200_000;
const ROUNDS: usize = 9;

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn note() -> Document {
    let mut document = Document::new();
    document.insert("_id", text("6728f0c2a1b2c3d4e5f60711"));
    document.insert("title", text("a note"));
    document.insert("body", text("some text in the note"));
    document.insert("n", Value::Int32(1));
    document.insert("tags", Value::Array(vec![text("a"), text("b")]));
    document.insert("public", Value::Bool(true));
    document
}

fn update() -> Document {
    let mut set = Document::new();
    set.insert("title", text("edited"));
    let mut inc = Document::new();
    inc.insert("n", Value::Int32(1));
    let mut update = Document::new();
    update.insert("$set", Value::Document(set));
    update.insert("$inc", Value::Document(inc));
    update
}

fn nanoseconds(mut step: impl FnMut()) -> f64 {
    let mut samples = Vec::with_capacity(ROUNDS);
    for _ in 0..ROUNDS {
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            step();
        }
        samples.push(start.elapsed().as_secs_f64() * 1e9 / f64::from(ITERATIONS));
    }
    samples.sort_by(f64::total_cmp);
    samples[ROUNDS / 2]
}

fn main() {
    let document_bytes = encode_document(&note()).unwrap();
    let update_bytes = encode_document(&update()).unwrap();
    let document = decode_document(&document_bytes).unwrap();
    let update = Value::Document(decode_document(&update_bytes).unwrap());
    let options = UpdateOptions { is_insert: false, array_filters: Vec::new(), now: Some(0) };
    let result = apply_update(&document, &update, &options).unwrap();
    assert_eq!(result.get("n"), Some(&Value::Int32(2)));

    let decode_update = nanoseconds(|| {
        black_box(decode_document(black_box(&update_bytes)).unwrap());
    });
    let decode = nanoseconds(|| {
        black_box(decode_document(black_box(&document_bytes)).unwrap());
    });
    let clone = nanoseconds(|| {
        black_box(black_box(&document).clone());
    });
    let apply = nanoseconds(|| {
        black_box(apply_update(black_box(&document), black_box(&update), &options).unwrap());
    });
    let encode = nanoseconds(|| {
        black_box(encode_document(black_box(&result)).unwrap());
    });
    let pipeline = nanoseconds(|| {
        let document = decode_document(black_box(&document_bytes)).unwrap();
        let update = Value::Document(decode_document(black_box(&update_bytes)).unwrap());
        let result = apply_update(&document, &update, &options).unwrap();
        black_box(encode_document(&result).unwrap());
    });
    println!("decode update   {decode_update:8.1} ns");
    println!("decode document {decode:8.1} ns");
    println!("clone document  {clone:8.1} ns");
    println!("apply update    {apply:8.1} ns");
    println!("encode document {encode:8.1} ns");
    println!("whole pipeline  {pipeline:8.1} ns");
}
