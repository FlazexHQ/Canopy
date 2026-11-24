use std::collections::HashMap;
use std::sync::Arc;

use canopy_auth::{Authenticator, RateLimits, rate_limit_error};
use canopy_data::writes::{IdType, WritePath};
use canopy_data::{Caller, CountMode, Encoding, FindRequest, ReadPath};
use canopy_policy::{
    ExplainRequest, Operation, Role, access_report_document, explain_access, explain_context,
};
use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse, stringify};
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use canopy_query::js_property_order;
use ring::digest::{Context, SHA256};

use crate::credentials::credentials_from_headers;
use crate::negotiate::{negotiate, preferences_of, request_id_of};
use crate::params::{FindParams, PageLimits, find_params_from_body, find_params_from_query};
use crate::paths::{segments_of, trim_trailing_slashes};
use crate::problem::{DEFAULT_PROBLEM_TYPE_BASE, Problem, problem_response};
use crate::request::{Body, Request, Response};

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
    pub fn allowed(&self, origin: Option<&str>) -> Option<String> {
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

/// The Data API routes served here; the others are left to the TypeScript handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Served {
    /// `GET /{collection}`.
    pub find: bool,
    /// `POST /{collection}/_count`.
    pub count: bool,
    /// `POST /{collection}/_distinct`.
    pub distinct: bool,
    /// `POST /{collection}/_aggregate`.
    pub aggregate: bool,
    /// `POST /{collection}/_query`, a find with its parameters in a body.
    pub query: bool,
    /// `POST /{collection}/_explain`, how DLS decides an operation for a stated caller (service callers only).
    pub explain: bool,
    /// `GET /{collection}/{id}`, one document by its `_id`.
    pub document: bool,
    /// The writes: `POST`, `PATCH` and `DELETE /{collection}`, `PATCH`, `PUT` and `DELETE
    /// /{collection}/{id}`, and `POST /_batch`. They need a write path ([`Rest::with_writes`]).
    pub writes: bool,
}

impl Default for Served {
    fn default() -> Served {
        Served {
            find: true,
            count: false,
            distinct: false,
            aggregate: false,
            query: false,
            explain: false,
            document: false,
            writes: false,
        }
    }
}

/// The largest request body when none is configured: 1 MiB.
pub const DEFAULT_MAX_BODY_BYTES: u64 = 1024 * 1024;

/// JSON request bodies the routes accept.
const JSON_TYPES: [&str; 2] = ["application/json", "application/ejson"];

/// Settings of the routes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestOptions {
    /// The path the API is served under. Defaults to `/rest/v1`.
    pub base_path: String,
    /// The prefix of Problem Details `type` URIs. Defaults to `urn:canopy:error:`.
    pub problem_type_base: String,
    /// The origins allowed to call from a browser on another origin. Without it no CORS headers are sent.
    pub cors: Option<Cors>,
    /// The routes served here. Defaults to `find` alone.
    pub served: Served,
    /// The largest request body, in bytes. Defaults to 1 MiB.
    pub max_body_bytes: u64,
}

impl Default for RestOptions {
    fn default() -> RestOptions {
        RestOptions {
            base_path: "/rest/v1".to_owned(),
            problem_type_base: DEFAULT_PROBLEM_TYPE_BASE.to_owned(),
            cors: None,
            served: Served::default(),
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
        }
    }
}

/// What a path and method resolve to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// `GET /{collection}`, served here.
    Find,
    /// `POST /{collection}/_count`, served here.
    Count,
    /// `POST /{collection}/_distinct`, served here.
    Distinct,
    /// `POST /{collection}/_aggregate`, served here.
    Aggregate,
    /// `POST /{collection}/_query`, served here.
    Query,
    /// `POST /{collection}/_explain`, served here.
    Explain,
    /// `GET /{collection}/{id}`.
    Document,
    /// `POST /{collection}`.
    Insert,
    /// `PATCH /{collection}` with `Prefer: bulk=true`.
    UpdateMany,
    /// `DELETE /{collection}` with `Prefer: bulk=true`.
    DeleteMany,
    /// `PATCH /{collection}/{id}`.
    Update,
    /// `PUT /{collection}/{id}`.
    Replace,
    /// `DELETE /{collection}/{id}`.
    Delete,
    /// `POST /_batch`.
    Batch,
    /// A route the TypeScript handler serves.
    Unserved,
}

