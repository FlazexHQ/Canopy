//! GraphQL over WebSocket (`graphql-transport-ws`) on the GraphQL endpoint path: subscriptions follow live
//! queries through the realtime engine, and queries and mutations run once. Browsers cannot set headers on a
//! WebSocket, so `apikey` and `authorization` in the `connection_init` payload override the upgrade request's
//! headers; every operation is authenticated, rate limited, limited and DLS checked as over HTTP.

use std::collections::HashMap;
use std::sync::Arc;

use canopy_graphql::endpoint::{Graphql, Started};
use canopy_graphql::ws::{
    Action, CONNECTION_INIT_TIMEOUT, Close, GRAPHQL_WS_SUBPROTOCOL, ServerConnection, SubscribePayload,
    credential_headers, offers_graphql_ws,
};
use canopy_protocol::json::{Json, parse_json};
use canopy_realtime::{Body, full};
use futures_util::{SinkExt, StreamExt};
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    CONNECTION, HeaderValue, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_PROTOCOL, UPGRADE,
};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};

use crate::server::Routes;

/// The largest message a client may send, as the TypeScript server allows.
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

/// Whether a request asks to open GraphQL over WebSocket on the endpoint, when subscriptions are served.
pub(crate) fn wants<B>(graphql: &Graphql, request: &Request<B>) -> bool {
    let headers = request.headers();
    let upgrade = headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let target = request.uri().path_and_query().map_or("", |target| target.as_str());
    upgrade
        && graphql.live().is_some()
        && graphql.owns(target)
        && offers_graphql_ws(
            headers.get_all(SEC_WEBSOCKET_PROTOCOL).iter().filter_map(|value| value.to_str().ok()),
        )
}

/// Accepts the upgrade and serves the socket on the shard. `address` is the client address the rate limits and
/// the anonymous connection limit count.
pub(crate) fn upgrade(
    routes: Arc<Routes>,
    mut request: Request<Incoming>,
    address: String,
) -> Response<Body> {
    let Some(key) = request.headers().get(SEC_WEBSOCKET_KEY) else {
        return full(StatusCode::BAD_REQUEST, Bytes::from_static(b"Expected a WebSocket upgrade"));
    };
    let accept = derive_accept_key(key.as_bytes());
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())
        })
        .collect();
    let pending = hyper::upgrade::on(&mut request);
    tokio::task::spawn_local(async move {
        let Ok(upgraded) = pending.await else { return };
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_PAYLOAD_BYTES))
            .max_frame_size(Some(MAX_PAYLOAD_BYTES));
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        serve(routes, socket, headers, address).await;
    });
    let mut response = full(StatusCode::SWITCHING_PROTOCOLS, Bytes::new());
    let out = response.headers_mut();
    out.insert(UPGRADE, HeaderValue::from_static("websocket"));
    out.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
    out.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static(GRAPHQL_WS_SUBPROTOCOL));
    if let Ok(value) = HeaderValue::from_str(&accept) {
        out.insert(SEC_WEBSOCKET_ACCEPT, value);
    }
    response
}

/// What an operation's task reports to its connection.
enum Out {
    Next(String),
    Error(String),
    Complete,
    Failed,
}

type Socket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;

async fn close(socket: &mut Socket, close: Close) {
    let frame = CloseFrame { code: CloseCode::from(close.code), reason: close.reason.into() };
    let _ = socket.close(Some(frame)).await;
}

/// The operation parameters of a `subscribe` payload, as the HTTP endpoint reads them.
fn params_of(payload: SubscribePayload) -> Json {
    let mut params = vec![("query".to_owned(), Json::String(payload.query))];
    if let Some(Some(name)) = payload.operation_name {
        params.push(("operationName".to_owned(), Json::String(name)));
    }
    if let Some(variables @ Json::Object(_)) = payload.variables {
        params.push(("variables".to_owned(), variables));
    }
    if let Some(extensions @ Json::Object(_)) = payload.extensions {
        params.push(("extensions".to_owned(), extensions));
    }
    Json::Object(params)
}

