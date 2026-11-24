//! The front door: every request the gateway does not serve itself goes to an upstream HTTP server, so one public
//! port carries realtime and the rest of the API. WebSocket upgrades on other paths (GraphQL subscriptions, for
//! one) are tunneled to the upstream byte for byte.

use std::cell::RefCell;

use canopy_realtime::{Body, full};
use http_body_util::{BodyExt, Empty};
use hyper::body::{Bytes, Incoming};
use hyper::client::conn::http1::SendRequest;
use hyper::header::{CONNECTION, HOST, HeaderMap, HeaderName, HeaderValue, UPGRADE};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

/// Idle upstream connections a shard keeps for reuse.
const POOL_SIZE: usize = 32;

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
];

/// Where the proxied requests go: `host:port` of a plain HTTP server, normally the TypeScript server on loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Upstream {
    /// `host:port`.
    pub(crate) authority: String,
}

impl Upstream {
    /// Reads `http://host:port`, the only form accepted: the upstream runs beside the gateway, never across a
    /// network that would need TLS.
    pub(crate) fn parse(url: &str) -> Result<Self, String> {
        let rest = url.strip_prefix("http://").ok_or("proxy.url must start with http://")?;
        let authority = rest.trim_end_matches('/');
        if authority.is_empty() || authority.contains('/') || !authority.contains(':') {
            return Err("proxy.url must be http://host:port, without a path".to_owned());
        }
        Ok(Self { authority: authority.to_owned() })
    }
}

/// Upstream connections of one shard.
#[derive(Default)]
pub(crate) struct Pool {
    idle: RefCell<Vec<SendRequest<Body>>>,
}

impl Pool {
    fn take(&self) -> Option<SendRequest<Body>> {
        let mut idle = self.idle.borrow_mut();
        idle.retain(|sender| !sender.is_closed());
        let index = idle.iter().position(SendRequest::is_ready)?;
        Some(idle.swap_remove(index))
    }

    fn give(&self, sender: SendRequest<Body>) {
        let mut idle = self.idle.borrow_mut();
        if idle.len() < POOL_SIZE && !sender.is_closed() {
            idle.push(sender);
        }
    }
}

async fn connect(upstream: &Upstream, upgrades: bool) -> Result<SendRequest<Body>, String> {
    let stream =
        tokio::net::TcpStream::connect(upstream.authority.as_str()).await.map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    let (sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    if upgrades {
        tokio::task::spawn_local(async move {
            let _ = connection.with_upgrades().await;
        });
    } else {
        tokio::task::spawn_local(async move {
            let _ = connection.await;
        });
    }
    Ok(sender)
}

fn strip_hop_by_hop(headers: &mut HeaderMap, keep_upgrade: bool) {
    let named: Vec<HeaderName> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .filter(|name| !(keep_upgrade && *name == UPGRADE))
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    if !keep_upgrade {
        headers.remove(UPGRADE);
    }
}

pub(crate) fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        && headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .any(|value| value.split(',').any(|token| token.trim().eq_ignore_ascii_case("upgrade")))
}

/// Adds the client to `X-Forwarded-For` and fills `X-Forwarded-Host` and `X-Forwarded-Proto` when no proxy in
/// front of the gateway set them.
fn forwarded(headers: &mut HeaderMap, peer: &str) {
    let chain = match headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()) {
        Some(previous) if !previous.trim().is_empty() => format!("{previous}, {peer}"),
        _ => peer.to_owned(),
    };
    if let Ok(value) = HeaderValue::from_str(&chain) {
        headers.insert("x-forwarded-for", value);
    }
    if !headers.contains_key("x-forwarded-host")
        && let Some(host) = headers.get(HOST).cloned()
    {
        headers.insert("x-forwarded-host", host);
    }
    if !headers.contains_key("x-forwarded-proto") {
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    }
}

fn bad_gateway() -> Response<Body> {
    full(StatusCode::BAD_GATEWAY, Bytes::from_static(b"The upstream server is not reachable"))
}

/// Sends a request to the upstream and returns its response, streaming both bodies. An upgrade that the upstream
/// accepts becomes a tunnel between the two connections.
pub(crate) async fn forward(
    upstream: &Upstream,
    pool: &Pool,
    mut request: Request<Incoming>,
    peer: &str,
) -> Response<Body> {
    let upgrade = is_upgrade(request.headers());
    let client_upgrade = upgrade.then(|| hyper::upgrade::on(&mut request));
    let (mut parts, body) = request.into_parts();
    strip_hop_by_hop(&mut parts.headers, upgrade);
    if upgrade {
        parts.headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
    }
    forwarded(&mut parts.headers, peer);
    let path = parts.uri.path_and_query().map_or("/", |path| path.as_str());
    let Ok(uri) = path.parse::<hyper::Uri>() else { return bad_gateway() };
    parts.uri = uri;
    let out_body: Body = if upgrade {
        Empty::<Bytes>::new().map_err(|never| match never {}).boxed_unsync()
    } else {
        body.boxed_unsync()
    };
    let outgoing = Request::from_parts(parts, out_body);
    let sender = match if upgrade { None } else { pool.take() } {
        Some(sender) => Ok(sender),
        None => connect(upstream, upgrade).await,
    };
    let Ok(mut sender) = sender else { return bad_gateway() };
    let Ok(mut response) = sender.send_request(outgoing).await else { return bad_gateway() };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        if let Some(client_upgrade) = client_upgrade {
            tokio::task::spawn_local(async move {
                let (Ok(client), Ok(server)) = (client_upgrade.await, upstream_upgrade.await) else { return };
                let _ =
                    tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(server)).await;
            });
        }
        let (parts, _) = response.into_parts();
        return Response::from_parts(parts, full(StatusCode::SWITCHING_PROTOCOLS, Bytes::new()).into_body());
    }
    if !upgrade {
        pool.give(sender);
    }
    let (mut parts, body) = response.into_parts();
    strip_hop_by_hop(&mut parts.headers, false);
    Response::from_parts(parts, body.boxed_unsync())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_plain_http_authority() {
        assert_eq!(
            Upstream::parse("http://127.0.0.1:8081/"),
            Ok(Upstream { authority: "127.0.0.1:8081".to_owned() })
        );
        assert!(Upstream::parse("https://127.0.0.1:8081").is_err());
        assert!(Upstream::parse("http://127.0.0.1:8081/rest").is_err());
        assert!(Upstream::parse("http://localhost").is_err());
    }

    #[test]
    fn strips_hop_by_hop_headers_and_keeps_an_upgrade() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("Upgrade, x-private"));
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert("x-private", HeaderValue::from_static("1"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        headers.insert("apikey", HeaderValue::from_static("pk"));
        assert!(is_upgrade(&headers));
        let mut kept = headers.clone();
        strip_hop_by_hop(&mut kept, true);
        assert!(kept.contains_key(UPGRADE));
        assert!(!kept.contains_key("x-private"));
        assert!(!kept.contains_key("keep-alive"));
        assert!(kept.contains_key("apikey"));
        strip_hop_by_hop(&mut headers, false);
        assert!(!headers.contains_key(UPGRADE));
    }

    #[test]
    fn appends_the_peer_to_the_forwarded_chain() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("api.example"));
        forwarded(&mut headers, "10.0.0.5");
        assert_eq!(headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()), Some("10.0.0.5"));
        assert_eq!(headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()), Some("api.example"));
        assert_eq!(headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()), Some("http"));
        forwarded(&mut headers, "127.0.0.1");
        assert_eq!(headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()), Some("10.0.0.5, 127.0.0.1"));
    }
}
