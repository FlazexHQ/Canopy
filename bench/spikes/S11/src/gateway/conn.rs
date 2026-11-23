use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_policy::{Compiled, RequestContext};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, decode, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{Document, RawDocument, Value};
use futures_util::{SinkExt, StreamExt};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::engine::{Command, ConnId};
use crate::frames::{self, Body};
use crate::policy;
use crate::Shared;

type Socket = WebSocketStream<TokioIo<Upgraded>>;

struct Session {
    conn: ConnId,
    seq: u64,
    claims: Document,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

fn text_of<'a>(json: &'a Json, key: &str) -> Option<&'a str> {
    match json.get(key) {
        Some(Json::String(text)) => Some(text),
        _ => None,
    }
}

/// The claims of a token. The prototype reads them without checking the signature: verification runs once per
/// connection and is not part of what the spike measures.
fn claims(token: &str) -> Option<Document> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    match parse(&text, DecodeOptions::default()).ok()? {
        Value::Document(document) => Some(document),
        _ => None,
    }
}

async fn send(socket: &mut Socket, session: &mut Session, body: &str) -> bool {
    let mut text = String::with_capacity(body.len() + 12);
    text.push_str(body);
    text.push_str(&session.seq.to_string());
    text.push('}');
    session.seq += 1;
    socket.feed(Message::Text(text.into())).await.is_ok()
}

/// Serves one upgraded connection until it closes.
pub async fn run(mut socket: Socket, shared: Arc<Shared>, conn: ConnId) {
    let Some(claims) = hello(&mut socket).await else {
        let _ = socket.close(None).await;
        return;
    };
    let welcome = frames::welcome(&format!("g1.{conn}"), &shared.pv);
    if socket.send(Message::Text(welcome.into())).await.is_err() {
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Body>(shared.queue);
    if shared.engine.send(Command::Connect { conn, tx }).is_err() {
        return;
    }
    let mut session = Session { conn, seq: 1, claims };
    loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !Box::pin(message(&mut socket, &shared, &mut session, text.as_str())).await {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            out = rx.recv() => match out {
                Some(body) => {
                    let mut ok = send(&mut socket, &mut session, &body).await;
                    while ok {
                        match rx.try_recv() {
                            Ok(more) => ok = send(&mut socket, &mut session, &more).await,
                            Err(_) => break,
                        }
                    }
                    if !ok || socket.flush().await.is_err() {
                        break;
                    }
                }
                None => {
                    let _ = send(&mut socket, &mut session, &frames::resync("overflow")).await;
                    let _ = socket.close(None).await;
                    break;
                }
            },
        }
    }
    let _ = shared.engine.send(Command::Disconnect { conn });
}

async fn hello(socket: &mut Socket) -> Option<Document> {
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.ok()??.ok()?;
    let Message::Text(text) = first else { return None };
    let json = parse_json(text.as_str()).ok()?;
    if text_of(&json, "t") != Some("hello") || text_of(&json, "key") != Some("pk_bench") {
        return None;
    }
    claims(text_of(&json, "token")?)
}

/// Handles one client message. Returns false when the connection should close.
async fn message(socket: &mut Socket, shared: &Shared, session: &mut Session, text: &str) -> bool {
    let Ok(json) = parse_json(text) else { return false };
    match text_of(&json, "t") {
        Some("sub") => subscribe(socket, shared, session, &json).await,
        Some("unsub") => {
            if let Some(id) = text_of(&json, "id") {
                let _ = shared.engine.send(Command::Unsubscribe { conn: session.conn, sub: Arc::from(id) });
            }
            true
        }
        Some("ping") => {
            let ts = match json.get("ts") {
                Some(Json::Number(n)) => canopy_protocol::json::js_number_string(*n),
                _ => "0".to_owned(),
            };
            socket.send(Message::Text(format!(r#"{{"t":"pong","ts":{ts}}}"#).into())).await.is_ok()
        }
        Some("bye") => false,
        _ => true,
    }
}

async fn refuse(socket: &mut Socket, session: &mut Session, sub: &str, message: &str) -> bool {
    send(socket, session, &frames::nosub(sub, "CANOPY_POLICY_DENIED", message)).await && socket.flush().await.is_ok()
}

async fn subscribe(socket: &mut Socket, shared: &Shared, session: &mut Session, json: &Json) -> bool {
    let Some(sub) = text_of(json, "id") else { return false };
    if text_of(json, "c") != Some(policy::COLLECTION) {
        return refuse(socket, session, sub, "unknown collection").await;
    }
    let filter = match json.get("q").and_then(|q| q.get("filter")) {
        None => Document::new(),
        Some(raw) => match decode(raw, DecodeOptions::default()) {
            Ok(Value::Document(filter)) => filter,
            _ => return refuse(socket, session, sub, "invalid filter").await,
        },
    };
    let ctx: RequestContext = policy::context(session.claims.clone(), now_ms());
    let compiled = match policy::effective(&shared.policy, &filter, &ctx) {
        Ok(Compiled::Deny) | Err(_) => return refuse(socket, session, sub, "denied").await,
        Ok(compiled) => compiled,
    };
    let Ok(matcher) = compiled.matcher() else { return refuse(socket, session, sub, "denied").await };
    let effective = compiled.to_filter();
    let Ok(key) = canonical_string(&Value::Document(effective.clone())) else {
        return refuse(socket, session, sub, "denied").await;
    };
    let Ok((documents, ct)) = shared.snapshot(&effective).await else {
        return refuse(socket, session, sub, "snapshot failed").await;
    };
    let sub: Arc<str> = Arc::from(sub);
    let mut ids = Vec::with_capacity(documents.len());
    let mut bodies = Vec::with_capacity(documents.len() + 1);
    for bytes in &documents {
        let Ok(document) = RawDocument::new(bytes) else { continue };
        let Some(id) = document.get("_id").map(|id| id.to_value()) else { continue };
        let (Ok(id_key), Ok(id_text), Ok(text)) = (
            canonical_string(&id),
            frames::relaxed(&id),
            frames::relaxed(&Value::Document(document.to_document())),
        ) else {
            continue;
        };
        ids.push(id_key);
        bodies.push(frames::added(&id_text, &ct, &text, std::slice::from_ref(&sub)));
    }
    bodies.push(frames::ready(&sub, &ct));
    let registered = shared.engine.send(Command::Subscribe {
        conn: session.conn,
        sub: Arc::clone(&sub),
        key,
        filter: effective,
        matcher,
        ids,
    });
    if registered.is_err() {
        return false;
    }
    for body in bodies {
        if !send(socket, session, &body).await {
            return false;
        }
    }
    socket.flush().await.is_ok()
}
