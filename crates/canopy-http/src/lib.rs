//! Canopy's Data API routes over plain request and response types: a method, a request target and headers go
//! in, a status, headers and body bytes come out. There is no HTTP server or framework here, so the same
//! routes serve a Hyper listener, a test, or an embedding host.
//!
//! The read routes answer exactly as the TypeScript `@canopy/rest` handler does. `find`
//! (`GET /rest/v1/{collection}`): credentials from the `apikey` and `Authorization` headers, query parameters
//! and shorthand filters typed by their text, content negotiation between relaxed and canonical EJSON,
//! `Prefer: count=...`, a weak `ETag` with `If-None-Match` answering `304` and the cluster time in
//! `X-Canopy-Ct`. `_count`, `_distinct` and `_aggregate` (`POST /rest/v1/{collection}/...`): an EJSON body of
//! at most the configured size, the policy prefix in front of a sanitized pipeline, and the cluster time in the
//! body. Every response carries a request id and every failure is Problem Details. Each route is served only
//! when selected; the others are reported as not handled (`Rest::owns` says which requests are served here),
//! so a gateway can pass them on.

mod credentials;
mod negotiate;
mod params;
mod paths;
mod problem;
mod request;
mod routes;

pub use credentials::{Credentials, credentials_from_headers};
pub use negotiate::{Preferences, negotiate, preferences_of, request_id_of, uuid_v7};
pub use params::{PageLimits, find_params_from_query};
pub use problem::{DEFAULT_PROBLEM_TYPE_BASE, PROBLEM_MEDIA_TYPE, Problem, problem_response, problem_slug};
pub use request::{Body, Request, Response};
pub use routes::{Cors, DEFAULT_MAX_BODY_BYTES, Rest, RestOptions, Served, request_path};
