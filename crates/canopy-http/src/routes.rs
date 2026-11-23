use canopy_auth::Authenticator;
use canopy_data::{Encoding, FindRequest, ReadPath};
use canopy_protocol::{CanopyError, ErrorCode};
use ring::digest::{Context, SHA256};

use crate::credentials::credentials_from_headers;
use crate::negotiate::{negotiate, preferences_of, request_id_of};
use crate::params::{PageLimits, find_params_from_query};
use crate::paths::{segments_of, trim_trailing_slashes};
use crate::problem::{DEFAULT_PROBLEM_TYPE_BASE, Problem, problem_response};
use crate::request::{Request, Response};

/// The browser origins that may call the API from another origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cors {
    /// Every origin.
    Any,
    /// Only these origins.
    Origins(Vec<String>),
}

impl Cors {
    /// The value of `Access-Control-Allow-Origin` for a request from `origin`, or `None` when it is not allowed.
    fn allowed(&self, origin: Option<&str>) -> Option<String> {
        let origin = origin?;
        match self {
            Cors::Any => Some("*".to_owned()),
            Cors::Origins(origins) => {
                origins.iter().any(|allowed| allowed == origin).then(|| origin.to_owned())
            }
        }
    }
}

/// The request headers a browser may send, as a preflight answers.
const ALLOWED_HEADERS: &str =
    "apikey, authorization, content-type, accept, prefer, idempotency-key, x-request-id, if-none-match";

/// The response headers a browser may read.
const EXPOSED_HEADERS: &str = "x-request-id, x-canopy-ct, retry-after, location, etag";

/// Settings of the routes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestOptions {
    /// The path the API is served under. Defaults to `/rest/v1`.
    pub base_path: String,
    /// The prefix of Problem Details `type` URIs. Defaults to `urn:canopy:error:`.
    pub problem_type_base: String,
    /// The origins allowed to call from a browser on another origin. Without it no CORS headers are sent.
    pub cors: Option<Cors>,
}

impl Default for RestOptions {
    fn default() -> RestOptions {
        RestOptions {
            base_path: "/rest/v1".to_owned(),
            problem_type_base: DEFAULT_PROBLEM_TYPE_BASE.to_owned(),
            cors: None,
        }
    }
}

/// What a path and method resolve to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// `GET /{collection}`, served here.
    Find,
    /// A route the TypeScript handler serves.
    Unserved,
}

/// The Data API routes served by the Rust data plane.
pub struct Rest {
    authenticator: Authenticator,
    reads: ReadPath,
    base_path: String,
    problem_type_base: String,
    cors: Option<Cors>,
}

impl Rest {
    /// Creates the routes over a read path, authenticating callers with `authenticator`.
    pub fn new(authenticator: Authenticator, reads: ReadPath, options: RestOptions) -> Rest {
        Rest {
            authenticator,
            reads,
            base_path: trim_trailing_slashes(&options.base_path).to_owned(),
            problem_type_base: options.problem_type_base,
            cors: options.cors,
        }
    }

    /// Whether this crate answers a request: `GET` of a collection (`find`), `OPTIONS` of it, and the `405` of
    /// the methods the collection path does not take. Everything else below the base path (the other methods
    /// of a collection, a document, an action, a batch, the OpenAPI document, a path that is not valid) is the
    /// TypeScript handler's, and a gateway passes it on without looking at it.
    pub fn owns(&self, method: &str, target: &str) -> bool {
        let Some(url) = parse_target(target) else { return false };
        let Ok(Some(segments)) = segments_of(url.path(), &self.base_path) else { return false };
        match segments.as_slice() {
            [name] if name != "_batch" && name != "openapi.json" => {
                resolve(&segments, method).0 != Some(Route::Unserved)
            }
            _ => false,
        }
    }

    /// The read path.
    pub fn reads(&self) -> &ReadPath {
        &self.reads
    }

    /// Serves one request below the base path. Every response carries `X-Request-Id`: the caller's when it is
    /// a safe token, or a minted UUIDv7. Never fails: failures become Problem Details responses. Returns `None`
    /// for a route this crate does not serve, which the caller passes on to the TypeScript handler.
    pub async fn serve(&self, request: &Request) -> Option<Response> {
        let response = self.answer(request).await?;
        Some(self.with_cors(response, request))
    }

