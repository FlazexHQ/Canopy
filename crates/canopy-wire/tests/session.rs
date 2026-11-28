//! Driver handshake and authentication command tests.
#![allow(clippy::unwrap_used)]

mod common;

use std::net::Ipv4Addr;
use std::sync::Arc;

use canopy_auth::{Authenticator, BucketSpec, RateLimitOptions, RateLimits};
use canopy_mongo::mongodb::bson::{Binary, DateTime, Document, doc, spec::BinarySubtype};
use canopy_wire::Session;
use canopy_wire::frame::{Compressor, Message, encode_op_msg, parse_message};

const LIMIT: usize = 48_000_000;

fn session() -> Session {
    Session::new(common::authenticator(), None, Ipv4Addr::LOCALHOST.into(), 4976)
}

fn request(body: &Document) -> Message {
    parse_message(&encode_op_msg(42, 0, body).unwrap(), LIMIT).unwrap()
}

async fn command(session: &mut Session, body: Document) -> Document {
    let response = session.handle(request(&body)).await.unwrap().unwrap();
    let message = parse_message(&response, LIMIT).unwrap();
    assert_eq!(message.header.response_to, 42);
    message.body
}

fn sasl(mechanism: &str, bytes: Vec<u8>) -> Document {
    doc! {
        "saslStart": 1,
        "mechanism": mechanism,
        "payload": Binary { subtype: BinarySubtype::Generic, bytes },
        "$db": "$external",
    }
}

#[tokio::test]
async fn router_hello_matches_mongodb_8_limits() {
    let mut session = session();
    for (name, writable, absent) in [
        ("hello", "isWritablePrimary", "ismaster"),
        ("isMaster", "ismaster", "isWritablePrimary"),
        ("ismaster", "ismaster", "isWritablePrimary"),
    ] {
        let before = DateTime::now();
        let mut reply = command(
            &mut session,
            doc! { (name): 1, "helloOk": true, "saslSupportedMechs": "admin.service",
            "speculativeAuthenticate": { "saslStart": 1 } },
        )
        .await;
        assert!((before..=DateTime::now()).contains(reply.get_datetime("localTime").unwrap()));
        reply.remove("localTime");
        assert_eq!(
            reply,
            doc! {
                "msg": "isdbgrid", "maxBsonObjectSize": 16_777_216, "maxMessageSizeBytes": 48_000_000,
                "maxWriteBatchSize": 100_000, "logicalSessionTimeoutMinutes": 30, "connectionId": 4976_i64,
                "minWireVersion": 0, "maxWireVersion": 25, "readOnly": false, "ok": 1.0,
                (writable): true, "helloOk": true, "saslSupportedMechs": ["SCRAM-SHA-256"],
            }
        );
        assert!(!reply.contains_key(absent));
    }
    let reply = command(&mut session, doc! { "hello": 1, "saslSupportedMechs": "admin.unknown" }).await;
    assert!(reply.get_array("saslSupportedMechs").unwrap().is_empty());
    assert!(!reply.contains_key("helloOk"));
    assert_eq!(command(&mut session, doc! { "buildInfo": 1 }).await.get_str("version").unwrap(), "8.0.34");
}

#[tokio::test]
async fn hello_negotiates_supported_compressors_in_client_order() {
    let mut session = session();
    let reply = command(&mut session, doc! { "hello": 1 }).await;
    assert!(!reply.contains_key("compression"));
    assert!(session.compressors().is_empty());

    let reply = command(
        &mut session,
        doc! {
            "isMaster": 1, "compression": ["zlib", "noop", "zstd", "snappy", "zlib", "unknown"],
        },
    )
    .await;
    assert_eq!(reply.get_array("compression").unwrap(), &vec!["zlib".into(), "zstd".into(), "snappy".into()]);
    assert_eq!(session.compressors(), &[Compressor::Zlib, Compressor::Zstd, Compressor::Snappy]);

    let reply = command(&mut session, doc! { "hello": 1 }).await;
    assert!(!reply.contains_key("compression"));
    assert_eq!(session.compressors(), &[Compressor::Zlib, Compressor::Zstd, Compressor::Snappy]);

    let reply = command(&mut session, doc! { "hello": 1, "compression": ["unknown"] }).await;
    assert!(reply.get_array("compression").unwrap().is_empty());
    assert!(session.compressors().is_empty());
}

#[tokio::test]
async fn legacy_hello_gets_op_reply() {
    let mut session = session();
    let mut frame = Vec::from([0; 16]);
    frame.extend_from_slice(&0i32.to_le_bytes());
    frame.extend_from_slice(b"admin.$cmd\0");
    frame.extend_from_slice(&0i32.to_le_bytes());
    frame.extend_from_slice(&(-1i32).to_le_bytes());
    frame.extend_from_slice(&doc! { "ismaster": 1 }.to_vec().unwrap());
    let length = i32::try_from(frame.len()).unwrap();
    frame[..4].copy_from_slice(&length.to_le_bytes());
    frame[4..8].copy_from_slice(&42i32.to_le_bytes());
    frame[12..16].copy_from_slice(&2004i32.to_le_bytes());
    let message = parse_message(&frame, LIMIT).unwrap();
    let reply = session.handle(message).await.unwrap().unwrap();
    assert_eq!(i32::from_le_bytes(reply[12..16].try_into().unwrap()), 1);
    assert_eq!(i32::from_le_bytes(reply[8..12].try_into().unwrap()), 42);
    let body = Document::from_reader(&reply[36..]).unwrap();
    assert!(body.get_bool("ismaster").unwrap());
    assert_eq!(body.get_str("msg").unwrap(), "isdbgrid");
}

