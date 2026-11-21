//! Cost of reading change events decoded versus as raw BSON, on events captured from a real change stream
//! (update events with pre and post images), plus the end to end drain rate of a stream per event type.

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use canopy_matcher::{CompiledFilter, compile_filter};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{RawDocument as CanopyRaw, Value, ValueRef};
use mongodb::bson::{Bson, Document, RawDocument, RawDocumentBuf, doc};
use mongodb::change_stream::event::ChangeStreamEvent;
use mongodb::options::{ChangeStreamPreAndPostImages, FullDocumentBeforeChangeType, FullDocumentType};
use mongodb::{Client, Collection, Database};

use crate::common::{Res, fail, next_event};

struct Counting;

static COUNT: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static ALLOCATED: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNT.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            ALLOCATED.fetch_add(layout.size() as u64, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if COUNT.load(Ordering::Relaxed) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            ALLOCATED.fetch_add(new_size as u64, Ordering::Relaxed);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// A named way of reading one event, returning whether it matched.
type Case<'a> = (&'a str, Box<dyn FnMut(&[u8]) -> Res<bool> + 'a>);

const STATUSES: [&str; 4] = ["open", "paid", "shipped", "closed"];

fn base(i: i32) -> Document {
    doc! {
        "_id": i,
        "ownerId": format!("u{}", i % 1000),
        "tenantId": format!("t{}", i % 100),
        "status": STATUSES[(i % 4) as usize],
        "amount": f64::from((i * 7919) % 100_000) / 100.0,
        "tags": [format!("k{}", i % 13), format!("k{}", i % 17)],
        "address": { "city": if i % 2 == 0 { "Lisbon" } else { "Osaka" }, "zip": (10_000 + i % 89_999).to_string() },
        "items": [{ "sku": format!("s{}", i % 50), "qty": i % 5 }, { "sku": format!("s{}", (i + 7) % 50), "qty": (i + 3) % 5 }],
    }
}

fn shaped(size: &str, i: i32) -> Document {
    let mut document = base(i);
    match size {
        "medium" => {
            for field in 0..40 {
                let value = match field % 4 {
                    0 => Bson::Int32(i + field),
                    1 => Bson::Int64(i64::from(i) * 1000 + i64::from(field)),
                    2 => Bson::Double(f64::from(i) / 3.0),
                    _ => Bson::String(format!("value {field} of document {i}")),
                };
                document.insert(format!("f{field}"), value);
            }
        }
        "large" => {
            let lines: Vec<Bson> = (0..200)
                .map(|line| Bson::Document(doc! { "line": line, "sku": format!("s{}", (i + line) % 50), "qty": line % 7, "price": f64::from(line) * 1.25, "note": "x".repeat(24) }))
                .collect();
            document.insert("lines", lines);
        }
        _ => {}
    }
    document
}

async fn capture(db: &Database, size: &str, count: usize) -> Res<Vec<Vec<u8>>> {
    let name = format!("bench_{size}");
    db.create_collection(&name)
        .change_stream_pre_and_post_images(ChangeStreamPreAndPostImages::builder().enabled(true).build())
        .await?;
    let coll: Collection<Document> = db.collection(&name);
    let docs: Vec<Document> = (0..count as i32).map(|i| shaped(size, i)).collect();
    coll.insert_many(docs).await?;
    let mut stream = coll
        .watch()
        .full_document(FullDocumentType::Required)
        .full_document_before_change(FullDocumentBeforeChangeType::Required)
        .await?
        .with_type::<RawDocumentBuf>();
    coll.update_many(doc! {}, doc! { "$inc": { "amount": 1.5 }, "$set": { "status": "open" } }).await?;
    let mut events = Vec::with_capacity(count);
    while events.len() < count {
        events.push(next_event(&mut stream, Duration::from_secs(30)).await?.into_bytes());
    }
    Ok(events)
}

struct Measure {
    ns: f64,
    allocations: f64,
    bytes: f64,
    matched: usize,
}

fn measure(events: &[Vec<u8>], mut each: impl FnMut(&[u8]) -> Res<bool>) -> Res<Measure> {
    let mut matched = 0;
    for bytes in events.iter().take(1000) {
        black_box(each(bytes)?);
    }
    ALLOCATIONS.store(0, Ordering::SeqCst);
    ALLOCATED.store(0, Ordering::SeqCst);
    COUNT.store(true, Ordering::SeqCst);
    for bytes in events {
        if each(bytes)? {
            matched += 1;
        }
    }
    COUNT.store(false, Ordering::SeqCst);
    let allocations = ALLOCATIONS.load(Ordering::SeqCst) as f64 / events.len() as f64;
    let bytes = ALLOCATED.load(Ordering::SeqCst) as f64 / events.len() as f64;
    let mut best = f64::INFINITY;
    let rounds = (200_000 / events.len()).clamp(3, 50);
    for _ in 0..rounds {
        let start = Instant::now();
        for bytes in events {
            black_box(each(bytes)?);
        }
        best = best.min(start.elapsed().as_secs_f64());
    }
    Ok(Measure { ns: best * 1e9 / events.len() as f64, allocations, bytes, matched })
}

fn full_document_value(document: &canopy_protocol::Document) -> Option<&Value> {
    document.get("fullDocument")
}

fn bench_size(size: &str, events: &[Vec<u8>], filter: &CompiledFilter) -> Res<()> {
    let average = events.iter().map(Vec::len).sum::<usize>() / events.len();
    println!("{size}: {} update events with pre and post images, {average} bytes each", events.len());
    let cases: Vec<Case<'_>> = vec![
        (
            "driver typed ChangeStreamEvent<Document>",
            Box::new(|bytes: &[u8]| {
                let event: ChangeStreamEvent<Document> = mongodb::bson::deserialize_from_slice(bytes)?;
                Ok(event
                    .full_document
                    .is_some_and(|d| d.get_str("status").is_ok_and(|status| status == "open")))
            }),
        ),
        (
            "driver bson::Document decode",
            Box::new(|bytes: &[u8]| {
                let event: Document = mongodb::bson::deserialize_from_slice(bytes)?;
                Ok(event
                    .get_document("fullDocument")
                    .is_ok_and(|d| d.get_str("status").is_ok_and(|status| status == "open")))
            }),
        ),
        (
            "canopy decode_document then matcher",
            Box::new(|bytes: &[u8]| {
                let event = decode_document(bytes)?;
                match full_document_value(&event) {
                    Some(value) => Ok(filter.matches_value(value)?),
                    None => fail("no fullDocument"),
                }
            }),
        ),
        (
            "canopy RawDocument::new then matcher in place",
            Box::new(|bytes: &[u8]| {
                let event = CanopyRaw::new(bytes)?;
                match event.get("fullDocument") {
                    Some(ValueRef::Document(canopy_protocol::DocRef::Raw(full))) => {
                        Ok(filter.matches_raw(full)?)
                    }
                    _ => fail("no raw fullDocument"),
                }
            }),
        ),
        (
            "bson RawDocument lazy read of two fields",
            Box::new(|bytes: &[u8]| {
                let event = RawDocument::from_bytes(bytes)?;
                let full = event.get_document("fullDocument")?;
                Ok(full.get_str("status")? == "open" && full.get_f64("amount")? >= 100.0)
            }),
        ),
    ];
    for (name, mut each) in cases {
        let result = measure(events, &mut *each)?;
        println!(
            "  {name:<46} {:>8.0} ns/event {:>7.1} allocations {:>8.0} bytes allocated/event ({} matched)",
            result.ns, result.allocations, result.bytes, result.matched
        );
    }
    Ok(())
}