    async fn answer(&self, request: &Request) -> Option<Response> {
        let request_id = request_id_of(request);
        let target = request.target.as_str();
        let Some(url) = parse_target(target) else {
            let error = CanopyError::invalid_query("The request target is not valid");
            let problem = Problem::new(&error, target, &request_id, &self.problem_type_base);
            return Some(with_request_id(problem_response(&problem, None), &request_id));
        };
        let instance = url.path().to_owned();
        let response = match self.dispatch(request, &url, &request_id).await {
            Ok(Some(response)) => response,
            Ok(None) => return None,
            Err(error) => {
                let problem = Problem::new(&error, &instance, &request_id, &self.problem_type_base);
                problem_response(&problem, None)
            }
        };
        Some(with_request_id(response, &request_id))
    }

    async fn dispatch(
        &self,
        request: &Request,
        url: &url::Url,
        request_id: &str,
    ) -> Result<Option<Response>, CanopyError> {
        let segments = segments_of(url.path(), &self.base_path)?
            .ok_or_else(|| CanopyError::new(ErrorCode::NotFound, "Not found"))?;
        let (route, allow) = resolve(&segments, &request.method);
        if request.method == "OPTIONS" && !allow.is_empty() {
            let methods = allow.iter().copied().chain(["OPTIONS"]).collect::<Vec<_>>().join(", ");
            return Ok(Some(match &self.cors {
                Some(cors) => preflight(cors, request, &methods),
                None => Response::new(204).with_header("allow", methods),
            }));
        }
        if allow.is_empty() {
            return Err(CanopyError::new(ErrorCode::NotFound, "Not found"));
        }
        let Some(route) = route else {
            let error = CanopyError::invalid_query(format!("{} is not allowed here", request.method));
            let mut problem = Problem::new(&error, url.path(), request_id, &self.problem_type_base);
            problem.status = 405;
            return Ok(Some(problem_response(&problem, None).with_header("allow", allow.join(", "))));
        };
        match route {
            Route::Unserved => Ok(None),
            Route::Find => {
                let collection = segments.first().map_or("", String::as_str);
                self.find(request, url, collection).await.map(Some)
            }
        }
    }

    /// Adds the CORS response headers: `Vary: Origin` always, and the allowed origin and the exposed headers
    /// for an origin that may call.
    fn with_cors(&self, mut response: Response, request: &Request) -> Response {
        let Some(cors) = &self.cors else { return response };
        let origin = request.header("origin");
        append_header(&mut response, "vary", "Origin");
        if let Some(allowed) = cors.allowed(origin.as_deref()) {
            response.set_header("access-control-allow-origin", allowed);
            response.set_header("access-control-expose-headers", EXPOSED_HEADERS);
        }
        response
    }

    async fn find(
        &self,
        request: &Request,
        url: &url::Url,
        collection: &str,
    ) -> Result<Response, CanopyError> {
        let credentials = credentials_from_headers(request)?;
        let principal =
            self.authenticator.authenticate(&credentials.key, credentials.token.as_deref()).await?;
        let caller = self.reads.caller(&principal, Some(&[collection])).await?;
        let pairs: Vec<(String, String)> =
            url.query_pairs().map(|(name, value)| (name.into_owned(), value.into_owned())).collect();
        let limits = self.reads.limits();
        let params = find_params_from_query(
            &pairs,
            PageLimits { max_limit: limits.max_limit, max_skip: limits.max_skip },
            preferences_of(request).count,
        )?;
        for name in ["where", "upsert"] {
            if pairs.iter().any(|(key, _)| key == name) {
                return Err(CanopyError::invalid_query(format!("{name} only applies to writes")));
            }
        }
        let page = self
            .reads
            .find(
                &caller,
                FindRequest {
                    collection: collection.to_owned(),
                    filter: params.filter,
                    sort: params.sort,
                    fields: params.fields,
                    limit: params.limit,
                    skip: params.skip,
                    after: params.after,
                    count: params.count,
                },
            )
            .await?;
        let encoding = negotiate(request.header("accept").as_deref());
        let text = page.encode(encoding)?;
        let tag = validator(encoding, &text);
        let ct = page.ct.to_string();
        let matched = request
            .header("if-none-match")
            .is_some_and(|header| header.split(',').any(|value| value.trim() == tag));
        if matched {
            return Ok(Response::new(304).with_header("etag", tag).with_header("x-canopy-ct", ct));
        }
        Ok(Response::new(200)
            .with_header("content-type", content_type(encoding))
            .with_header("etag", tag)
            .with_header("x-canopy-ct", ct)
            .with_body(page.with_ct(&text)))
    }
}

fn parse_target(target: &str) -> Option<url::Url> {
    if target.starts_with('/') { url::Url::parse(&format!("http://canopy.test{target}")).ok() } else { None }
}

