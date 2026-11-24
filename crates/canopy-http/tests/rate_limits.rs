//! The request rate limits on the Rust routes, as the TypeScript handler applies them: a caller over its budget
//! gets `429` with `Retry-After` and the wait in the details, anonymous callers are counted per client address,
//! an address that used up its failed authentications is refused before its credentials are checked (an
//! expired token does not count), and `service` is exempt. Every request here stops before any read: `_distinct`
//! with a field that is not a string fails after the caller is resolved, so no database is needed.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use canopy_auth::{BucketSpec, RateLimitOptions, RateLimits};
use canopy_data::{Policies, ReadPath};
use canopy_http::{Request, Response, Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_protocol::json::{Json, parse_json};
use common::{authenticator, engine, entries, fixture, read_limits};

/// One token per second for no more than `burst`: within a test the budget never refills.
async fn limited(requests: f64, failures: f64, exempt_service: bool) -> (Rest, Arc<AtomicU64>) {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200").await.unwrap();
    let fixture = fixture();
    let reads = ReadPath::new(client, "unreachable", Policies::new(engine(&fixture)), read_limits(&fixture));
    let served = Served {
        find: true,
        count: true,
        distinct: true,
        aggregate: true,
        query: true,
        explain: true,
        writes: false,
    };
    let limits = RateLimits::new(RateLimitOptions {
        requests: BucketSpec { per_second: 0.001, burst: requests },
        failed_authentications: BucketSpec { per_second: 0.001, burst: failures },
        exempt_service,
        ..RateLimitOptions::default()
    });
    let refused = Arc::new(AtomicU64::new(0));
    let counter = Arc::clone(&refused);
    let count: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let rest = Rest::new(authenticator(&fixture), reads, RestOptions { served, ..RestOptions::default() })
        .with_rate_limits(Arc::new(limits), Some(count));
    (rest, refused)
}

fn distinct(caller: &str, address: &str) -> Request {
    let fixture = fixture();
    let (_, headers) = entries(&fixture, "callers").iter().find(|(name, _)| name == caller).unwrap();
    let Json::Object(headers) = headers else { panic!("headers") };
    let mut request = Request::new("POST", "/rest/v1/todos/_distinct").with_body(b"{\"field\":1}".to_vec());
    for (name, value) in headers {
        let Json::String(value) = value else { panic!("{name}") };
        request = request.with_header(name.clone(), value.clone());
    }
    request.client_address = Some(address.to_owned());
    request.with_header("content-type", "application/json")
}

async fn send(rest: &Rest, caller: &str, address: &str) -> Response {
    rest.serve(&distinct(caller, address)).await.expect("served")
}

fn code(response: &Response) -> String {
    let body = parse_json(std::str::from_utf8(&response.body).unwrap()).unwrap();
    match body.get("code") {
        Some(Json::String(code)) => code.clone(),
        other => panic!("no code: {other:?}"),
    }
}

#[tokio::test]
async fn a_caller_over_its_budget_gets_429_with_the_wait() {
    let (rest, refused) = limited(2.0, 30.0, true).await;
    for _ in 0..2 {
        assert_eq!(
            send(&rest, "alice", "10.0.0.1").await.status,
            400,
            "within the budget the request goes on"
        );
    }
    let limited = send(&rest, "alice", "10.0.0.9").await;
    assert_eq!(limited.status, 429, "the budget is the caller's, whatever the address");
    assert_eq!(limited.header("retry-after"), Some("1000"));
    let body = String::from_utf8(limited.body.clone()).unwrap();
    assert!(body.contains(r#""detail":"Too many requests. Retry in 1000 seconds.""#), "{body}");
    assert!(body.contains(r#""details":{"retryAfterSeconds":1000}"#), "{body}");
    assert_eq!(code(&limited), "CANOPY_RATE_LIMITED");
    assert_eq!(send(&rest, "bob", "10.0.0.1").await.status, 400, "another caller has its own budget");
    assert_eq!(refused.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn anonymous_callers_are_counted_per_address_and_service_is_exempt() {
    let (rest, _) = limited(1.0, 30.0, true).await;
    assert_eq!(send(&rest, "anon", "10.0.0.1").await.status, 400);
    assert_eq!(send(&rest, "anon", "10.0.0.1").await.status, 429);
    assert_eq!(
        send(&rest, "anon", "10.0.0.2").await.status,
        400,
        "another address is another anonymous caller"
    );
    for _ in 0..3 {
        assert_eq!(send(&rest, "service", "10.0.0.1").await.status, 400, "service is exempt");
    }
    let (strict, _) = limited(1.0, 30.0, false).await;
    assert_eq!(send(&strict, "service", "10.0.0.1").await.status, 400);
    assert_eq!(send(&strict, "service", "10.0.0.1").await.status, 429, "unless the exemption is off");
}

#[tokio::test]
async fn failed_authentications_block_the_address_before_its_credentials_are_checked() {
    let (rest, refused) = limited(100.0, 2.0, true).await;
    for _ in 0..2 {
        assert_eq!(code(&send(&rest, "tampered", "10.0.0.1").await), "CANOPY_UNAUTHORIZED");
    }
    for _ in 0..3 {
        assert_eq!(code(&send(&rest, "expired", "10.0.0.2").await), "CANOPY_TOKEN_EXPIRED");
    }
    let blocked = send(&rest, "alice", "10.0.0.1").await;
    assert_eq!(blocked.status, 429, "a valid caller from the blocked address is refused too");
    assert!(blocked.header("retry-after").is_some());
    assert_eq!(send(&rest, "alice", "10.0.0.2").await.status, 400, "expired tokens do not count");
    assert_eq!(send(&rest, "unknown-key", "10.0.0.3").await.status, 401);
    assert_eq!(refused.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn without_limits_nothing_is_counted() {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200").await.unwrap();
    let fixture = fixture();
    let reads = ReadPath::new(client, "unreachable", Policies::new(engine(&fixture)), read_limits(&fixture));
    let served = Served {
        find: true,
        count: true,
        distinct: true,
        aggregate: true,
        query: true,
        explain: true,
        writes: false,
    };
    let rest = Rest::new(authenticator(&fixture), reads, RestOptions { served, ..RestOptions::default() });
    for _ in 0..50 {
        assert_eq!(send(&rest, "anon", "10.0.0.1").await.status, 400);
        assert_eq!(code(&send(&rest, "tampered", "10.0.0.1").await), "CANOPY_UNAUTHORIZED");
    }
}
