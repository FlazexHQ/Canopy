//! The HTTPS claims hook through the router against a local hook server that checks the Standard Webhooks
//! signature with its own copy of the secret.

#![allow(clippy::expect_used, clippy::print_stderr)]

use std::{
    error::Error,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use bson::{Bson, DateTime, Document, doc};
use canopy_authn::{
    key_material,
    server::{AuthMail, AuthOptions, AuthRouter, ClaimsHook},
    tokens::Algorithm,
};
use canopy_http::{Request, Response};
use canopy_mail::{EmailKind, Recipient};
use canopy_mongo::mongodb::{Client, Database};
use futures_util::future::BoxFuture;
use ring::hmac;
use serde_json_bytes::{Value, json};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpListener,
};
use url::Url;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const PUBLIC: &str = "https://auth.canopy.test";
const APP: &str = "https://app.canopy.test";
const SECRET: &str = "a secret of more than thirty two bytes";
const HOOK_KEY: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PASSWORD: &str = "claims hook password";

struct NoMail;

impl AuthMail for NoMail {
    fn send<'a>(self: Arc<Self>, _: EmailKind, _: Recipient<'a>) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

#[derive(Clone)]
struct Answer {
    status: u16,
    body: String,
    delay: Duration,
    chunked: bool,
    location: Option<String>,
}

impl Answer {
    fn json(body: &str) -> Self {
        Self { status: 200, body: body.into(), delay: Duration::ZERO, chunked: false, location: None }
    }

    fn status(status: u16) -> Self {
        Self { status, ..Self::json("") }
    }
}

#[derive(Clone, Debug)]
struct Received {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
    signed: bool,
}

impl Received {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

/// A hook endpoint that answers 401 to any request whose signature does not verify with [`HOOK_KEY`].
struct HookServer {
    url: String,
    answer: Arc<Mutex<Answer>>,
    received: Arc<Mutex<Vec<Received>>>,
}

impl HookServer {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://127.0.0.1:{}/claims", listener.local_addr()?.port());
        let answer = Arc::new(Mutex::new(Answer::status(204)));
        let received = Arc::new(Mutex::new(Vec::new()));
        let (shared_answer, shared_received) = (answer.clone(), received.clone());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let answer = shared_answer.clone();
                let received = shared_received.clone();
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut stream).await else { return };
                    let signed = request.signed;
                    received.lock().expect("received").push(request);
                    let answer =
                        if signed { answer.lock().expect("answer").clone() } else { Answer::status(401) };
                    tokio::time::sleep(answer.delay).await;
                    let mut head = format!("HTTP/1.1 {} Hook\r\nconnection: close\r\n", answer.status);
                    if let Some(location) = &answer.location {
                        head.push_str(&format!("location: {location}\r\n"));
                    }
                    let mut bytes = if answer.chunked {
                        head.push_str("content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n");
                        let mut bytes = head.into_bytes();
                        for chunk in answer.body.as_bytes().chunks(1000) {
                            bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                            bytes.extend_from_slice(chunk);
                            bytes.extend_from_slice(b"\r\n");
                        }
                        bytes.extend_from_slice(b"0\r\n\r\n");
                        bytes
                    } else {
                        head.push_str(&format!(
                            "content-type: application/json\r\ncontent-length: {}\r\n\r\n",
                            answer.body.len()
                        ));
                        head.into_bytes()
                    };
                    if !answer.chunked {
                        bytes.extend_from_slice(answer.body.as_bytes());
                    }
                    let _ = stream.write_all(&bytes).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Ok(Self { url, answer, received })
    }

    fn answer(&self, answer: Answer) {
        *self.answer.lock().expect("answer") = answer;
    }

    fn take(&self) -> Vec<Received> {
        std::mem::take(&mut *self.received.lock().expect("received"))
    }
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Received> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(chunk.get(..read)?);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
    };
    let head = String::from_utf8(buffer.get(..head_end)?.to_vec()).ok()?;
    let mut lines = head.split("\r\n");
    let mut start = lines.next()?.split(' ');
    let method = start.next()?.to_owned();
    let path = start.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer.get(head_end + 4..)?.to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(chunk.get(..read)?);
    }
    let body = String::from_utf8(body).ok()?;
    let mut request = Received { method, path, headers, body, signed: false };
    request.signed = verify(&request);
    Some(request)
}