/// Answers a CORS preflight: no body, and the allowed origin only when the origin may call.
fn preflight(cors: &Cors, request: &Request, methods: &str) -> Response {
    let response = Response::new(204).with_header("vary", "Origin");
    match cors.allowed(request.header("origin").as_deref()) {
        None => response,
        Some(origin) => response
            .with_header("access-control-allow-origin", origin)
            .with_header("access-control-allow-methods", methods)
            .with_header("access-control-allow-headers", ALLOWED_HEADERS)
            .with_header("access-control-max-age", "600"),
    }
}

/// Appends a value to a header, joined with `, ` after the values it already has.
fn append_header(response: &mut Response, name: &str, value: &str) {
    let joined = match response.header(name) {
        Some(existing) => format!("{existing}, {value}"),
        None => value.to_owned(),
    };
    response.set_header(name, joined);
}

fn content_type(encoding: Encoding) -> &'static str {
    match encoding {
        Encoding::Canonical => "application/ejson",
        Encoding::Relaxed => "application/json; charset=utf-8",
    }
}

fn with_request_id(mut response: Response, request_id: &str) -> Response {
    response.set_header("x-request-id", request_id);
    response
}

const ACTIONS: [&str; 5] = ["_query", "_count", "_distinct", "_aggregate", "_explain"];

/// Picks the route of a path and method, and the methods the path allows, in the order the API lists them.
fn resolve(segments: &[String], method: &str) -> (Option<Route>, Vec<&'static str>) {
    let first = segments.first().map(String::as_str);
    let second = segments.get(1).map(String::as_str);
    let (table, find): (&[&'static str], bool) = match segments.len() {
        0 => (&["GET"], false),
        1 if first == Some("_batch") => (&["POST"], false),
        1 if first == Some("openapi.json") => (&["GET"], false),
        1 => (&["GET", "POST", "PATCH", "DELETE"], true),
        2 if second.is_some_and(|name| ACTIONS.contains(&name)) => (&["POST"], false),
        2 => (&["GET", "PATCH", "PUT", "DELETE"], false),
        _ => (&[], false),
    };
    let route = table.contains(&method).then_some(if find && method == "GET" {
        Route::Find
    } else {
        Route::Unserved
    });
    (route, table.to_vec())
}

/// The weak validator of a page: the first 32 hex digits of the SHA-256 of `"<encoding>:" + text`.
fn validator(encoding: Encoding, text: &str) -> String {
    let mut context = Context::new(&SHA256);
    context.update(encoding.as_str().as_bytes());
    context.update(b":");
    context.update(text.as_bytes());
    let digest = context.finish();
    let mut tag = String::with_capacity(36);
    tag.push_str("W/\"");
    for byte in &digest.as_ref()[..16] {
        tag.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        tag.push(char::from(b"0123456789abcdef"[usize::from(byte & 15)]));
    }
    tag.push('"');
    tag
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(path: &[&str]) -> Vec<String> {
        path.iter().map(|segment| (*segment).to_owned()).collect()
    }

    #[test]
    fn the_collection_route_serves_get_and_lists_the_methods_of_the_api() {
        assert_eq!(
            resolve(&segments(&["todos"]), "GET"),
            (Some(Route::Find), vec!["GET", "POST", "PATCH", "DELETE"])
        );
        assert_eq!(resolve(&segments(&["todos"]), "POST").0, Some(Route::Unserved));
        assert_eq!(resolve(&segments(&["todos"]), "PUT").0, None);
        assert_eq!(resolve(&segments(&["todos"]), "get").0, None);
    }

    #[test]
    fn other_paths_are_not_served_here_but_keep_their_methods() {
        assert_eq!(resolve(&[], "GET"), (Some(Route::Unserved), vec!["GET"]));
        assert_eq!(resolve(&segments(&["openapi.json"]), "GET").0, Some(Route::Unserved));
        assert_eq!(resolve(&segments(&["_batch"]), "POST").0, Some(Route::Unserved));
        assert_eq!(resolve(&segments(&["_batch"]), "GET"), (None, vec!["POST"]));
        assert_eq!(resolve(&segments(&["todos", "_count"]), "POST").0, Some(Route::Unserved));
        assert_eq!(
            resolve(&segments(&["todos", "7"]), "GET"),
            (Some(Route::Unserved), vec!["GET", "PATCH", "PUT", "DELETE"])
        );
        assert_eq!(resolve(&segments(&["a", "b", "c"]), "GET"), (None, vec![]));
    }
}
