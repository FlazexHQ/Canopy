//! Replays `conformance/http/graphql`, recorded from the TypeScript GraphQL handler (`bun run
//! vectors:http-graphql`): every case runs on a freshly seeded database, and the responses and the documents the
//! mutation cases leave must be what the TypeScript handler gave. The message of a parse or validation error is
//! compared only for its kind, because graphql-js wording is not reproduced; everything else is compared byte for
//! byte, cluster times aside. It needs a MongoDB replica set in `CANOPY_TEST_MONGODB_URI` and is skipped
//! without one.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../../canopy-http/tests/common/mod.rs"]
mod common;

use std::collections::HashMap;
use std::sync::Arc;

use canopy_data::writes::WritePath;
use canopy_data::{Policies, ReadPath};
use canopy_graphql::build::{CollectionConfig, RelationConfig};
use canopy_graphql::endpoint::{Graphql, GraphqlOptions, IntrospectionMode, PersistedOperations};
use canopy_graphql::limits::OperationLimits;
use canopy_http::{Rest, RestOptions, Served};
use canopy_mongo::mongodb::Client;
use canopy_protocol::json::Json;
use common::{
    authenticator, directory_of, engine, entries, get, mongodb_uri, read_json, read_limits, scratch_name,
    text, text_of,
};
use graphql_replay::number;

mod graphql_replay;

fn options(fixture: &Json) -> GraphqlOptions {
    let limits = get(fixture, "limits");
    let mut collections = HashMap::new();
    for (name, config) in entries(fixture, "relations") {
        let relations = entries(config, "relations")
            .iter()
            .map(|(field, relation)| {
                (
                    field.clone(),
                    RelationConfig {
                        to: text(relation, "to").to_owned(),
                        local: text(relation, "local").to_owned(),
                        foreign: relation.get("foreign").map(|foreign| match foreign {
                            Json::String(foreign) => foreign.clone(),
                            other => panic!("foreign {other:?}"),
                        }),
                        many: matches!(relation.get("many"), Some(Json::Bool(true))),
                    },
                )
            })
            .collect();
        collections.insert(name.clone(), CollectionConfig { type_name: None, relations });
    }
    let persisted = get(fixture, "persisted");
    GraphqlOptions {
        path: text(fixture, "basePath").to_owned(),
        limits: OperationLimits {
            max_depth: number(limits, "maxDepth") as u32,
            max_complexity: number(limits, "maxComplexity"),
            max_aliases: number(limits, "maxAliases") as u32,
        },
        max_batch: number(fixture, "maxBatch") as usize,
        max_body_bytes: number(fixture, "maxBodyBytes") as u64,
        introspection: match text(fixture, "introspection") {
            "always" => IntrospectionMode::Always,
            "authenticated" => IntrospectionMode::Authenticated,
            _ => IntrospectionMode::Never,
        },
        persisted: Some(PersistedOperations {
            operations: entries(persisted, "operations")
                .iter()
                .map(|(hash, query)| (hash.clone(), text_of(query)))
                .collect(),
            only: matches!(persisted.get("only"), Some(Json::Bool(true))),
        }),
        collections,
        ..GraphqlOptions::default()
    }
}

fn endpoint(client: &Client, database: &str, meta: &str, fixture: &Json) -> Graphql {
    let policies = Policies::new(engine(fixture));
    let reads = ReadPath::new(client.clone(), database, policies.clone(), read_limits(fixture));
    let writes = WritePath::new(client.clone(), database, meta, policies).expect("a write path");
    let rest = Rest::new(
        authenticator(fixture),
        reads,
        RestOptions { served: Served { find: false, ..Served::default() }, ..RestOptions::default() },
    )
    .with_writes(Arc::new(writes), HashMap::new());
    Graphql::new(Arc::new(rest), options(fixture))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_graphql_request_is_answered_as_typescript_answered_it() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let dir = directory_of("graphql");
    let fixture = read_json(&dir.join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = scratch_name("canopy_graphql_rs");
    let meta = format!("{database}_meta");
    graphql_replay::replay(
        &client,
        &database,
        &meta,
        &fixture,
        async || endpoint(&client, &database, &meta, &fixture),
        async |graphql: &Graphql, request| graphql.serve(request).await,
    )
    .await;
}
