use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use canopy_config::TrustedProxy;
use canopy_realtime::{Body, HttpRoutes, full};
use hyper::body::{Bytes, Incoming};
use hyper::{HeaderMap, Request, Response, StatusCode};

use crate::client_address;
use crate::data_plane::DataPlane;
use crate::graphql_ws;
use crate::proxy::{Pool, Upstream, forward};
use crate::studio::Studio;

pub(crate) struct Routes {
    pub(crate) inspector: Option<Arc<crate::realtime_inspection::InternalInspector>>,
    pub(crate) ready: Arc<AtomicBool>,
    pub(crate) trusted_proxies: Vec<TrustedProxy>,
    pub(crate) proxy: Option<Upstream>,
    /// The Data API routes the gateway serves itself, when `dataPlane.routes` selects any.
    pub(crate) data_plane: Option<DataPlane>,
    /// Studio assets on the shared listener.
    pub(crate) studio: Option<Studio>,
    pub(crate) admin: Option<(Arc<crate::control::Admin>, canopy_realtime::EngineSender)>,
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
        let path = request.uri().path();
        if path == crate::realtime_inspection::PATH {
            return match &self.routes.inspector {
                Some(inspector) => inspector.serve(request).await,
                None => reply(StatusCode::NOT_FOUND, "Not found"),
            };
        }
        if let Some((admin, engine)) = &self.routes.admin
            && (path == "/admin/v1" || path.starts_with("/admin/v1/"))
        {
            return crate::control::handle(
                admin,
                request,
                peer,
                &self.routes.trusted_proxies,
                Some(engine),
                None,
            )
            .await;
        }
        if let Some(studio) = &self.routes.studio
            && Studio::matches(request.uri().path())
        {
            return studio.serve(request).await;
        }
        if let Some(graphql) = self.routes.data_plane.as_ref().and_then(DataPlane::graphql)
            && graphql_ws::wants(graphql, &request)
        {
            let address = self.client_address(request.headers(), peer);
            return graphql_ws::upgrade(Arc::clone(&self.routes), request, address);
        }
        if let Some(data_plane) = &self.routes.data_plane
            && data_plane.owns(&request)
        {
            let address = self.client_address(request.headers(), peer);
            return data_plane.serve(request, address, peer).await;
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