#[tokio::test]
async fn scram_without_configured_keys_uses_a_decoy_challenge() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let auth = Authenticator::new(None, None, Vec::new(), reqwest::Client::new()).unwrap();
    let mut session = Session::new(auth, None, Ipv4Addr::LOCALHOST.into(), 1);
    let reply = command(&mut session, sasl("SCRAM-SHA-256", b"n,,n=service,r=clientNonce".to_vec())).await;
    assert!(!reply.get_bool("done").unwrap());
    let challenge = std::str::from_utf8(reply.get_binary_generic("payload").unwrap()).unwrap();
    let nonce = challenge.split(',').next().unwrap();
    let proof = format!("c=biws,{nonce},p=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    let refused = command(
        &mut session,
        doc! {
            "saslContinue": 1,
            "conversationId": reply.get_i32("conversationId").unwrap(),
            "payload": Binary { subtype: BinarySubtype::Generic, bytes: proof.into_bytes() },
            "$db": "admin",
        },
    )
    .await;
    assert_eq!(refused.get_i32("code").unwrap(), 18);
    assert_eq!(refused.get_str("errmsg").unwrap(), "Authentication failed.");
    assert!(session.principal().is_none());
}

#[tokio::test]
async fn refuses_data_commands_and_suppresses_more_to_come_reply() {
    let mut session = session();
    let body = doc! { "find": "notes", "$db": "app" };
    let denied = command(&mut session, body.clone()).await;
    assert_eq!(
        denied,
        doc! {
            "ok": 0.0, "errmsg": "Command find requires authentication", "code": 13, "codeName": "Unauthorized",
        }
    );
    let mut message = request(&body);
    message.more_to_come = true;
    assert!(session.handle(message).await.unwrap().is_none());
}

#[tokio::test]
async fn oidc_token_alone_authenticates_with_claimed_roles() {
    let mut session = session();
    let token = common::token(DateTime::now().timestamp_millis() / 1000 + 600);
    let reply = command(&mut session, sasl("MONGODB-OIDC", doc! { "jwt": token }.to_vec().unwrap())).await;
    assert!(reply.get_bool("done").unwrap());
    assert!(reply.get_binary_generic("payload").unwrap().is_empty());
    let principal = session.principal().unwrap();
    assert_eq!(principal.subject, "oidc-user");
    assert_eq!(principal.roles.len(), 2);
    assert!(principal.roles.contains("authenticated"));
    assert!(principal.roles.contains("editor"));
    let unknown = command(&mut session, doc! { "find": "notes" }).await;
    assert_eq!(unknown.get_i32("code").unwrap(), 59);
}

#[tokio::test]
async fn oidc_requests_reauthentication_for_expired_token() {
    let mut session = session();
    let token = common::token(DateTime::now().timestamp_millis() / 1000 - 60);
    let reply = command(&mut session, sasl("MONGODB-OIDC", doc! { "jwt": token }.to_vec().unwrap())).await;
    assert_eq!(reply.get_i32("code").unwrap(), 391);
    assert_eq!(reply.get_str("codeName").unwrap(), "ReauthenticationRequired");
    assert!(session.principal().is_none());
}

#[tokio::test]
async fn oidc_rejects_tampered_signature() {
    let mut session = session();
    let mut token = common::token(DateTime::now().timestamp_millis() / 1000 + 600);
    let offset = token.rfind('.').unwrap() + 1;
    let replacement = if token.as_bytes()[offset] == b'A' { "B" } else { "A" };
    token.replace_range(offset..offset + 1, replacement);
    let reply = command(&mut session, sasl("MONGODB-OIDC", doc! { "jwt": token }.to_vec().unwrap())).await;
    assert_eq!(reply.get_i32("code").unwrap(), 18);
    assert_eq!(reply.get_str("errmsg").unwrap(), "Authentication failed.");
    assert!(session.principal().is_none());
}

#[tokio::test]
async fn unsupported_mechanism_consumes_shared_address_budget() {
    let limits = Arc::new(RateLimits::new(RateLimitOptions {
        failed_authentications: BucketSpec { per_second: 1.0, burst: 1.0 },
        now: Arc::new(|| 0.0),
        ..RateLimitOptions::default()
    }));
    let address = Ipv4Addr::LOCALHOST;
    let mut session = Session::new(common::authenticator(), Some(limits.clone()), address.into(), 1);
    let reply = command(&mut session, sasl("SCRAM-SHA-1", Vec::new())).await;
    assert_eq!(reply.get_i32("code").unwrap(), 18);
    assert!(limits.authentication_blocked("127.0.0.1") > 0);
    let token = common::token(DateTime::now().timestamp_millis() / 1000 + 600);
    let blocked = command(&mut session, sasl("MONGODB-OIDC", doc! { "jwt": token }.to_vec().unwrap())).await;
    assert_eq!(blocked, reply);
    assert!(session.principal().is_none());
}
