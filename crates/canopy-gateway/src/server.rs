use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use canopy_config::TrustedProxy;
use canopy_realtime::{Body, HttpRoutes, full};
use hyper::body::{Bytes, Incoming};
use hyper::{HeaderMap, Request, Response, StatusCode};

use crate::client_address;
use crate::data_plane::DataPlane;
use crate::proxy::{Pool, Upstream, forward};

pub(crate) struct Routes {
    pub(crate) ready: Arc<AtomicBool>,
    pub(crate) trusted_proxies: Vec<TrustedProxy>,
    pub(crate) proxy: Option<Upstream>,
    /// The Data API routes the gateway serves itself, when `dataPlane.routes` selects any.
    pub(crate) data_plane: Option<DataPlane>,
}

pub(crate) struct ShardRoutes {
    routes: Arc<Routes>,
    pool: Pool,
}

impl ShardRoutes {
    pub(crate) fn new(routes: Arc<Routes>) -> Self {
        Self { routes, pool: Pool::default() }
    }
}

impl HttpRoutes for ShardRoutes {
    fn client_address(&self, headers: &HeaderMap, peer: &str) -> String {
        client_address::resolve(headers, peer, &self.routes.trusted_proxies).to_owned()
    }

    async fn fallback(&self, request: Request<Incoming>, peer: &str) -> Response<Body> {
        if let Some(data_plane) = &self.routes.data_plane
            && data_plane.owns(&request)
            && let Some(response) = data_plane.serve(&request).await
        {
            return response;
        }
        let upstream = self.routes.proxy.as_ref();
        match request.uri().path() {
            "/healthz" if upstream.is_none() => reply(StatusCode::OK, "ok"),
            "/readyz" if !self.routes.ready.load(Ordering::Acquire) => {
                reply(StatusCode::SERVICE_UNAVAILABLE, "not ready: change stream")
            }
            "/readyz" if upstream.is_none() => reply(StatusCode::OK, "ok"),
            _ => match upstream {
                Some(upstream) => forward(upstream, &self.pool, request, peer).await,
                None => reply(StatusCode::NOT_FOUND, "Not found"),
            },
        }
    }
}

fn reply(status: StatusCode, body: &'static str) -> Response<Body> {
    full(status, Bytes::from_static(body.as_bytes()))
}