/// Checks the request the way a Standard Webhooks receiver does, without Canopy's signing code.
fn verify(request: &Received) -> bool {
    let (Some(id), Some(timestamp), Some(signature)) = (
        request.header("webhook-id"),
        request.header("webhook-timestamp"),
        request.header("webhook-signature"),
    ) else {
        return false;
    };
    let Ok(seconds) = timestamp.parse::<i64>() else { return false };
    let now = DateTime::now().timestamp_millis() / 1000;
    if (now - seconds).abs() > 300 {
        return false;
    }
    let Ok(key) = Base64::decode_vec(HOOK_KEY.trim_start_matches("whsec_")) else { return false };
    let key = hmac::Key::new(hmac::HMAC_SHA256, &key);
    signature.split(' ').filter_map(|entry| entry.strip_prefix("v1,")).any(|encoded| {
        Base64::decode_vec(encoded).is_ok_and(|tag| {
            hmac::verify(&key, format!("{id}.{timestamp}.{}", request.body).as_bytes(), &tag).is_ok()
        })
    })
}

struct Harness {
    router: AuthRouter,
    auth: Database,
    meta: Database,
}

impl Harness {
    async fn open(auth: Database, meta: Database, hook: ClaimsHook) -> Result<Self> {
        let now = DateTime::now().timestamp_millis();
        if auth.collection::<Document>("signing_keys").count_documents(doc! {}).await? == 0 {
            let key = key_material::generate(Algorithm::EdDSA, SECRET, now - 60_000, now + 3_600_000)?;
            auth.collection::<Document>("signing_keys").insert_one(key).await?;
        }
        let mut options = AuthOptions::new(Url::parse(PUBLIC)?, SECRET.into());
        options.trusted_origins = vec![APP.into()];
        options.require_email_verification = false;
        options.response_floor = Duration::ZERO;
        options.claims_hook = Some(hook);
        let router = AuthRouter::open(auth.clone(), meta.clone(), options, Arc::new(NoMail)).await?;
        Ok(Self { router, auth, meta })
    }

    async fn send(&self, request: Request) -> Response {
        let mut request = request;
        request.client_address = Some("203.0.113.7".into());
        self.router.handle(&request).await.expect("an auth route")
    }

    /// Signs up a user and returns its id and the bearer session token.
    async fn sign_up(&self, email: &str) -> Result<(String, String)> {
        let request = Request::new("POST", "/auth/v1/sign-up/email")
            .with_header("origin", APP)
            .with_header("content-type", "application/json")
            .with_body(json!({"name": "Hook User", "email": email, "password": PASSWORD}).to_string());
        let response = self.send(request).await;
        assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
        let body: Value = serde_json::from_slice(&response.body)?;
        let id = body["user"]["id"].as_str().ok_or("user id")?.to_owned();
        let bearer = response.header("set-auth-token").ok_or("session token")?.to_owned();
        Ok((id, bearer))
    }

    async fn token(&self, bearer: &str) -> Response {
        self.send(
            Request::new("GET", "/auth/v1/token").with_header("authorization", format!("Bearer {bearer}")),
        )
        .await
    }

    async fn failures(&self, user: &str) -> Result<Vec<Document>> {
        let mut cursor = self
            .meta
            .collection::<Document>("audit_log")
            .find(doc! {"action": "auth.claims_hook_failed", "actor.id": user})
            .sort(doc! {"_id": 1})
            .await?;
        let mut found = Vec::new();
        while cursor.advance().await? {
            found.push(cursor.deserialize_current()?);
        }
        Ok(found)
    }
}

fn payload(response: &Response) -> Result<Value> {
    let body: Value = serde_json::from_slice(&response.body)?;
    let token = body["access_token"].as_str().ok_or("access token")?;
    let encoded = token.split('.').nth(1).ok_or("token payload")?;
    Ok(serde_json::from_slice(&Base64UrlUnpadded::decode_vec(encoded)?)?)
}

