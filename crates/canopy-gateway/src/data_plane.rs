//! The Data API routes the gateway serves itself: the request is handed to `canopy-http` over plain types and
//! its answer goes back as a Hyper response. Every request the routes do not own never reaches this module.

use canopy_auth::Authenticator;
use canopy_config::{Cors, GatewayConfig};
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_http::{Rest, RestOptions};
use canopy_mongo::mongodb::Client;
use canopy_policy::{PolicyEngine, PolicySet};
use canopy_realtime::{Body, EngineSender, full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};

/// The routes of `dataPlane.routes` and the policies they read under.
pub(crate) struct DataPlane {
    rest: Rest,
}

impl DataPlane {
    /// Builds the routes over the gateway's own MongoDB client, with the authenticator the realtime sessions use
    /// and the policies the engine started with.
    pub(crate) fn new(
        config: &GatewayConfig,
        client: Client,
        auth: Authenticator,
        policies: Policies,
    ) -> DataPlane {
        let limits = ReadLimits {
            default_limit: config.rest_limits.default_limit,
            max_limit: config.rest_limits.max_limit,
            max_skip: config.rest_limits.max_skip,
            ..ReadLimits::default()
        };
        let reads = ReadPath::new(client, &config.database, policies, limits);
        let cors = config.cors.as_ref().map(|cors| match cors {
            Cors::Any => canopy_http::Cors::Any,
            Cors::Origins(origins) => canopy_http::Cors::Origins(origins.clone()),
        });
        DataPlane { rest: Rest::new(auth, reads, RestOptions { cors, ..RestOptions::default() }) }
    }

    /// Whether the routes answer this request. A request that is not owned goes to the upstream server untouched.
    pub(crate) fn owns<B>(&self, request: &Request<B>) -> bool {
        let target = request.uri().path_and_query().map_or("", |target| target.as_str());
        self.rest.owns(request.method().as_str(), target)
    }

    /// Answers an owned request. `None` when the routes decline it after all, so the caller passes it on.
    pub(crate) async fn serve(&self, request: &Request<Incoming>) -> Option<Response<Body>> {
        let target = request.uri().path_and_query().map_or("", |target| target.as_str());
        let mut plain = canopy_http::Request::new(request.method().as_str(), target);
        for (name, value) in request.headers() {
            plain
                .headers
                .push((name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned()));
        }
        self.rest.serve(&plain).await.map(response_of)
    }
}

fn response_of(plain: canopy_http::Response) -> Response<Body> {
    let status = StatusCode::from_u16(plain.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = full(status, Bytes::from(plain.body));
    for (name, value) in plain.headers {
        if let (Ok(name), Ok(value)) =
            (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value))
        {
            response.headers_mut().append(name, value);
        }
    }
    response
}

/// Where a policy set goes: the realtime engine, and the Data API routes when the gateway serves any.
#[derive(Clone)]
pub(crate) struct PolicyUpdates {
    engine: EngineSender,
    data: Option<Policies>,
}

impl PolicyUpdates {
    pub(crate) fn new(engine: EngineSender, data: Option<Policies>) -> PolicyUpdates {
        PolicyUpdates { engine, data }
    }

    /// Applies a policy set to every reader. A set that is already in force changes nothing.
    pub(crate) fn publish(&self, set: PolicySet) {
        if let Some(data) = &self.data
            && data.current().version() != set.version()
        {
            data.replace(PolicyEngine::new(set.clone()));
        }
        self.engine.set_policies(set);
    }
}
