use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpSocket, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{WebSocketStream, client_async_with_config};

use crate::Res;

type Socket = WebSocketStream<TcpStream>;

/// Ports 10000 to 48999 on 127.0.0.2 and up. Binding explicitly keeps the client out of the Windows dynamic
/// port range (16,384 ports by default), so one machine can open 50k connections without administrator rights.
static NEXT_LOCAL: AtomicU32 = AtomicU32::new(0);
const PORTS_PER_ADDRESS: u32 = 39_000;

fn next_local() -> SocketAddr {
    let k = NEXT_LOCAL.fetch_add(1, Ordering::Relaxed);
    let host = u8::try_from(2 + k / PORTS_PER_ADDRESS).unwrap_or(250);
    let port = u16::try_from(10_000 + k % PORTS_PER_ADDRESS).unwrap_or(10_000);
    SocketAddr::from((Ipv4Addr::new(127, 0, 0, host), port))
}

async fn connect(port: u16) -> Res<TcpStream> {
    let server = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut last = String::new();
    for _ in 0..200 {
        let socket = TcpSocket::new_v4()?;
        if socket.bind(next_local()).is_err() {
            continue;
        }
        match socket.connect(server).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last = error.to_string(),
        }
    }
    Err(format!("no local address could connect: {last}").into())
}

/// What one connection does: its token and the `sub` frames it sends.
pub struct Plan {
    pub token: String,
    pub subs: Vec<String>,
}

/// What one connection saw during the write phase.
#[derive(Default)]
pub struct Outcome {
    pub latencies: Vec<f32>,
    pub counters: HashMap<i64, i64>,
    pub frames: u64,
    pub error: Option<String>,
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn int(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::Object(o) => {
            let text = o.get("$numberInt").or_else(|| o.get("$numberLong")).or_else(|| o.get("$numberDouble"))?;
            text.as_str()?.parse::<f64>().ok().map(|f| f as i64)
        }
        _ => None,
    }
}

fn float(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::Object(o) => o.get("$numberDouble")?.as_str()?.parse().ok(),
        _ => None,
    }
}

/// Applies one frame to the outcome; returns the frame type.
fn apply(text: &str, outcome: &mut Outcome, received: f64) -> Result<String, String> {
    let frame: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let kind = frame.get("t").and_then(Value::as_str).unwrap_or("").to_owned();
    let id = int(frame.get("id"));
    let body = frame.get("set").or_else(|| frame.get("d"));
    if let (Some(id), Some(n)) = (id, int(body.and_then(|b| b.get("n")))) {
        outcome.counters.insert(id, n);
    }
    match kind.as_str() {
        "changed" => {
            if let Some(ts) = float(body.and_then(|b| b.get("ts"))) {
                if ts > 0.0 {
                    outcome.latencies.push((received - ts) as f32);
                }
            }
        }
        "nosub" | "err" | "resync" => return Err(format!("unexpected frame: {text}")),
        _ => {}
    }
    Ok(kind)
}

pub fn config() -> WebSocketConfig {
    WebSocketConfig::default().read_buffer_size(8 * 1024).write_buffer_size(0)
}

/// Connects, says hello, subscribes and waits for every `ready`. Returns the socket, the outcome so far and
/// the time from the first `sub` to the last `ready`.
pub async fn open(port: u16, plan: &Plan) -> Res<(Socket, Outcome, f64)> {
    let stream = connect(port).await?;
    let _ = stream.set_nodelay(true);
    let mut request = format!("ws://127.0.0.1:{port}/realtime/v1").into_client_request()?;
    request.headers_mut().insert("Sec-WebSocket-Protocol", "canopy.v1+json".parse()?);
    let (mut socket, _) = client_async_with_config(request, stream, Some(config())).await?;
    let hello = format!(r#"{{"t":"hello","v":1,"key":"pk_bench","token":"{}","caps":["diff"],"sdk":"s11-bench"}}"#, plan.token);
    socket.send(Message::Text(hello.into())).await?;
    let mut outcome = Outcome::default();
    let deadline = Duration::from_secs(120);
    loop {
        let message = tokio::time::timeout(deadline, socket.next()).await?.ok_or("closed before welcome")??;
        if let Message::Text(text) = message {
            if apply(text.as_str(), &mut outcome, now_ms())? == "welcome" {
                break;
            }
        }
    }
    let started = Instant::now();
    for sub in &plan.subs {
        socket.feed(Message::Text(sub.clone().into())).await?;
    }
    socket.flush().await?;
    let mut ready = 0;
    while ready < plan.subs.len() {
        let message = tokio::time::timeout(deadline, socket.next()).await?.ok_or("closed before ready")??;
        if let Message::Text(text) = message {
            if apply(text.as_str(), &mut outcome, now_ms())? == "ready" {
                ready += 1;
            }
        }
    }
    Ok((socket, outcome, started.elapsed().as_secs_f64() * 1000.0))
}

/// Reads frames until `stop` turns true, then says goodbye and closes.
pub async fn read(mut socket: Socket, mut outcome: Outcome, mut stop: watch::Receiver<bool>) -> Outcome {
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(20), Duration::from_secs(20));
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let ping = format!(r#"{{"t":"ping","ts":{}}}"#, now_ms().round());
                if socket.send(Message::Text(ping.into())).await.is_err() {
                    outcome.error.get_or_insert_with(|| "ping failed".to_owned());
                    return outcome;
                }
            }
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    outcome.frames += 1;
                    if let Err(error) = apply(text.as_str(), &mut outcome, now_ms()) {
                        outcome.error.get_or_insert(error);
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    outcome.error.get_or_insert(error.to_string());
                    return outcome;
                }
                None => {
                    outcome.error.get_or_insert_with(|| "closed by the server".to_owned());
                    return outcome;
                }
            },
            _ = stop.changed() => break,
        }
    }
    let _ = socket.send(Message::Text(r#"{"t":"bye"}"#.into())).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
    outcome
}