async fn databases() -> Option<(Database, Database)> {
    let uri = std::env::var("CANOPY_TEST_MONGODB_URI").ok()?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await.ok()?;
    let name = uuid::Uuid::new_v4().simple().to_string();
    Some((client.database(&format!("auth_claims_{name}")), client.database(&format!("meta_claims_{name}"))))
}

#[tokio::test]
async fn adds_signed_hook_claims_to_access_tokens() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping the claims hook because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let hook = HookServer::start().await?;
        let harness = Harness::open(
            auth.clone(),
            meta.clone(),
            ClaimsHook::new(Url::parse(&hook.url)?, HOOK_KEY.into()),
        )
        .await?;
        let (user, bearer) = harness.sign_up("hook-user@example.test").await?;
        harness
            .auth
            .collection::<Document>("users")
            .update_one(
                doc! {"email": "hook-user@example.test"},
                doc! {"$set": {"appMetadata": r#"{"tier":1,"plan":"free"}"#, "roles": ["reader"]}},
            )
            .await?;
        hook.answer(Answer::json(
            r#"{"app_metadata":{"plan":"pro","org":"acme"},"roles":["editor","reader"]}"#,
        ));
        let response = harness.token(&bearer).await;
        assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
        let claims = payload(&response)?;
        assert_eq!(claims["app_metadata"], json!({"tier": 1, "plan": "pro", "org": "acme"}));
        assert_eq!(claims["roles"], json!(["reader", "editor"]));
        assert_eq!(claims["sub"], json!(user));
        assert_eq!(claims["role"], json!("authenticated"));

        let calls = hook.take();
        assert_eq!(calls.len(), 1);
        let call = calls.first().ok_or("one hook call")?;
        assert!(call.signed, "the signature verifies with the shared secret");
        assert_eq!((call.method.as_str(), call.path.as_str()), ("POST", "/claims"));
        assert_eq!(call.header("content-type"), Some("application/json"));
        assert!(call.header("webhook-id").is_some_and(|id| id.starts_with("msg_") && id.len() > 20));
        let sent: Value = serde_json::from_str(&call.body)?;
        let session =
            harness.auth.collection::<Document>("sessions").find_one(doc! {}).await?.ok_or("session")?;
        let session_id = match session.get("_id") {
            Some(Bson::String(id)) => id.clone(),
            Some(Bson::ObjectId(id)) => id.to_hex(),
            _ => return Err("session id".into()),
        };
        assert_eq!(sent["session"], json!({"id": session_id}));
        assert_eq!(claims["sid"], json!(session_id));
        assert_eq!(sent["user"]["id"], json!(user));
        assert_eq!(sent["user"]["email"], json!("hook-user@example.test"));
        assert_eq!(sent["user"]["emailVerified"], json!(false));
        assert_eq!(sent["user"]["name"], json!("Hook User"));
        assert_eq!(sent["user"]["isAnonymous"], json!(false));
        assert_eq!(sent["user"]["roles"], json!(["reader"]));
        assert_eq!(sent["user"]["appMetadata"], json!({"tier": 1, "plan": "free"}));
        assert_eq!(sent["user"]["userMetadata"], json!({}));
        assert_eq!(sent["user"]["banned"], json!(false));
        assert!(sent["user"]["createdAt"].as_str().is_some_and(|date| date.ends_with('Z')));
        assert!(sent["user"].get("db").is_none());

        hook.answer(Answer::status(204));
        let response = harness.token(&bearer).await;
        assert_eq!(response.status, 200);
        let claims = payload(&response)?;
        assert_eq!(claims["app_metadata"], json!({"tier": 1, "plan": "free"}));
        assert_eq!(claims["roles"], json!(["reader"]));
        hook.answer(Answer::json("null"));
        assert_eq!(harness.token(&bearer).await.status, 200);
        assert!(harness.failures(&user).await?.is_empty());
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    result
}

#[tokio::test]
async fn fails_closed_without_a_token() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping the claims hook because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let hook = HookServer::start().await?;
        let harness = Harness::open(
            auth.clone(),
            meta.clone(),
            ClaimsHook::new(Url::parse(&hook.url)?, HOOK_KEY.into()),
        )
        .await?;
        let (user, bearer) = harness.sign_up("failing-hook@example.test").await?;
        let big = "x".repeat(3500);
        let failures = [
            (
                "an error status",
                Answer { body: "private hook diagnostic".into(), ..Answer::status(500) },
                "the hook answered 500",
            ),
            (
                "a slow hook",
                Answer { delay: Duration::from_millis(600), ..Answer::json("{}") },
                "timed out after 200 ms",
            ),
            (
                "a redirect",
                Answer { location: Some("/claims/elsewhere".into()), ..Answer::status(307) },
                "the hook answered 307",
            ),
            ("malformed JSON", Answer::json("{\"app_metadata\":"), "the answer is not JSON"),
            ("a list", Answer::json("[]"), "the hook must return an object"),
            (
                "an oversize answer",
                Answer::json(&format!(r#"{{"app_metadata":{{"blob":"{}"}}}}"#, "y".repeat(5000))),
                "the answer is over 4096 bytes",
            ),
            (
                "an oversize chunked answer",
                Answer {
                    chunked: true,
                    ..Answer::json(&format!(r#"{{"app_metadata":{{"blob":"{}"}}}}"#, "y".repeat(5000)))
                },
                "the answer is over 4096 bytes",
            ),
            (
                "a forbidden claim",
                Answer::json(r#"{"sub":"someone-else","app_metadata":{}}"#),
                "the hook may only return app_metadata and roles, not sub",
            ),
            (
                "a reserved role",
                Answer::json(r#"{"roles":["service"]}"#),
                "roles must be a list of names other than anon, authenticated, service and public",
            ),
            (
                "app_metadata that is not an object",
                Answer::json(r#"{"app_metadata":"pro"}"#),
                "app_metadata must be an object",
            ),
        ];
        for (index, (name, answer, reason)) in failures.into_iter().enumerate() {
            hook.answer(answer);
            let started = Instant::now();
            let response = harness.token(&bearer).await;
            let took = started.elapsed();
            assert_eq!(response.status, 500, "{name}: {}", String::from_utf8_lossy(&response.body));
            let body: Value = serde_json::from_slice(&response.body)?;
            assert_eq!(
                body,
                json!({"code": "CANOPY_AUTH_HOOK_FAILED", "message": "The claims hook failed"}),
                "{name}"
            );
            assert_eq!(response.header("cache-control"), Some("no-store"), "{name}");
            assert!(response.header("set-auth-token").is_none(), "{name}: no session refresh");
            assert!(!response.headers.iter().any(|(header, _)| header == "set-cookie"), "{name}: no cookie");
            assert!(took < Duration::from_millis(500), "{name} took {took:?}");
            let audited = harness.failures(&user).await?;
            assert_eq!(audited.len(), index + 1, "{name}: one audit event per failure");
            let last = audited.last().ok_or("audit event")?;
            assert_eq!(last.get_document("actor")?, &doc! {"type": "user", "id": &user}, "{name}");
            assert_eq!(last.get_document("details")?, &doc! {"reason": reason}, "{name}");
            assert_eq!(last.get_str("ip")?, "203.0.113.7", "{name}");
        }
        let followed: Vec<_> = hook.take().into_iter().map(|call| call.path).collect();
        assert!(!followed.iter().any(|path| path == "/claims/elsewhere"), "no redirect is followed");

        hook.answer(Answer::json(&format!(r#"{{"app_metadata":{{"blob":"{big}"}}}}"#)));
        let response = harness.token(&bearer).await;
        assert_eq!(response.status, 500);
        let body: Value = serde_json::from_slice(&response.body)?;
        let message = body["message"].as_str().ok_or("message")?;
        assert_eq!(body["code"], json!("CANOPY_AUTH_HOOK_FAILED"));
        assert!(
            message.starts_with("The access token is ")
                && message.ends_with(" bytes, over the 4096 byte cap")
        );
        let last = harness.failures(&user).await?.pop().ok_or("audit event")?;
        let details = last.get_document("details")?;
        assert_eq!(details.get_str("reason")?, "token too large");
        let bytes = details.get_i32("bytes")?;
        assert!(bytes > 4096 && message.contains(&format!(" {bytes} bytes")));

        hook.answer(Answer::json(r#"{"app_metadata":{"plan":"pro"}}"#));
        let response = harness.token(&bearer).await;
        assert_eq!(response.status, 200, "a working hook issues tokens again");
        assert_eq!(payload(&response)?["app_metadata"], json!({"plan": "pro"}));
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    result
}

#[tokio::test]
async fn a_hook_with_another_secret_is_refused_by_the_receiver() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping the claims hook because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let hook = HookServer::start().await?;
        hook.answer(Answer::json(r#"{"app_metadata":{"plan":"pro"}}"#));
        let other = ClaimsHook::new(Url::parse(&hook.url)?, "whsec_c2VjcmV0IG9mIGFub3RoZXIgYXBw".into());
        let harness = Harness::open(auth.clone(), meta.clone(), other).await?;
        let (user, bearer) = harness.sign_up("other-secret@example.test").await?;
        let response = harness.token(&bearer).await;
        assert_eq!(response.status, 500);
        let body: Value = serde_json::from_slice(&response.body)?;
        assert_eq!(body["message"], json!("The claims hook failed"));
        let calls = hook.take();
        assert_eq!(calls.len(), 1);
        assert!(calls.iter().all(|call| !call.signed));
        assert_eq!(harness.failures(&user).await?.len(), 1);
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    result
}

#[tokio::test]
async fn hides_connection_refusal_from_the_token_response() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping the claims hook because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = Url::parse(&format!("http://{}/claims", listener.local_addr()?))?;
        drop(listener);
        let mut settings = ClaimsHook::new(url, HOOK_KEY.into());
        settings.timeout = Duration::from_secs(3);
        let harness = Harness::open(auth.clone(), meta.clone(), settings).await?;
        let (user, bearer) = harness.sign_up("unreachable-hook@example.test").await?;
        let response = harness.token(&bearer).await;
        assert_eq!(response.status, 500);
        let body: Value = serde_json::from_slice(&response.body)?;
        assert_eq!(body, json!({"code": "CANOPY_AUTH_HOOK_FAILED", "message": "The claims hook failed"}));
        let audited = harness.failures(&user).await?;
        assert_eq!(audited.len(), 1);
        let reason = audited[0].get_document("details")?.get_str("reason")?;
        assert!(reason.starts_with("the request failed: "), "{reason}");
        assert!(reason.contains("ConnectionRefused"), "{reason}");
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    result
}

#[tokio::test]
async fn refuses_hook_urls_that_are_not_https() -> Result<()> {
    let Some((auth, meta)) = databases().await else {
        eprintln!("Skipping the claims hook because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let result = async {
        for (url, production) in [
            ("http://hooks.example.test/claims", false),
            ("http://127.0.0.1:9/claims", true),
            ("https://user:password@hooks.example.test/claims", false),
        ] {
            let mut options = AuthOptions::new(Url::parse(PUBLIC)?, SECRET.into());
            options.production = production;
            options.claims_hook = Some(ClaimsHook::new(Url::parse(url)?, HOOK_KEY.into()));
            let opened = AuthRouter::open(auth.clone(), meta.clone(), options, Arc::new(NoMail)).await;
            assert!(opened.is_err(), "{url} in production {production}");
        }
        let mut options = AuthOptions::new(Url::parse(PUBLIC)?, SECRET.into());
        options.claims_hook =
            Some(ClaimsHook::new(Url::parse("https://hooks.example.test/claims")?, "whsec_".into()));
        assert!(AuthRouter::open(auth.clone(), meta.clone(), options, Arc::new(NoMail)).await.is_err());
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    result
}
