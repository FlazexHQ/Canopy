//! Replays `conformance/http/storage`, recorded from the TypeScript storage handler (`bun run
//! vectors:http-storage`): every case runs on a fresh scratch database and local backend folder, and every
//! response (status, the recorded headers and the body bytes) and the `storage_objects` documents a case leaves
//! must be what the TypeScript handler gave, after the substitutions the oracle documents. It needs a MongoDB
//! replica set in `CANOPY_TEST_MONGODB_URI` and is skipped without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../../canopy-http/tests/common/mod.rs"]
mod common;

mod storage_replay;

use storage_replay::number;

use std::collections::HashMap;
use std::sync::Arc;

use canopy_auth::{BucketSpec, RateLimitOptions, RateLimits};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Cors, Response, Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_mongo::policies_from_stored;
use canopy_policy::PolicyEngine;
use canopy_protocol::json::Json;
use canopy_storage::http::{StorageAnswer, StorageHandler};
use canopy_storage::local::LocalBackend;
use canopy_storage::storage::{BucketSettings, Storage, StorageOptions};
use canopy_storage::tokens::UrlSigner;
use common::{authenticator, directory_of, entries, get, list, mongodb_uri, read_json};
use futures_util::StreamExt;

fn engine(fixture: &Json) -> PolicyEngine {
    let policies = get(fixture, "policies");
    let set = policies_from_stored(
        list(policies, "collections"),
        policies
            .get("contexts")
            .filter(|contexts| !matches!(contexts, Json::Array(items) if items.is_empty())),
    )
    .expect("the fixture policies are valid");
    PolicyEngine::new(set)
}

async fn build(
    client: &Client,
    database: &str,
    meta: &str,
    fixture: &Json,
    folder: &std::path::Path,
    rate_limited: bool,
) -> StorageHandler {
    let policies = Policies::new(engine(fixture));
    let reads = ReadPath::new(client.clone(), database, policies.clone(), ReadLimits::default());
    let mut rest = Rest::new(
        authenticator(fixture),
        reads,
        RestOptions { served: Served { find: false, ..Served::default() }, ..RestOptions::default() },
    );
    if rate_limited {
        let limits = get(fixture, "rateLimited");
        let requests = get(limits, "requests");
        let now = number(limits, "now");
        rest = rest.with_rate_limits(
            Arc::new(RateLimits::new(RateLimitOptions {
                requests: BucketSpec {
                    per_second: number(requests, "perSecond"),
                    burst: number(requests, "burst"),
                },
                now: Arc::new(move || now),
                ..RateLimitOptions::default()
            })),
            None,
        );
    }
    let backend = LocalBackend::new(folder).expect("a local backend");
    let buckets = entries(fixture, "buckets")
        .iter()
        .map(|(name, bucket)| {
            let settings = BucketSettings {
                public: matches!(bucket.get("public"), Some(Json::Bool(true))),
                max_file_size: number(bucket, "maxFileSize") as u64,
                allowed_types: list(bucket, "allowedTypes")
                    .iter()
                    .map(|kind| match kind {
                        Json::String(kind) => kind.clone(),
                        other => panic!("{other:?}"),
                    })
                    .collect(),
            };
            (name.clone(), settings)
        })
        .collect::<HashMap<_, _>>();
    let (_, max_upload_size, upload_ttl_ms, max_signed_url_seconds) = Storage::default_limits();
    let storage = Storage::new(StorageOptions {
        client: client.clone(),
        meta_database: meta.to_owned(),
        policies,
        backend: Arc::new(backend),
        buckets,
        signer: UrlSigner::new(Some(common::text(fixture, "signingMasterKey"))),
        part_size: number(fixture, "partSize") as u64,
        max_upload_size,
        upload_ttl_ms,
        max_signed_url_seconds,
    })
    .expect("a storage");
    let cors = fixture.get("cors").map(|cors| match cors.get("origins") {
        Some(Json::Array(origins)) => Cors::Origins(
            origins
                .iter()
                .map(|origin| match origin {
                    Json::String(origin) => origin.clone(),
                    other => panic!("{other:?}"),
                })
                .collect(),
        ),
        _ => Cors::Any,
    });
    StorageHandler::new(Arc::new(storage), Arc::new(rest), common::text(fixture, "basePath"), cors)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_storage_request_is_answered_as_typescript_answered_it() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = read_json(&directory_of("storage").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    storage_replay::replay(
        &client,
        &fixture,
        false,
        async |database, meta, folder, rate_limited| {
            build(&client, database, meta, &fixture, folder, rate_limited).await
        },
        async |handler: &StorageHandler, request| match handler.serve(request).await? {
            StorageAnswer::Response(response) => Some(response),
            StorageAnswer::File { status, headers, mut body } => {
                let mut bytes = Vec::new();
                while let Some(chunk) = body.next().await {
                    bytes.extend(chunk.expect("a readable file"));
                }
                Some(Response { status, headers, body: bytes })
            }
        },
    )
    .await;
}