async fn serve(routes: Arc<Routes>, mut socket: Socket, headers: Vec<(String, String)>, address: String) {
    let Ok(mut protocol) = ServerConnection::open(GRAPHQL_WS_SUBPROTOCOL) else { return };
    let mut connection_params: Option<Vec<(String, Json)>> = None;
    let (results, mut inbox) = mpsc::unbounded_channel::<(String, Out)>();
    let mut tasks: HashMap<String, AbortHandle> = HashMap::new();
    let init_deadline = tokio::time::sleep(CONNECTION_INIT_TIMEOUT);
    tokio::pin!(init_deadline);
    let mut waiting_for_init = true;
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let action = match incoming {
                    Some(Ok(Message::Text(text))) => protocol.on_text(text.as_str()),
                    Some(Ok(Message::Binary(_))) => Some(protocol.on_binary()),
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => None,
                };
                match action {
                    None => {}
                    Some(Action::Send(text)) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Action::Close(reason)) => {
                        close(&mut socket, reason).await;
                        break;
                    }
                    Some(Action::Init { payload }) => {
                        connection_params = payload;
                        waiting_for_init = false;
                        if let Some(ack) = protocol.ack(None)
                            && socket.send(Message::Text(ack.into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Action::Subscribe { id, payload }) => {
                        let request = operation_request(
                            &routes,
                            credential_headers(&headers, connection_params.as_deref()),
                            &address,
                        );
                        let task = run(Arc::clone(&routes), request, params_of(payload), id.clone(), results.clone());
                        tasks.insert(id, tokio::task::spawn_local(task).abort_handle());
                    }
                    Some(Action::Unsubscribe { id }) => {
                        if let Some(task) = tasks.remove(&id) {
                            task.abort();
                        }
                    }
                }
            }
            Some((id, out)) = inbox.recv() => {
                let sent = match out {
                    Out::Next(text) => match parse_json(&text) {
                        Ok(payload) => protocol.next(&id, &payload),
                        Err(_) => Err(Close::internal()),
                    },
                    Out::Error(text) => match parse_json(&text) {
                        Ok(Json::Array(errors)) => {
                            tasks.remove(&id);
                            protocol.error(&id, &errors)
                        }
                        _ => Err(Close::internal()),
                    },
                    Out::Complete => {
                        tasks.remove(&id);
                        Ok(protocol.complete(&id))
                    }
                    Out::Failed => Err(Close::internal()),
                };
                match sent {
                    Ok(Some(text)) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(reason) => {
                        close(&mut socket, reason).await;
                        break;
                    }
                }
            }
            () = &mut init_deadline, if waiting_for_init => {
                waiting_for_init = false;
                if let Some(reason) = protocol.init_timed_out() {
                    close(&mut socket, reason).await;
                    break;
                }
            }
        }
    }
    for (_, task) in tasks {
        task.abort();
    }
}

fn operation_request(routes: &Routes, headers: Vec<(String, String)>, address: &str) -> canopy_http::Request {
    let path = routes.data_plane.as_ref().and_then(|plane| plane.graphql()).map_or("/", Graphql::path);
    let mut request = canopy_http::Request::new("POST", path);
    request.headers = headers;
    request.client_address = Some(address.to_owned());
    request
}

/// Runs one operation and reports its results: one result then `complete` for a query or mutation, every
/// event of a subscription then `complete`, or `error` when the operation could not start.
async fn run(
    routes: Arc<Routes>,
    request: canopy_http::Request,
    params: Json,
    id: String,
    results: mpsc::UnboundedSender<(String, Out)>,
) {
    let Some(graphql) = routes.data_plane.as_ref().and_then(|plane| plane.graphql()) else {
        let _ = results.send((id, Out::Failed));
        return;
    };
    let mut run = match graphql.start(&request, &params).await {
        Err(errors) => {
            let _ = results.send((id, Out::Error(errors)));
            return;
        }
        Ok(Started::Result(text)) => {
            let _ = results.send((id.clone(), Out::Next(text)));
            let _ = results.send((id, Out::Complete));
            return;
        }
        Ok(Started::Stream(run)) => run,
    };
    loop {
        match run.next().await {
            Some(Ok(text)) => {
                if results.send((id.clone(), Out::Next(text))).is_err() {
                    return;
                }
            }
            Some(Err(_)) => {
                let _ = results.send((id, Out::Failed));
                return;
            }
            None => {
                let _ = results.send((id, Out::Complete));
                return;
            }
        }
    }
}