/// The Data API routes served by the Rust data plane.
pub struct Rest {
    authenticator: Authenticator,
    pub(crate) reads: ReadPath,
    pub(crate) base_path: String,
    pub(crate) problem_type_base: String,
    cors: Option<Cors>,
    served: Served,
    max_body_bytes: u64,
    rate_limits: Option<Arc<RateLimits>>,
    on_rate_limited: Option<Arc<dyn Fn() + Send + Sync>>,
    pub(crate) writes: Option<Arc<WritePath>>,
    pub(crate) id_types: HashMap<String, IdType>,
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
            served: options.served,
            max_body_bytes: options.max_body_bytes,
            rate_limits: None,
            on_rate_limited: None,
            writes: None,
            id_types: HashMap::new(),
        }
    }

    /// Serves the writes through `writes`, reading the `{id}` of a collection's documents as `id_types` says
    /// (`auto` for collections it does not name).
    #[must_use]
    pub fn with_writes(mut self, writes: Arc<WritePath>, id_types: HashMap<String, IdType>) -> Rest {
        self.writes = Some(writes);
        self.id_types = id_types;
        self
    }

    /// Applies request rate limits, as the TypeScript handler does with `rateLimits`: an address that has used
    /// up its failed authentications is refused before its credentials are checked, and a caller over its
    /// request budget after them, with `429` and `Retry-After`. `on_rate_limited` is called for every refusal.
    #[must_use]
    pub fn with_rate_limits(
        mut self,
        limits: Arc<RateLimits>,
        on_rate_limited: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Rest {
        self.rate_limits = Some(limits);
        self.on_rate_limited = on_rate_limited;
        self
    }

    fn limited(&self, wait_ms: u64) -> CanopyError {
        if let Some(count) = &self.on_rate_limited {
            count();
        }
        rate_limit_error(wait_ms)
    }

    /// The largest request body the routes read, in bytes. A transport stops reading beyond it and passes
    /// [`Body::TooLarge`].
    pub fn max_body_bytes(&self) -> u64 {
        self.max_body_bytes
    }

    /// Whether this crate answers a request: on the paths of the routes served here (a collection for `find`,
    /// `/{collection}/_count`, `_distinct` and `_aggregate`), their own method, `OPTIONS` and the `405` of the
    /// methods the path does not take. Everything else below the base path (the other methods of a collection,
    /// a document, the other actions, a batch, the OpenAPI document, a path that is not valid) is the TypeScript
    /// handler's, and a gateway passes it on without looking at it.
    pub fn owns(&self, method: &str, target: &str) -> bool {
        let Some(url) = parse_target(target) else { return false };
        let Ok(Some(segments)) = segments_of(url.path(), &self.base_path) else { return false };
        self.serves_path(&segments) && resolve(&segments, method, self.served).0 != Some(Route::Unserved)
    }

    /// Whether the path belongs to a route served here.
    fn serves_path(&self, segments: &[String]) -> bool {
        let writes = self.served.writes && self.writes.is_some();
        match segments {
            [name] if name == "_batch" => writes,
            [name] => name != "openapi.json" && (self.served.find || writes),
            [_, action] => match action.as_str() {
                "_count" => self.served.count,
                "_distinct" => self.served.distinct,
                "_aggregate" => self.served.aggregate,
                "_query" => self.served.query,
                "_explain" => self.served.explain,
                _ => writes || self.served.document,
            },
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
                problem_response(&problem, retry_after(&error))
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
        if !self.serves_path(&segments) {
            return Ok(None);
        }
        let served = Served { writes: self.served.writes && self.writes.is_some(), ..self.served };
        let (route, allow) = resolve(&segments, &request.method, served);
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
        let collection = segments.first().map_or("", String::as_str);
        match route {
            Route::Unserved => Ok(None),
            Route::Find => self.find(request, url, collection).await.map(Some),
            Route::Count => self.count(request, collection).await.map(Some),
            Route::Distinct => self.distinct(request, collection).await.map(Some),
            Route::Aggregate => self.aggregate(request, collection).await.map(Some),
            Route::Query => self.query(request, collection).await.map(Some),
            Route::Explain => self.explain(request, collection).await.map(Some),
            Route::Document => self.document(request, url, collection, &segments[1]).await.map(Some),
            Route::Insert => self.insert(request, collection).await.map(Some),
            Route::UpdateMany => self.update_many(request, collection).await.map(Some),
            Route::DeleteMany => self.delete_many(request, collection).await.map(Some),
            Route::Update => self.update(request, collection, &segments[1]).await.map(Some),
            Route::Replace => self.replace(request, collection, &segments[1]).await.map(Some),
            Route::Delete => self.remove(request, collection, &segments[1]).await.map(Some),
            Route::Batch => self.batch(request, request_id, url.path()).await.map(Some),
        }
    }

    /// The caller of a request: its credentials verified and the context lookups the policies of `collections`
    /// need resolved (every collection when `None`).
    /// The caller of a request: its API key and token verified, its context lookups resolved for every
    /// collection, a view token refused, and the request rate limits applied (a `CANOPY_RATE_LIMITED` error
    /// when the caller or its address is over its budget).
    pub async fn caller_of(&self, request: &Request) -> Result<Caller, CanopyError> {
        self.caller(request, None).await
    }

    /// The caller of a request, with the contexts the policies of `collections` need resolved, under the same
    /// credentials checks and rate limits as the Data API routes.
    pub async fn caller_for(&self, request: &Request, collections: &[&str]) -> Result<Caller, CanopyError> {
        self.caller(request, Some(collections)).await
    }

    /// The write path, when writes are served.
    pub fn write_path(&self) -> Option<&Arc<WritePath>> {
        self.writes.as_ref()
    }

    pub(crate) async fn caller(
        &self,
        request: &Request,
        collections: Option<&[&str]>,
    ) -> Result<Caller, CanopyError> {
        let credentials = credentials_from_headers(request)?;
        let authenticate = self.authenticator.authenticate(&credentials.key, credentials.token.as_deref());
        let Some(limits) = &self.rate_limits else {
            return self.reads.caller(&authenticate.await?, collections).await;
        };
        let address = request.client_address.as_deref().unwrap_or("unknown");
        let wait = limits.authentication_blocked(address);
        if wait > 0 {
            return Err(self.limited(wait));
        }
        let principal = match authenticate.await {
            Ok(principal) => principal,
            Err(error) => {
                if error.code() == ErrorCode::Unauthorized {
                    limits.authentication_failed(address);
                }
                return Err(error);
            }
        };
        if principal.read_only {
            return Err(CanopyError::named(
                ErrorCode::Forbidden,
                "ForbiddenError",
                "A view token only follows data over realtime",
            ));
        }
        let key = principal.key_id.as_deref().unwrap_or(&credentials.key);
        let wait = limits.request(Some(key), &principal.subject, &principal.roles, address);
        if wait > 0 {
            return Err(self.limited(wait));
        }
        self.reads.caller(&principal, collections).await
    }

    /// Reads and decodes an EJSON request body. An empty body reads as `None`. Fails with
    /// `CANOPY_PAYLOAD_TOO_LARGE` beyond the limit, and with an invalid query error for other media types, text
    /// that is not UTF-8 and malformed JSON.
    fn body(&self, request: &Request) -> Result<Option<Value>, CanopyError> {
        Ok(self.body_of(request, &JSON_TYPES)?.map(|(value, _)| value))
    }

    /// Reads and decodes an EJSON request body of one of the `accepted` media types, with its media type.
    pub(crate) fn body_of(
        &self,
        request: &Request,
        accepted: &[&str],
    ) -> Result<Option<(Value, String)>, CanopyError> {
        read_body(request, self.max_body_bytes, accepted)
    }

    /// Counts a request that carries no credentials, such as a read of a public file, against its client
    /// address under `key`, as an anonymous caller. Fails with `CANOPY_RATE_LIMITED` once the budget is spent.
    pub fn limit_anonymous(&self, request: &Request, key: &str) -> Result<(), CanopyError> {
        let (Some(limits), Some(address)) = (&self.rate_limits, request.client_address.as_deref()) else {
            return Ok(());
        };
        let roles: canopy_policy::Roles = [canopy_policy::Role::ANON].into_iter().collect();
        let wait = limits.request(Some(key), "anon", &roles, address);
        if wait > 0 {
            return Err(self.limited(wait));
        }
        Ok(())
    }

    /// Checks a body document against the fields a route takes.
    fn fields<'a>(input: &'a Value, route: &str, allowed: &[&str]) -> Result<&'a Document, CanopyError> {
        let Value::Document(input) = input else {
            return Err(CanopyError::invalid_query(format!("The {route} body must be a document")));
        };
        if let Some(unknown) = input.keys().find(|key| !allowed.contains(key)) {
            return Err(CanopyError::invalid_query(format!("Unknown {route} field {unknown}")));
        }
        Ok(input)
    }

    fn json(
        request: &Request,
        encode: impl FnOnce(Encoding) -> Result<String, CanopyError>,
    ) -> Result<Response, CanopyError> {
        let encoding = negotiate(request.header("accept").as_deref());
        let text = encode(encoding)?;
        Ok(Response::new(200).with_header("content-type", content_type(encoding)).with_body(text))
    }

    async fn count(&self, request: &Request, collection: &str) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let input = match self.body(request)? {
            None | Some(Value::Null) => Value::Document(Document::new()),
            Some(input) => input,
        };
        let input = Rest::fields(&input, "count", &["filter"])?;
        let mode = preferences_of(request).count.unwrap_or(CountMode::Exact);
        let result = self.reads.count(&caller, collection, input.get("filter"), mode).await?;
        Rest::json(request, |encoding| result.encode(encoding))
    }

    async fn distinct(&self, request: &Request, collection: &str) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let input = self.body(request)?.unwrap_or(Value::Undefined);
        let input = Rest::fields(&input, "distinct", &["field", "filter"])?;
        let result =
            self.reads.distinct(&caller, collection, input.get("field"), input.get("filter")).await?;
        Rest::json(request, |encoding| result.encode(encoding))
    }

    /// A find whose parameters are a body. The page carries its cluster time in the body only: no `ETag`, no
    /// `X-Canopy-Ct`, as the TypeScript handler answers it.
    async fn query(&self, request: &Request, collection: &str) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        let input = match self.body(request)? {
            None | Some(Value::Null) => Value::Document(Document::new()),
            Some(input) => input,
        };
        let limits = self.reads.limits();
        let params = find_params_from_body(
            &input,
            PageLimits { max_limit: limits.max_limit, max_skip: limits.max_skip },
            preferences_of(request).count,
        )?;
        let page = self.reads.find(&caller, find_request(collection, params)).await?;
        Rest::json(request, |encoding| Ok(page.with_ct(&page.encode(encoding)?)))
    }

    /// Explains how DLS decides an operation for the caller stated in the body, with the policies and context
    /// lookups of real requests. The report shows the policy structure and resolved claim values, so only
    /// `service` callers may ask.
    async fn explain(&self, request: &Request, collection: &str) -> Result<Response, CanopyError> {
        let caller = self.caller(request, Some(&[collection])).await?;
        if !caller.context.roles.contains(Role::SERVICE) {
            return Err(CanopyError::named(
                ErrorCode::Forbidden,
                "ForbiddenError",
                "Explanations are only available with a secret key",
            ));
        }
        let input = match self.body(request)? {
            None | Some(Value::Null) => Value::Document(Document::new()),
            Some(input) => input,
        };
        let input = Rest::fields(&input, "explain", &["op", "claims", "roles", "filter", "ctx", "count"])?;
        let op = match input.get("op") {
            None => Some(Operation::Read),
            Some(Value::String(name)) => Operation::parse(name),
            Some(_) => None,
        };
        let Some(op) = op else {
            let names = Operation::ALL.map(Operation::as_str).join(", ");
            return Err(CanopyError::invalid_query(format!("op must be one of {names}")));
        };
        let claims = match input.get("claims") {
            None | Some(Value::Null) => None,
            Some(Value::Document(claims)) => Some(claims.clone()),
            Some(_) => return Err(CanopyError::invalid_query("claims must be a document")),
        };
        let roles = match input.get("roles") {
            None => Vec::new(),
            Some(Value::Array(roles)) => roles
                .iter()
                .map(|role| role.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| CanopyError::invalid_query("roles must be a list of role names"))?,
            Some(_) => return Err(CanopyError::invalid_query("roles must be a list of role names")),
        };
        let document = |name: &str| match input.get(name) {
            None => Ok(None),
            Some(Value::Document(value)) => Ok(Some(value.clone())),
            Some(_) => Err(CanopyError::invalid_query(format!("{name} must be a document"))),
        };
        let filter = document("filter")?;
        let ctx = document("ctx")?;
        let count = match input.get("count") {
            None => false,
            Some(Value::Bool(count)) => *count,
            Some(_) => return Err(CanopyError::invalid_query("count must be a boolean")),
        };
        let engine = self.reads.policies().current();
        let given = ctx.is_some();
        let mut context = explain_context(claims, &roles, ctx, caller.context.now);
        let lookups = engine.context_names(Some(&[collection]), &context.roles);
        if !given && !lookups.is_empty() {
            context.ctx =
                Some(self.reads.contexts().resolve(engine.set().contexts(), &lookups, &context).await);
        }
        let explained = ExplainRequest { collection: collection.to_owned(), op, context, filter };
        let report = explain_access(&engine, &explained)?;
        let mut data = access_report_document(&report)?;
        if count && op != Operation::Insert {
            let effective = Value::Document(report.effective.to_filter());
            let counted = self.reads.count(&caller, collection, Some(&effective), CountMode::Exact).await?;
            #[allow(clippy::cast_precision_loss)]
            data.insert("count", Value::from_js_number(counted.count as f64));
        }
        let body = Value::Document([("data".to_owned(), Value::Document(data))].into_iter().collect());
        Rest::json(request, |encoding| match encoding {
            Encoding::Canonical => canonical_string(&body),
            _ => stringify(&body),
        })
    }

    async fn aggregate(&self, request: &Request, collection: &str) -> Result<Response, CanopyError> {
        let caller = self.caller(request, None).await?;
        let input = self.body(request)?.unwrap_or(Value::Undefined);
        let input = Rest::fields(&input, "aggregate", &["pipeline"])?;
        let result = self.reads.aggregate(&caller, collection, input.get("pipeline")).await?;
        Rest::json(request, |encoding| result.encode(encoding))
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
        let caller = self.caller(request, Some(&[collection])).await?;
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
        let page = self.reads.find(&caller, find_request(collection, params)).await?;
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

fn find_request(collection: &str, params: FindParams) -> FindRequest {
    FindRequest {
        collection: collection.to_owned(),
        filter: params.filter,
        sort: params.sort,
        fields: params.fields,
        limit: params.limit,
        skip: params.skip,
        after: params.after,
        count: params.count,
    }
}

/// The `Retry-After` seconds of a rate limited request, from the error's details.
fn retry_after(error: &CanopyError) -> Option<u64> {
    if error.code() != ErrorCode::RateLimited {
        return None;
    }
    match canopy_protocol::json::parse_json(error.details()?).ok()?.get("retryAfterSeconds") {
        Some(canopy_protocol::json::Json::Number(seconds)) if *seconds >= 0.0 => {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let seconds = *seconds as u64;
            Some(seconds)
        }
        _ => None,
    }
}

/// The path of a request target as a URL parser reads it (dot segments resolved, no query), as the TypeScript
/// server logs it; `None` for a target that is not a path.
pub fn request_path(target: &str) -> Option<String> {
    parse_target(target).map(|url| url.path().to_owned())
}

fn parse_target(target: &str) -> Option<url::Url> {
    if target.starts_with('/') { url::Url::parse(&format!("http://canopy.test{target}")).ok() } else { None }
}

/// Reads and decodes an EJSON request body of one of the `accepted` media types, with its media type, as the
/// TypeScript `readBody` does. An empty body reads as `None`. Fails with `CANOPY_PAYLOAD_TOO_LARGE` beyond
/// `max_bytes`, and with an invalid query error for other media types, text that is not UTF-8 and malformed JSON.
pub fn read_body(
    request: &Request,
    max_bytes: u64,
    accepted: &[&str],
) -> Result<Option<(Value, String)>, CanopyError> {
    let too_large = || {
        CanopyError::new(
            ErrorCode::PayloadTooLarge,
            format!("The request body may not exceed {max_bytes} bytes"),
        )
    };
    #[allow(clippy::cast_precision_loss)]
    let max = max_bytes as f64;
    if request
        .header("content-length")
        .is_some_and(|declared| declared.trim().parse::<f64>().is_ok_and(|length| length > max))
    {
        return Err(too_large());
    }
    let bytes = match &request.body {
        Body::TooLarge => return Err(too_large()),
        Body::Unreadable => return Err(CanopyError::invalid_query("The request body could not be read")),
        Body::Bytes(bytes) if bytes.is_empty() => return Ok(None),
        Body::Bytes(bytes) => bytes,
    };
    let media_type = request.header("content-type").unwrap_or_default();
    let media_type = media_type.split(';').next().unwrap_or_default().trim().to_lowercase();
    if !accepted.contains(&media_type.as_str()) {
        return Err(CanopyError::invalid_query(format!(
            "The request body must be one of: {}",
            accepted.join(", ")
        )));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CanopyError::invalid_query("The request body is not valid UTF-8"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Ok(Some((js_property_order(&parse(text, DecodeOptions::default())?), media_type)))
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

pub(crate) fn content_type(encoding: Encoding) -> &'static str {
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

/// Picks the route of a path and method, and the methods the path allows, in the order the API lists them. A
/// route that is not in `served` resolves to [`Route::Unserved`].
fn resolve(segments: &[String], method: &str, served: Served) -> (Option<Route>, Vec<&'static str>) {
    let first = segments.first().map(String::as_str);
    let second = segments.get(1).map(String::as_str);
    let (table, own): (&[&'static str], Option<Route>) = match segments.len() {
        0 => (&["GET"], None),
        1 if first == Some("_batch") => {
            (&["POST"], (served.writes && method == "POST").then_some(Route::Batch))
        }
        1 if first == Some("openapi.json") => (&["GET"], None),
        1 => (
            &["GET", "POST", "PATCH", "DELETE"],
            match method {
                "GET" if served.find => Some(Route::Find),
                "POST" if served.writes => Some(Route::Insert),
                "PATCH" if served.writes => Some(Route::UpdateMany),
                "DELETE" if served.writes => Some(Route::DeleteMany),
                _ => None,
            },
        ),
        2 if second.is_some_and(|name| ACTIONS.contains(&name)) => {
            let action = match second {
                Some("_count") if served.count => Some(Route::Count),
                Some("_distinct") if served.distinct => Some(Route::Distinct),
                Some("_aggregate") if served.aggregate => Some(Route::Aggregate),
                Some("_query") if served.query => Some(Route::Query),
                Some("_explain") if served.explain => Some(Route::Explain),
                _ => None,
            };
            (&["POST"], action.filter(|_| method == "POST"))
        }
        2 => (
            &["GET", "PATCH", "PUT", "DELETE"],
            match method {
                "GET" if served.document => Some(Route::Document),
                "PATCH" if served.writes => Some(Route::Update),
                "PUT" if served.writes => Some(Route::Replace),
                "DELETE" if served.writes => Some(Route::Delete),
                _ => None,
            },
        ),
        _ => (&[], None),
    };
    let route = table.contains(&method).then(|| own.unwrap_or(Route::Unserved));
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
        let find = Served::default();
        assert_eq!(
            resolve(&segments(&["todos"]), "GET", find),
            (Some(Route::Find), vec!["GET", "POST", "PATCH", "DELETE"])
        );
        assert_eq!(resolve(&segments(&["todos"]), "POST", find).0, Some(Route::Unserved));
        assert_eq!(resolve(&segments(&["todos"]), "PUT", find).0, None);
        assert_eq!(resolve(&segments(&["todos"]), "get", find).0, None);
        let none = Served { find: false, ..find };
        assert_eq!(resolve(&segments(&["todos"]), "GET", none).0, Some(Route::Unserved));
    }

    #[test]
    fn the_read_actions_are_served_only_when_enabled() {
        let all = Served {
            find: true,
            count: true,
            distinct: true,
            aggregate: true,
            query: true,
            explain: true,
            document: true,
            writes: false,
        };
        for (action, route) in [
            ("_count", Route::Count),
            ("_distinct", Route::Distinct),
            ("_aggregate", Route::Aggregate),
            ("_query", Route::Query),
            ("_explain", Route::Explain),
        ] {
            assert_eq!(resolve(&segments(&["todos", action]), "POST", all), (Some(route), vec!["POST"]));
            assert_eq!(resolve(&segments(&["todos", action]), "GET", all), (None, vec!["POST"]));
            assert_eq!(
                resolve(&segments(&["todos", action]), "POST", Served::default()).0,
                Some(Route::Unserved)
            );
        }
        let reads_only = Served { explain: false, ..all };
        assert_eq!(resolve(&segments(&["todos", "_explain"]), "POST", reads_only).0, Some(Route::Unserved));
    }

    #[test]
    fn other_paths_are_not_served_here_but_keep_their_methods() {
        let find = Served::default();
        assert_eq!(resolve(&[], "GET", find), (Some(Route::Unserved), vec!["GET"]));
        assert_eq!(resolve(&segments(&["openapi.json"]), "GET", find).0, Some(Route::Unserved));
        assert_eq!(resolve(&segments(&["_batch"]), "POST", find).0, Some(Route::Unserved));
        assert_eq!(resolve(&segments(&["_batch"]), "GET", find), (None, vec!["POST"]));
        assert_eq!(resolve(&segments(&["todos", "_count"]), "POST", find).0, Some(Route::Unserved));
        assert_eq!(
            resolve(&segments(&["todos", "7"]), "GET", find),
            (Some(Route::Unserved), vec!["GET", "PATCH", "PUT", "DELETE"])
        );
        assert_eq!(resolve(&segments(&["a", "b", "c"]), "GET", find), (None, vec![]));
    }
}
