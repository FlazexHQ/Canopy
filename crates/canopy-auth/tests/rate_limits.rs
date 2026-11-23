//! Replays `conformance/auth/rate-limits.json`, recorded from `@canopy/auth` (`bun run vectors:rate-limits`): the
//! token buckets and the request limits must answer every operation of the seeded sequences, on the same fake
//! clock, with the same wait in milliseconds and keep the same number of keys, and the rate limit error must
//! read the same.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use canopy_auth::{
    BucketSpec, Clock, RateLimitOptions, RateLimits, TokenBuckets, rate_limit_error, retry_after_seconds,
};
use canopy_policy::Roles;
use canopy_protocol::json::{Json, parse_json};

fn number(json: &Json) -> f64 {
    match json {
        Json::Number(number) => *number,
        other => panic!("expected a number, got {other:?}"),
    }
}

fn text(json: &Json) -> &str {
    match json {
        Json::String(text) => text,
        other => panic!("expected a string, got {other:?}"),
    }
}

fn items(json: &Json) -> &[Json] {
    match json {
        Json::Array(items) => items,
        other => panic!("expected an array, got {other:?}"),
    }
}

fn field<'a>(json: &'a Json, name: &str) -> &'a Json {
    json.get(name).unwrap_or_else(|| panic!("no {name}"))
}

fn spec(json: &Json) -> BucketSpec {
    BucketSpec { per_second: number(field(json, "perSecond")), burst: number(field(json, "burst")) }
}

/// A clock the replay sets, holding milliseconds as the bits of an `f64`.
fn clock() -> (Clock, Arc<AtomicU64>) {
    let at = Arc::new(AtomicU64::new(0));
    let read = Arc::clone(&at);
    (Arc::new(move || f64::from_bits(read.load(Ordering::SeqCst))), at)
}

fn replay_buckets(index: usize, case: &Json, mismatches: &mut Vec<String>) {
    let (now, at) = clock();
    let max_keys = number(field(case, "maxKeys")) as usize;
    let buckets = TokenBuckets::new(spec(field(case, "spec")), max_keys, now);
    for (step, (op, expected)) in
        items(field(case, "ops")).iter().zip(items(field(case, "results"))).enumerate()
    {
        let [kind, time, key, cost] = items(op) else { panic!("an operation") };
        at.store(number(time).to_bits(), Ordering::SeqCst);
        let wait = match text(kind) {
            "take" => buckets.take(text(key), number(cost)),
            _ => buckets.peek(text(key), number(cost)),
        };
        let [want, size] = items(expected) else { panic!("a result") };
        if wait as f64 != number(want) || buckets.len() as f64 != number(size) {
            mismatches.push(format!(
                "case {index} step {step}: {op:?} gave {wait} with {} keys, expected {expected:?}",
                buckets.len()
            ));
        }
    }
}

fn replay_limits(index: usize, case: &Json, mismatches: &mut Vec<String>) {
    let (now, at) = clock();
    let limits = RateLimits::new(RateLimitOptions {
        requests: spec(field(case, "requests")),
        failed_authentications: spec(field(case, "failedAuthentications")),
        exempt_service: matches!(field(case, "exemptService"), Json::Bool(true)),
        max_keys: number(field(case, "maxKeys")) as usize,
        now,
    });
    for (step, (op, expected)) in
        items(field(case, "ops")).iter().zip(items(field(case, "results"))).enumerate()
    {
        let op_items = items(op);
        at.store(number(&op_items[1]).to_bits(), Ordering::SeqCst);
        let wait = match text(&op_items[0]) {
            "request" => {
                let key = match &op_items[2] {
                    Json::String(key) => Some(key.as_str()),
                    _ => None,
                };
                let roles: Roles = items(&op_items[4]).iter().map(|role| text(role).to_owned()).collect();
                Some(limits.request(key, text(&op_items[3]), &roles, text(&op_items[5])))
            }
            "blocked" => Some(limits.authentication_blocked(text(&op_items[2]))),
            _ => {
                limits.authentication_failed(text(&op_items[2]));
                None
            }
        };
        let want = match expected {
            Json::Null => None,
            other => Some(number(other) as u64),
        };
        if wait != want {
            mismatches.push(format!("case {index} step {step}: {op:?} gave {wait:?}, expected {want:?}"));
        }
    }
}

fn replay_error(index: usize, case: &Json, mismatches: &mut Vec<String>) {
    let wait = number(field(case, "waitMs")) as u64;
    let error = rate_limit_error(wait);
    let seconds = number(field(case, "seconds"));
    let actual = (
        retry_after_seconds(wait) as f64,
        error.name(),
        error.code().as_str(),
        error.message(),
        error.details().map(str::to_owned),
    );
    let expected = (
        seconds,
        text(field(case, "name")),
        text(field(case, "code")),
        text(field(case, "message")),
        Some(format!("{{\"retryAfterSeconds\":{seconds}}}")),
    );
    if actual != expected {
        mismatches.push(format!("case {index}: {actual:?}, expected {expected:?}"));
    }
}

#[test]
fn the_rate_limits_answer_as_the_typescript_ones() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/auth/rate-limits.json");
    let recorded = parse_json(&std::fs::read_to_string(path).expect("the vectors")).expect("JSON");
    let mut counts = [0usize; 3];
    let mut mismatches = Vec::new();
    for (index, case) in items(field(&recorded, "cases")).iter().enumerate() {
        match text(field(case, "kind")) {
            "buckets" => {
                counts[0] += 1;
                replay_buckets(index, case, &mut mismatches);
            }
            "limits" => {
                counts[1] += 1;
                replay_limits(index, case, &mut mismatches);
            }
            "error" => {
                counts[2] += 1;
                replay_error(index, case, &mut mismatches);
            }
            other => panic!("unknown case kind {other}"),
        }
    }
    assert!(counts.iter().all(|count| *count > 5), "every kind is recorded: {counts:?}");
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches[..mismatches.len().min(15)].join("\n")
    );
}