async fn drain(
    coll: &Collection<Document>,
    start: mongodb::bson::Timestamp,
    count: usize,
    kind: &str,
) -> Res<f64> {
    let watch = coll
        .watch()
        .start_at_operation_time(start)
        .full_document(FullDocumentType::Required)
        .full_document_before_change(FullDocumentBeforeChangeType::Required)
        .batch_size(1000);
    let started = Instant::now();
    match kind {
        "typed" => {
            let mut stream = watch.await?;
            for _ in 0..count {
                black_box(next_event(&mut stream, Duration::from_secs(30)).await?);
            }
        }
        "document" => {
            let mut stream = watch.await?.with_type::<Document>();
            for _ in 0..count {
                black_box(next_event(&mut stream, Duration::from_secs(30)).await?);
            }
        }
        _ => {
            let mut stream = watch.await?.with_type::<RawDocumentBuf>();
            for _ in 0..count {
                let event = next_event(&mut stream, Duration::from_secs(30)).await?;
                black_box(CanopyRaw::new(event.as_bytes())?);
            }
        }
    }
    Ok(count as f64 / started.elapsed().as_secs_f64())
}

pub async fn run(client: Client, count: usize) -> Res<()> {
    let db = client.database("s12_bench");
    db.drop().await?;
    let hello = client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
    println!("server {}", hello.get_str("version").unwrap_or("?"));
    let filter =
        compile_filter(&parse(r#"{"status":"open","amount":{"$gte":100}}"#, DecodeOptions::default())?)?;
    for size in ["small", "medium", "large"] {
        let events = capture(&db, size, count).await?;
        bench_size(size, &events, &filter)?;
    }
    let coll: Collection<Document> = db.collection("bench_medium");
    let mut session = client.start_session().await?;
    db.run_command(doc! { "ping": 1 }).session(&mut session).await?;
    let start = session.operation_time().map_or_else(|| fail("no operation time"), Ok)?;
    coll.update_many(doc! {}, doc! { "$inc": { "amount": 1.0 } }).await?;
    println!("end to end drain of {count} medium update events with images (events per second, best of 3):");
    for kind in ["typed", "document", "raw"] {
        let mut best: f64 = 0.0;
        for _ in 0..3 {
            best = best.max(drain(&coll, start, count, kind).await?);
        }
        println!("  {kind:<9} {best:>10.0}");
    }
    db.drop().await?;
    Ok(())
}
