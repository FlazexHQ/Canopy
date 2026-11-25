use std::sync::Arc;
use std::time::Duration;

use canopy_control::{BoxFuture, InspectionQuery, Inspector};
use canopy_protocol::{CanopyError, ErrorCode, Value, ejson};
use canopy_realtime::{Body, EngineSender, full};
use http_body_util::{BodyExt as _, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use ring::hmac;

use crate::control::{LocalInspector, env, tail_body};

pub(crate) const PATH: &str = "/internal/realtime";

fn proof(key: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    canopy_protocol::hex(hmac::sign(&key, b"canopy realtime inspection v1").as_ref())
}

fn unavailable() -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, "The realtime engine is unavailable")
}

#[derive(Clone)]
pub(crate) struct RemoteInspector {
    client: reqwest::Client,
    url: reqwest::Url,
    proof: String,
}

impl RemoteInspector {
    pub(crate) fn configured() -> Result<Option<Self>, String> {
        let Some(url) = env("CANOPY_REALTIME_INTERNAL_URL") else { return Ok(None) };
        let key = env("CANOPY_MASTER_KEY").ok_or("Realtime inspection requires CANOPY_MASTER_KEY")?;
        let mut url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Invalid CANOPY_REALTIME_INTERNAL_URL".to_owned());
        }
        url.set_path(PATH);
        url.set_query(None);
        url.set_fragment(None);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(2))
            .read_timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Some(Self { client, url, proof: proof(&key) }))
    }

    async fn request(&self, query: &str, id: Option<&str>) -> Result<reqwest::Response, CanopyError> {
        let mut url = self.url.clone();
        url.query_pairs_mut().append_pair("query", query);
        if let Some(id) = id {
            url.query_pairs_mut().append_pair("id", id);
        }
        tokio::time::timeout(Duration::from_secs(6), self.client.get(url).bearer_auth(&self.proof).send())
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())
    }

    pub(crate) async fn tail(&self) -> Option<Body> {
        let response = self.request("stream", None).await.ok()?;
        if response.status() != StatusCode::OK {
            return None;
        }
        let frames = futures_util::stream::try_unfold(response, |mut response| async move {
            Ok::<_, reqwest::Error>(response.chunk().await?.map(|bytes| (Frame::data(bytes), response)))
        });
        Some(StreamBody::new(frames).map_err(Into::into).boxed_unsync())
    }
}

impl Inspector for RemoteInspector {
    fn read(&self, query: InspectionQuery) -> BoxFuture<'_, Result<Option<Value>, CanopyError>> {
        Box::pin(async move {
            let (name, id) = match &query {
                InspectionQuery::Stats => ("stats", None),
                InspectionQuery::Connections => ("connections", None),
                InspectionQuery::Observers => ("observers", None),
                InspectionQuery::Events => ("events", None),
                InspectionQuery::Trace { id, viewer } => {
                    (if *viewer { "masked" } else { "trace" }, Some(id.as_str()))
                }
                InspectionQuery::Tail => ("tail", None),
            };
            let response = self.request(name, id).await?;
            if response.status() == StatusCode::NO_CONTENT {
                return Ok(None);
            }
            if response.status() != StatusCode::OK {
                return Err(unavailable());
            }
            let bytes = tokio::time::timeout(Duration::from_secs(5), response.bytes())
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
            let text = std::str::from_utf8(&bytes).map_err(|_| unavailable())?;
            ejson::parse(text, ejson::DecodeOptions::default()).map(Some).map_err(|_| unavailable())
        })
    }
}

pub(crate) struct InternalInspector {
    engine: EngineSender,
    key: hmac::Key,
}

impl InternalInspector {
    pub(crate) fn new(engine: EngineSender, master: &str) -> Arc<Self> {
        let key = hmac::Key::new(hmac::HMAC_SHA256, proof(master).as_bytes());
        Arc::new(Self { engine, key })
    }

    pub(crate) async fn serve(&self, request: Request<Incoming>) -> Response<Body> {
        let authorized = request
            .headers()
            .get("authorization")
            .and_then(|header| header.to_str().ok())
            .and_then(|header| header.strip_prefix("Bearer "))
            .filter(|candidate| {
                candidate.len() == 64 && candidate.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .is_some_and(|candidate| {
                let candidate = hmac::Key::new(hmac::HMAC_SHA256, candidate.as_bytes());
                let tag = hmac::sign(&candidate, b"verify");
                hmac::verify(&self.key, b"verify", tag.as_ref()).is_ok()
            });
        if request.method() != Method::GET || !authorized {
            return full(StatusCode::NOT_FOUND, "");
        }
        let Ok(url) = reqwest::Url::parse(&format!(
            "http://localhost{PATH}?{}",
            request.uri().query().unwrap_or_default()
        )) else {
            return full(StatusCode::BAD_REQUEST, "");
        };
        let params = url.query_pairs();
        let query = params.clone().find(|(name, _)| name == "query").map(|(_, value)| value);
        let query = match query.as_deref() {
            Some("stats") => InspectionQuery::Stats,
            Some("connections") => InspectionQuery::Connections,
            Some("observers") => InspectionQuery::Observers,
            Some("events") => InspectionQuery::Events,
            Some("trace" | "masked") => InspectionQuery::Trace {
                id: params
                    .clone()
                    .find(|(name, _)| name == "id")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default(),
                viewer: query.as_deref() == Some("masked"),
            },
            Some("tail") => InspectionQuery::Tail,
            Some("stream") => {
                let receiver = self.engine.inspection_tail();
                if self.engine.inspect(|_| ()).await.is_err() {
                    return full(StatusCode::SERVICE_UNAVAILABLE, "");
                }
                return Response::new(tail_body(b": canopy realtime tail\n\n".to_vec(), receiver));
            }
            _ => return full(StatusCode::BAD_REQUEST, ""),
        };
        match LocalInspector(self.engine.clone()).read(query).await {
            Ok(Some(value)) => match ejson::stringify(&value) {
                Ok(text) => full(StatusCode::OK, text),
                Err(_) => full(StatusCode::INTERNAL_SERVER_ERROR, ""),
            },
            Ok(None) => full(StatusCode::NO_CONTENT, ""),
            Err(_) => full(StatusCode::SERVICE_UNAVAILABLE, ""),
        }
    }
}
