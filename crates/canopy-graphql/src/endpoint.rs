//! The GraphQL endpoint (`/graphql/v1`) over HTTP, answering as the TypeScript handler does behind GraphQL
//! Yoga: `GET` and `POST` parameters, batches, persisted operations, the introspection, idempotency and
//! operation limit gates, the status of each error and the negotiated media type.

use crate::build::{CollectionConfig, GeneratedSchema, SchemaInput, build_schema};
use crate::errors::GraphqlError;
use crate::execute::{
    ChangeTracker, ExecutionResult, LiveChange, Services, SubscriptionEvent, SubscriptionKind,
    SubscriptionSource, execute, execute_event, subscription_source,
};
use crate::limits::{OperationLimits, check_operation};
use crate::live::{LiveCredentials, LiveQueries, LiveStream};
use apollo_compiler::ast::OperationType;
use apollo_compiler::executable::{Operation, Selection, SelectionSet};
use apollo_compiler::validation::Valid;
use apollo_compiler::{ExecutableDocument, Node, Schema, ast};
use canopy_data::schema::{CollectionSchema, SchemaCache, SchemaCacheOptions};
use canopy_data::{Caller, ReadPath};
use canopy_http::{Body, Cors, Request, Response, Rest, credentials_from_headers, uuid_v7};
use canopy_policy::Role;
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_protocol::sha256::sha256_hex;
use canopy_protocol::{CanopyError, ErrorCode};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Who may run introspection queries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrospectionMode {
    /// Everyone.
    Always,
    /// Callers with the `authenticated` or `service` role.
    Authenticated,
    /// Nobody.
    Never,
}

/// Persisted operations: an allowlist of documents by the hex SHA-256 of their text.
#[derive(Clone, Debug, Default)]
pub struct PersistedOperations {
    /// Documents by hash.
    pub operations: HashMap<String, String>,
    /// Refuses every document that is not in `operations`.
    pub only: bool,
}

/// Settings of the endpoint.
#[derive(Clone, Debug)]
pub struct GraphqlOptions {
    /// The endpoint path, `/graphql/v1` by default.
    pub path: String,
    /// The operation limits.
    pub limits: OperationLimits,
    /// The most operations in one batched request; `0` refuses batches.
    pub max_batch: usize,
    /// The largest request body in bytes.
    pub max_body_bytes: u64,
    /// Who may run introspection queries.
    pub introspection: IntrospectionMode,
    /// Persisted operations.
    pub persisted: Option<PersistedOperations>,
    /// Type names and relations per collection.
    pub collections: HashMap<String, CollectionConfig>,
    /// The origins browsers may call the endpoint from.
    pub cors: Option<Cors>,
    /// How long browsers may cache a preflight, in seconds.
    pub cors_max_age_seconds: u64,
}

impl Default for GraphqlOptions {
    fn default() -> GraphqlOptions {
        GraphqlOptions {
            path: "/graphql/v1".to_owned(),
            limits: OperationLimits::default(),
            max_batch: 10,
            max_body_bytes: 1024 * 1024,
            introspection: IntrospectionMode::Always,
            persisted: None,
            collections: HashMap::new(),
            cors: None,
            cors_max_age_seconds: 600,
        }
    }
}

const CORS_ALLOWED_HEADERS: &str =
    "apikey, authorization, content-type, accept, idempotency-key, x-request-id";

/// The CORS headers of a response to a request from an origin, as GraphQL Yoga writes them for the handler's
/// settings: every origin is echoed for `*`; a list of one origin always names it; a longer list echoes an
/// origin it holds and names none otherwise.
fn cors_headers(request: &Request, cors: &Cors, max_age: u64) -> Vec<(String, String)> {
    let Some(origin) = request.header("origin") else { return Vec::new() };
    let mut headers = Vec::new();
    let credentials = match cors {
        Cors::Any => {
            headers.push(("access-control-allow-origin".to_owned(), origin));
            headers.push(("vary".to_owned(), "Origin".to_owned()));
            false
        }
        Cors::Origins(origins) if origins.len() == 1 => {
            headers.push(("access-control-allow-origin".to_owned(), origins[0].clone()));
            true
        }
        Cors::Origins(origins) if origins.contains(&origin) => {
            headers.push(("access-control-allow-origin".to_owned(), origin));
            headers.push(("vary".to_owned(), "Origin".to_owned()));
            true
        }
        Cors::Origins(_) => return Vec::new(),
    };
    if let Some(method) = request.header("access-control-request-method") {
        headers.push(("access-control-allow-methods".to_owned(), method));
    }
    headers.push(("access-control-allow-headers".to_owned(), CORS_ALLOWED_HEADERS.to_owned()));
    if credentials {
        headers.push(("access-control-allow-credentials".to_owned(), "true".to_owned()));
    }
    if max_age > 0 {
        headers.push(("access-control-max-age".to_owned(), max_age.to_string()));
    }
    headers
}

/// The `429` the handler answers before GraphQL runs, with the CORS headers a browser needs to read it.
fn rate_limited(error: &CanopyError, request: &Request, cors: Option<&Cors>) -> Response {
    let seconds = error
        .details()
        .and_then(|details| parse_json(details).ok())
        .and_then(|details| match details.get("retryAfterSeconds") {
            Some(Json::Number(seconds)) => Some(*seconds),
            _ => None,
        })
        .unwrap_or(1.0);
    let mut headers = vec![
        ("content-type".to_owned(), JSON.to_owned()),
        ("retry-after".to_owned(), canopy_protocol::json::js_number_string(seconds)),
    ];
    if let (Some(cors), Some(origin)) = (cors, request.header("origin")) {
        match cors {
            Cors::Any => headers.push(("access-control-allow-origin".to_owned(), "*".to_owned())),
            Cors::Origins(origins) if origins.contains(&origin) => {
                headers.push(("access-control-allow-origin".to_owned(), origin));
                headers.push(("access-control-allow-credentials".to_owned(), "true".to_owned()));
                headers.push(("vary".to_owned(), "Origin".to_owned()));
            }
            Cors::Origins(_) => {}
        }
        headers.push(("access-control-expose-headers".to_owned(), "retry-after".to_owned()));
    }
    let mut error = GraphqlError::from_canopy(error);
    error.extensions.retain(|(key, _)| key == "code" || key == "details");
    error
        .extensions
        .push(("http".to_owned(), Json::Object(vec![("status".to_owned(), Json::Number(429.0))])));
    let mut body = String::from("{\"errors\":[");
    error.write(&mut body);
    body.push_str("]}");
    Response { status: 429, headers, body: body.into_bytes() }
}

/// One caller's schema, generated and compiled.
pub struct CompiledSchema {
    /// The generated types and plans.
    pub generated: GeneratedSchema,
    /// The schema as apollo-compiler validated it.
    pub schema: Valid<Schema>,
}

struct CollectionList {
    at: Instant,
    names: Vec<String>,
}

/// The GraphQL endpoint.
pub struct Graphql {
    rest: Arc<Rest>,
    options: GraphqlOptions,
    schemas: SchemaCache,
    compiled: Mutex<HashMap<String, Arc<CompiledSchema>>>,
    lists: Mutex<HashMap<String, CollectionList>>,
    live: Option<Arc<LiveQueries>>,
}

/// An operation ready to run: the validated document, the chosen operation and its variables.
struct Prepared {
    document: Valid<ExecutableDocument>,
    operation: Node<Operation>,
    variables: Vec<(String, Json)>,
    idempotency_key: Option<String>,
}

/// An operation started over a streaming transport such as graphql-ws.
pub enum Started {
    /// A query, a mutation, or a subscription that failed before its first event: its one result, as JSON.
    Result(String),
    /// A subscription: its events.
    Stream(Box<SubscriptionRun>),
}

/// The events of one subscription: each change of its live query, run through the operation's selection
/// under the caller's policies. Dropping it ends the live query.
pub struct SubscriptionRun {
    rest: Arc<Rest>,
    compiled: Arc<CompiledSchema>,
    prepared: Prepared,
    caller: Caller,
    kind: SubscriptionKind,
    stream: LiveStream,
    tracker: ChangeTracker,
    changes: VecDeque<LiveChange>,
}

impl SubscriptionRun {
    /// The next result as JSON text. Ends with the live query's error, then with `None`.
    pub async fn next(&mut self) -> Option<Result<String, CanopyError>> {
        let event = match self.kind {
            SubscriptionKind::Live => match self.stream.next().await? {
                Ok(docs) => SubscriptionEvent::Docs(docs),
                Err(error) => return Some(Err(error)),
            },
            SubscriptionKind::Changes => loop {
                if let Some(change) = self.changes.pop_front() {
                    break SubscriptionEvent::Change(change);
                }
                match self.stream.next().await? {
                    Ok(docs) => self.changes.extend(self.tracker.changes(&docs)),
                    Err(error) => return Some(Err(error)),
                }
            },
        };
        let services = Services {
            reads: self.rest.reads(),
            writes: self.rest.write_path().map(Arc::as_ref),
            caller: &self.caller,
            idempotency_key: None,
        };
        let result = execute_event(
            &self.compiled.generated,
            &self.compiled.schema,
            &self.prepared.document,
            &self.prepared.operation,
            &self.prepared.variables,
            &services,
            &event,
        )
        .await;
        let mut text = String::new();
        Outcome::from(result).write(&mut text);
        Some(Ok(text))
    }
}

const JSON: &str = "application/json";
const GRAPHQL_RESPONSE: &str = "application/graphql-response+json";
const SERVICE_LIST_TTL: Duration = Duration::from_secs(10);
const CACHE_ENTRIES: usize = 64;

fn bad_request(message: impl Into<String>, status: u16) -> GraphqlError {
    GraphqlError::coded(message, "BAD_REQUEST").with_status(status)
}

fn spec(mut error: GraphqlError) -> GraphqlError {
    error.spec = true;
    error
}

fn allow(mut error: GraphqlError, methods: &str) -> GraphqlError {
    error.headers.push(("allow".to_owned(), methods.to_owned()));
    error
}

fn json_type(value: &Json) -> &'static str {
    match value {
        Json::Null => "null",
        Json::Bool(_) => "boolean",
        Json::Number(_) => "number",
        Json::String(_) => "string",
        Json::Array(_) => "array",
        Json::Object(_) => "object",
    }
}

fn is_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 128
        && !value.chars().any(|c| c < '\u{20}' || c == '\u{7f}')
}

fn content_type_is(request: &Request, expected: &str) -> bool {
    let Some(content_type) = request.header("content-type") else { return false };
    let first = content_type.split(',').next().unwrap_or("");
    first == expected || first.starts_with(&format!("{expected};"))
}

fn search_params(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(name), form_decode(value))
        })
        .collect()
}

fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                match hex {
                    Some(byte) => {
                        out.push(byte);
                        index += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn params_of(pairs: &[(String, String)]) -> Result<Json, GraphqlError> {
    let get = |name: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty())
    };
    let mut out = Vec::new();
    if let Some(name) = get("operationName") {
        out.push(("operationName".to_owned(), Json::String(name.to_owned())));
    }
    if let Some(query) = get("query") {
        out.push(("query".to_owned(), Json::String(query.to_owned())));
    }
    for name in ["variables", "extensions"] {
        if let Some(text) = get(name) {
            let value =
                parse_json(text).map_err(|_| GraphqlError::coded("Internal error", "CANOPY_INTERNAL"))?;
            out.push((name.to_owned(), value));
        }
    }
    Ok(Json::Object(out))
}

fn walk_introspects(set: &SelectionSet) -> bool {
    set.selections.iter().any(|selection| match selection {
        Selection::Field(field) => {
            matches!(field.name.as_str(), "__schema" | "__type") || walk_introspects(&field.selection_set)
        }
        Selection::InlineFragment(fragment) => walk_introspects(&fragment.selection_set),
        Selection::FragmentSpread(_) => false,
    })
}

fn introspects(document: &ExecutableDocument) -> bool {
    document.operations.iter().any(|operation| walk_introspects(&operation.selection_set))
        || document.fragments.values().any(|fragment| walk_introspects(&fragment.selection_set))
}

struct AdminExecution {
    allow_mutations: bool,
    mutation: bool,
}

/// The outcome of one operation, before it is written.
#[derive(Clone, Debug, PartialEq)]
struct Outcome {
    data: Option<Json>,
    errors: Vec<GraphqlError>,
}

impl From<ExecutionResult> for Outcome {
    fn from(result: ExecutionResult) -> Outcome {
        Outcome { data: result.data, errors: result.errors }
    }
}

impl Outcome {
    fn failed(error: GraphqlError) -> Outcome {
        Outcome { data: None, errors: vec![error] }
    }

    fn write(&self, out: &mut String) {
        out.push('{');
        if !self.errors.is_empty() {
            out.push_str("\"errors\":[");
            for (position, error) in self.errors.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                error.write(out);
            }
            out.push(']');
        }
        if let Some(data) = &self.data {
            if !self.errors.is_empty() {
                out.push(',');
            }
            out.push_str("\"data\":");
            write_json(out, data);
        }
        out.push('}');
    }
}

const EVENT_STREAM: &str = "text/event-stream";
const MULTIPART: &str = "multipart/mixed";

/// The result processors GraphQL Yoga picks from for a result that is not a stream: server-sent events,
/// multipart, then the regular JSON media types.
const DEFAULT_PROCESSORS: &[&[&str]] = &[&[EVENT_STREAM], &[MULTIPART], &[GRAPHQL_RESPONSE, JSON]];
/// The processors of a subscription whose result is not a stream: it failed before its first event.
const SUBSCRIPTION_PROCESSORS: &[&[&str]] = &[&[EVENT_STREAM], &[GRAPHQL_RESPONSE, JSON]];
/// The only processor of a subscription's event stream.
const STREAM_PROCESSORS: &[&[&str]] = &[&[EVENT_STREAM]];

/// The server-sent events comment that opens an event stream and keeps it alive.
pub const EVENT_STREAM_PING: &str = ":\n\n";
/// How often an open event stream sends [`EVENT_STREAM_PING`].
pub const EVENT_STREAM_PING_INTERVAL: Duration = Duration::from_secs(12);

/// Picks the media type of a regular result from `Accept`: the last media type of the header that one of
/// `application/graphql-response+json` and `application/json` matches, or `None` for a `406`.
#[cfg(test)]
fn negotiate(request: &Request) -> Result<&'static str, Vec<&'static str>> {
    match negotiate_in(request, DEFAULT_PROCESSORS) {
        Ok(media) if media == GRAPHQL_RESPONSE || media == JSON => Ok(media),
        Ok(_) => Ok(JSON),
        Err(acceptable) => Err(acceptable),
    }
}

/// Picks the result processor from `Accept` as GraphQL Yoga does: for each processor in order, each media type
/// of the header and each media type of the processor, the last match wins. `Err` lists every media type tried,
/// for the `Accept` header of a `406`.
fn negotiate_in(
    request: &Request,
    processors: &[&[&'static str]],
) -> Result<&'static str, Vec<&'static str>> {
    let header = request.header("accept").unwrap_or_else(|| "*/*".to_owned());
    let compact: String = header.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    let mut types: Vec<String> = Vec::new();
    for accept in compact.split(',') {
        let mut parts = accept.split(';');
        let media = parts.next().unwrap_or("");
        let charset = parts.clone().find(|param| param.contains("charset=")).unwrap_or("charset=utf-8");
        if charset != "charset=utf-8" {
            continue;
        }
        types.push(media.to_owned());
    }
    types.reverse();
    let matches = |processor: &str, asked: &str| {
        let (processor_type, processor_sub) = processor.split_once('/').unwrap_or((processor, ""));
        let (asked_type, asked_sub) = asked.split_once('/').unwrap_or((asked, ""));
        (asked_type == "*" || asked_type == processor_type)
            && (asked_sub == "*" || asked_sub == processor_sub)
    };
    let mut acceptable = Vec::new();
    let mut chosen = None;
    for processor in processors {
        for asked in &types {
            for media in *processor {
                acceptable.push(*media);
                if matches(media, asked) {
                    chosen = Some(*media);
                }
            }
        }
    }
    chosen.ok_or(acceptable)
}

/// The status and headers of a result: the largest status its errors carry and their headers. With
/// `prefer_ok`, the status of spec errors is ignored, as for `application/json` and event streams.
fn status_of(outcome: &Outcome, prefer_ok: bool, headers: &mut Vec<(String, String)>) -> u16 {
    let mut status: Option<u16> = None;
    for error in &outcome.errors {
        for (name, value) in &error.headers {
            match headers.iter_mut().find(|(key, _)| key == name) {
                Some(slot) => slot.1 = value.clone(),
                None => headers.push((name.clone(), value.clone())),
            }
        }
        if prefer_ok && error.spec {
            continue;
        }
        if let Some(code) = error.status
            && status.is_none_or(|current| code > current)
        {
            status = Some(code);
        }
    }
    status.unwrap_or(200)
}

/// An error that stops a graphql-ws operation, as the TypeScript handler masks it: no HTTP response strips
/// the HTTP status of a Canopy error, so it stays in `extensions.http`, and a parse or validation error takes
/// `CANOPY_INVALID_QUERY`.
fn masked(mut error: GraphqlError) -> GraphqlError {
    let code = error.extension("code").and_then(|code| match code {
        Json::String(code) => Some(code.clone()),
        _ => None,
    });
    match code.as_deref() {
        Some("GRAPHQL_PARSE_FAILED" | "GRAPHQL_VALIDATION_FAILED") => {
            for (key, value) in &mut error.extensions {
                if key == "code" {
                    *value = Json::String(ErrorCode::InvalidQuery.as_str().to_owned());
                }
            }
        }
        Some(code) if code.starts_with("CANOPY_") && error.extension("http").is_none() => {
            if let Some(status) = error.status {
                let status = Json::Object(vec![("status".to_owned(), Json::Number(f64::from(status)))]);
                error.extensions.push(("http".to_owned(), status));
            }
        }
        _ => {}
    }
    error.status = None;
    error.spec = false;
    error
}

/// How the endpoint answers a request.
pub enum Answer {
    /// A complete response.
    Response(Response),
    /// A `text/event-stream` response whose body is written as results arrive.
    Events(EventStream),
}

enum EventSource {
    Single(Option<String>),
    Live(Box<SubscriptionRun>),
}

/// A result streamed as server-sent events, as GraphQL Yoga writes them: an opening comment, one
/// `event: next` per result and `event: complete` at the end. The transport sends [`EVENT_STREAM_PING`] every
/// [`EVENT_STREAM_PING_INTERVAL`] while the stream is open.
pub struct EventStream {
    /// The status.
    pub status: u16,
    /// The headers.
    pub headers: Vec<(String, String)>,
    opened: bool,
    done: bool,
    source: EventSource,
}

impl EventStream {
    fn new(status: u16, mut headers: Vec<(String, String)>, source: EventSource) -> EventStream {
        let mut all = vec![
            ("content-type".to_owned(), EVENT_STREAM.to_owned()),
            ("connection".to_owned(), "keep-alive".to_owned()),
            ("cache-control".to_owned(), "no-cache".to_owned()),
            ("content-encoding".to_owned(), "none".to_owned()),
        ];
        all.append(&mut headers);
        EventStream { status, headers: all, opened: false, done: false, source }
    }

    /// The next chunk of the body, or `None` when it is over. A live query that fails ends the body without
    /// `event: complete`.
    pub async fn next_chunk(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        if !self.opened {
            self.opened = true;
            return Some(EVENT_STREAM_PING.to_owned());
        }
        let next = match &mut self.source {
            EventSource::Single(result) => result.take().map(Ok),
            EventSource::Live(run) => run.next().await,
        };
        match next {
            Some(Ok(text)) => Some(format!("event: next\ndata: {text}\n\n")),
            Some(Err(_)) => {
                self.done = true;
                None
            }
            None => {
                self.done = true;
                Some("event: complete\ndata:\n\n".to_owned())
            }
        }
    }

    /// The whole body of a stream that ends by itself, such as a single result.
    pub async fn collect(mut self) -> Vec<u8> {
        let mut body = String::new();
        while let Some(chunk) = self.next_chunk().await {
            body.push_str(&chunk);
        }
        body.into_bytes()
    }
}

impl Graphql {
    /// Creates the endpoint over the REST routes' authenticator and read and write paths.
    pub fn new(rest: Arc<Rest>, options: GraphqlOptions) -> Graphql {
        let schemas = SchemaCache::new(rest.reads().database().clone(), SchemaCacheOptions::default());
        Graphql {
            rest,
            options,
            schemas,
            compiled: Mutex::new(HashMap::new()),
            lists: Mutex::new(HashMap::new()),
            live: None,
        }
    }

    /// Serves subscriptions (`live<Plural>` and `<singular>Changes`) by following live queries through `live`.
    pub fn with_live(mut self, live: Arc<LiveQueries>) -> Graphql {
        self.live = Some(live);
        self
    }

    /// The live queries, when subscriptions are served.
    pub fn live(&self) -> Option<&Arc<LiveQueries>> {
        self.live.as_ref()
    }

    /// The endpoint path.
    pub fn path(&self) -> &str {
        &self.options.path
    }

    /// Whether the endpoint answers this request target: its path, with or without a trailing slash.
    pub fn owns(&self, target: &str) -> bool {
        let path = target.split(['?', '#']).next().unwrap_or("");
        path == self.options.path
            || path.strip_suffix('/').is_some_and(|stripped| stripped == self.options.path)
    }

    fn reads(&self) -> &ReadPath {
        self.rest.reads()
    }

    async fn collections_of(&self, caller: &Caller) -> Result<Vec<String>, CanopyError> {
        let engine = self.reads().policies().current();
        let mut roles: Vec<&str> = caller.context.roles.iter().collect();
        roles.sort_unstable();
        let key = format!("{}\u{0}{}", engine.version(), roles.join(","));
        let service = caller.context.roles.contains(Role::SERVICE);
        if let Ok(lists) = self.lists.lock()
            && let Some(list) = lists.get(&key)
            && (!service || list.at.elapsed() < SERVICE_LIST_TTL)
        {
            return Ok(list.names.clone());
        }
        let names: Vec<String> =
            self.reads().collections(caller).await?.into_iter().map(|info| info.name).collect();
        if let Ok(mut lists) = self.lists.lock() {
            if lists.len() >= CACHE_ENTRIES {
                lists.clear();
            }
            lists.insert(key, CollectionList { at: Instant::now(), names: names.clone() });
        }
        Ok(names)
    }

    async fn schema_of(&self, caller: &Caller) -> Result<Arc<CompiledSchema>, CanopyError> {
        let engine = self.reads().policies().current();
        let names = self.collections_of(caller).await?;
        let loaded: Vec<CollectionSchema> = self.schemas.all(&names).await?;
        let mut roles: Vec<&str> = caller.context.roles.iter().collect();
        roles.sort_unstable();
        let key = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            engine.version(),
            self.schemas.version(),
            roles.join(","),
            names.join(",")
        );
        if let Ok(compiled) = self.compiled.lock()
            && let Some(schema) = compiled.get(&key)
        {
            return Ok(schema.clone());
        }
        let schemas: HashMap<String, CollectionSchema> =
            loaded.into_iter().map(|schema| (schema.name.clone(), schema)).collect();
        let limits = self.reads().limits();
        let generated = build_schema(&SchemaInput {
            engine: &engine,
            ctx: &caller.context,
            collections: &names,
            schemas: &schemas,
            config: &self.options.collections,
            subscriptions: self.live.is_some(),
            default_limit: limits.default_limit,
            max_limit: limits.max_limit,
        });
        let schema = Schema::parse_and_validate(generated.sdl(), "schema.graphql").map_err(|_| {
            CanopyError::new(ErrorCode::Internal, "The generated GraphQL schema is not valid")
        })?;
        let schema = crate::introspection::prepare_schema(schema, &generated);
        let compiled = Arc::new(CompiledSchema { generated, schema });
        if let Ok(mut cache) = self.compiled.lock() {
            if cache.len() >= CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(key, compiled.clone());
        }
        Ok(compiled)
    }

    fn persisted(&self, params: &Json) -> Result<Option<String>, GraphqlError> {
        let query = match params.get("query") {
            Some(Json::String(query)) => Some(query.clone()),
            _ => None,
        };
        let hash = params
            .get("extensions")
            .and_then(|extensions| extensions.get("persistedQuery"))
            .and_then(|persisted| persisted.get("sha256Hash"));
        if let Some(Json::String(hash)) = hash {
            let found = self.options.persisted.as_ref().and_then(|persisted| persisted.operations.get(hash));
            return match found {
                Some(query) => Ok(Some(query.clone())),
                None => {
                    Err(GraphqlError::coded("PersistedQueryNotFound", "CANOPY_NOT_FOUND").with_status(404))
                }
            };
        }
        if let Some(persisted) = &self.options.persisted
            && persisted.only
            && !persisted.operations.contains_key(&sha256_hex(query.as_deref().unwrap_or("").as_bytes()))
        {
            return Err(GraphqlError::coded("Only persisted operations are allowed", "CANOPY_FORBIDDEN")
                .with_status(403));
        }
        Ok(query)
    }

    fn check_params(params: &Json) -> Result<(), GraphqlError> {
        let Json::Object(entries) = params else {
            return Err(allow(
                bad_request(format!("Expected params to be an object but given {}.", json_type(params)), 400),
                "GET, POST",
            ));
        };
        for (key, value) in entries {
            if matches!(value, Json::Null) {
                continue;
            }
            if !matches!(key.as_str(), "query" | "variables" | "operationName" | "extensions") {
                return Err(bad_request(format!("Unexpected parameter \"{key}\" in the request body."), 400));
            }
        }
        match params.get("query") {
            None | Some(Json::Null) => {
                return Err(allow(spec(bad_request("Must provide query string.", 400)), "GET, POST"));
            }
            Some(Json::String(_)) => {}
            Some(other) => {
                return Err(allow(
                    bad_request(
                        format!("Expected \"query\" param to be a string, but given {}.", json_type(other)),
                        400,
                    ),
                    "GET, POST",
                ));
            }
        }
        for name in ["variables", "extensions"] {
            match params.get(name) {
                None | Some(Json::Null | Json::Object(_)) => {}
                Some(other) => {
                    return Err(allow(
                        bad_request(
                            format!(
                                "Expected \"{name}\" param to be empty or an object, but given {}.",
                                json_type(other)
                            ),
                            400,
                        ),
                        "GET, POST",
                    ));
                }
            }
        }
        Ok(())
    }

    async fn operation(
        &self,
        request: &Request,
        caller: &Caller,
        compiled: &CompiledSchema,
        params: &Json,
    ) -> Outcome {
        let prepared = match self.prepare(request, caller, compiled, params, None) {
            Ok(prepared) => prepared,
            Err(outcome) => return outcome,
        };
        self.execute_prepared(caller, compiled, &prepared).await
    }

    async fn execute_prepared(
        &self,
        caller: &Caller,
        compiled: &CompiledSchema,
        prepared: &Prepared,
    ) -> Outcome {
        let services = Services {
            reads: self.reads(),
            writes: self.rest.write_path().map(Arc::as_ref),
            caller,
            idempotency_key: prepared.idempotency_key.clone(),
        };
        execute(
            &compiled.generated,
            &compiled.schema,
            &prepared.document,
            &prepared.operation,
            &prepared.variables,
            &services,
        )
        .await
        .into()
    }

    /// Runs the explorer with a caller already authorized by the admin API. Returns the GraphQL result
    /// and whether the selected operation was a mutation, for audit.
    pub async fn run_admin(
        &self,
        caller: &Caller,
        params: &Json,
        allow_mutations: bool,
    ) -> Result<(Json, bool), CanopyError> {
        let mut admin = AdminExecution { allow_mutations, mutation: false };
        let outcome = match self.schema_of(caller).await {
            Ok(compiled) => match self.prepare(
                &Request::new("POST", &self.options.path),
                caller,
                &compiled,
                params,
                Some(&mut admin),
            ) {
                Ok(prepared) => {
                    let mut outcome = self.execute_prepared(caller, &compiled, &prepared).await;
                    outcome.data = Some(outcome.data.unwrap_or(Json::Null));
                    outcome
                }
                Err(outcome) => outcome,
            },
            Err(error) => Outcome::failed(GraphqlError::from_canopy(&error)),
        };
        let mut entries = Vec::new();
        if let Some(data) = outcome.data {
            entries.push(("data".to_owned(), data));
        }
        if !outcome.errors.is_empty() {
            let errors = outcome
                .errors
                .into_iter()
                .map(|error| {
                    let mut text = String::new();
                    masked(error).write(&mut text);
                    parse_json(&text)
                })
                .collect::<Result<Vec<_>, _>>()?;
            entries.push(("errors".to_owned(), Json::Array(errors)));
        }
        Ok((Json::Object(entries), admin.mutation))
    }

    /// Starts one operation for a streaming transport, as the TypeScript `prepare` does for graphql-ws: the
    /// request's credentials and rate limits, the persisted operations, validation and the gates. A query or
    /// mutation runs at once. Errors that stop the operation before it starts are the `Err` value, a JSON
    /// array of GraphQL errors.
    pub async fn start(&self, request: &Request, params: &Json) -> Result<Started, String> {
        let errors = |errors: &[GraphqlError]| {
            let mut text = String::from("[");
            for (position, error) in errors.iter().enumerate() {
                if position > 0 {
                    text.push(',');
                }
                masked(error.clone()).write(&mut text);
            }
            text.push(']');
            text
        };
        let caller = self
            .rest
            .caller_of(request)
            .await
            .map_err(|error| errors(&[GraphqlError::from_canopy(&error)]))?;
        let compiled =
            self.schema_of(&caller).await.map_err(|error| errors(&[GraphqlError::from_canopy(&error)]))?;
        let prepared = self
            .prepare(request, &caller, &compiled, params, None)
            .map_err(|outcome| errors(&outcome.errors))?;
        let services = Services {
            reads: self.reads(),
            writes: self.rest.write_path().map(Arc::as_ref),
            caller: &caller,
            idempotency_key: prepared.idempotency_key.clone(),
        };
        let single = |result: ExecutionResult| {
            let mut text = String::new();
            Outcome::from(result).write(&mut text);
            Ok(Started::Result(text))
        };
        if prepared.operation.operation_type != OperationType::Subscription {
            let result = execute(
                &compiled.generated,
                &compiled.schema,
                &prepared.document,
                &prepared.operation,
                &prepared.variables,
                &services,
            )
            .await;
            return single(result);
        }
        let source = match subscription_source(
            &compiled.generated,
            &compiled.schema,
            &prepared.document,
            &prepared.operation,
            &prepared.variables,
            &services,
        ) {
            Ok(source) => source,
            Err(result) => return single(result),
        };
        let run = self
            .follow(request, caller, compiled, prepared, source)
            .map_err(|error| errors(&[GraphqlError::from_canopy(&error)]))?;
        Ok(Started::Stream(Box::new(run)))
    }

    fn prepare(
        &self,
        request: &Request,
        caller: &Caller,
        compiled: &CompiledSchema,
        params: &Json,
        mut admin: Option<&mut AdminExecution>,
    ) -> Result<Prepared, Outcome> {
        let query = match self.persisted(params) {
            Ok(query) => query,
            Err(error) => return Err(Outcome::failed(error)),
        };
        let mut params = params.clone();
        if let (Some(query), Json::Object(entries)) = (&query, &mut params) {
            match entries.iter_mut().find(|(key, _)| key == "query") {
                Some(slot) => slot.1 = Json::String(query.clone()),
                None => entries.push(("query".to_owned(), Json::String(query.clone()))),
            }
        }
        if let Err(error) = Graphql::check_params(&params) {
            return Err(Outcome::failed(error));
        }
        let text = match params.get("query") {
            Some(Json::String(text)) => text.clone(),
            _ => String::new(),
        };
        let operation_name = match params.get("operationName") {
            Some(Json::String(name)) => Some(name.clone()),
            _ => None,
        };
        let variables: Vec<(String, Json)> = match params.get("variables") {
            Some(Json::Object(entries)) => entries.clone(),
            _ => Vec::new(),
        };
        let parsed = match ast::Document::parse(&text, "query.graphql") {
            Ok(parsed) => parsed,
            Err(with_errors) => {
                let first = with_errors.errors.iter().next();
                let mut error = spec(GraphqlError::coded(
                    first.as_ref().map_or_else(
                        || "Syntax Error".to_owned(),
                        |diagnostic| format!("Syntax Error: {}", diagnostic.error),
                    ),
                    "GRAPHQL_PARSE_FAILED",
                ))
                .with_status(400);
                if let Some(location) = first.and_then(|diagnostic| diagnostic.line_column_range()) {
                    error.locations = vec![(location.start.line, location.start.column)];
                }
                return Err(Outcome::failed(error));
            }
        };
        let operations: Vec<&Node<ast::OperationDefinition>> = parsed
            .definitions
            .iter()
            .filter_map(|definition| match definition {
                ast::Definition::OperationDefinition(operation) => Some(operation),
                _ => None,
            })
            .collect();
        let chosen = match &operation_name {
            Some(name) => operations.iter().find(|operation| {
                operation.name.as_ref().is_some_and(|candidate| candidate == name.as_str())
            }),
            None if operations.len() == 1 => operations.first(),
            None => None,
        };
        let Some(chosen) = chosen else {
            return Err(Outcome::failed(
                GraphqlError::coded(
                    "Could not determine what operation to execute.",
                    "OPERATION_RESOLUTION_FAILURE",
                )
                .with_status(400),
            ));
        };
        if let Some(admin) = admin.as_deref_mut() {
            admin.mutation = chosen.operation_type == OperationType::Mutation;
        }
        if chosen.operation_type == OperationType::Mutation && request.method == "GET" {
            return Err(Outcome::failed(allow(
                bad_request("Can only perform a mutation operation from a POST request.", 405),
                "POST",
            )));
        }
        let document = match parsed.to_executable_validate(&compiled.schema) {
            Ok(document) => document,
            Err(with_errors) => {
                let errors = with_errors
                    .errors
                    .iter()
                    .map(|diagnostic| {
                        let mut error = spec(GraphqlError::coded(
                            diagnostic.error.to_string(),
                            "GRAPHQL_VALIDATION_FAILED",
                        ))
                        .with_status(400);
                        if let Some(location) = diagnostic.line_column_range() {
                            error.locations = vec![(location.start.line, location.start.column)];
                        }
                        error
                    })
                    .collect();
                return Err(Outcome { data: None, errors });
            }
        };
        let Ok(operation) = document.operations.get(operation_name.as_deref()) else {
            return Err(Outcome::failed(
                GraphqlError::coded(
                    "Could not determine what operation to execute.",
                    "OPERATION_RESOLUTION_FAILURE",
                )
                .with_status(400),
            ));
        };
        if let Some(admin) = admin {
            if operation.operation_type == OperationType::Subscription {
                return Err(Outcome::failed(GraphqlError::coded(
                    "Subscriptions need a transport; use /graphql/v1",
                    "CANOPY_INVALID_QUERY",
                )));
            }
            if admin.mutation && !admin.allow_mutations {
                return Err(Outcome::failed(GraphqlError::coded(
                    "Mutations are not allowed here",
                    "CANOPY_FORBIDDEN",
                )));
            }
        }
        let operation: Node<Operation> = operation.clone();
        let idempotency_key = request.header("idempotency-key");
        if let Some(error) =
            self.gate(caller, &compiled.schema, &document, &operation, &variables, idempotency_key.as_deref())
        {
            return Err(Outcome::failed(error));
        }
        Ok(Prepared { document, operation, variables, idempotency_key })
    }

    fn gate(
        &self,
        caller: &Caller,
        schema: &Valid<Schema>,
        document: &Valid<ExecutableDocument>,
        operation: &Node<Operation>,
        variables: &[(String, Json)],
        idempotency_key: Option<&str>,
    ) -> Option<GraphqlError> {
        let roles = &caller.context.roles;
        let denied = match self.options.introspection {
            IntrospectionMode::Always => false,
            IntrospectionMode::Never => true,
            IntrospectionMode::Authenticated => {
                !roles.contains(Role::AUTHENTICATED) && !roles.contains(Role::SERVICE)
            }
        };
        if denied && introspects(document) {
            return Some(GraphqlError::coded(
                "Introspection is not allowed for this caller",
                "CANOPY_FORBIDDEN",
            ));
        }
        if operation.operation_type == OperationType::Mutation
            && idempotency_key.is_some()
            && operation.selection_set.selections.len() != 1
        {
            return Some(GraphqlError::coded(
                "Idempotency-Key applies to an operation with exactly one mutation",
                "CANOPY_INVALID_QUERY",
            ));
        }
        check_operation(schema, document, operation, variables, &self.options.limits).into_iter().next()
    }

    fn not_acceptable(request_id: &str, acceptable: &[&str]) -> Response {
        let mut response = Response { status: 406, headers: Vec::new(), body: Vec::new() };
        response.headers.push(("accept".to_owned(), acceptable.join("; charset=utf-8, ")));
        response.headers.push(("x-request-id".to_owned(), request_id.to_owned()));
        response
    }

    /// Answers one result with the processor `Accept` picks among `processors`: an event stream, or a regular
    /// response.
    fn answer_one(
        &self,
        request: &Request,
        request_id: &str,
        outcome: Outcome,
        processors: &[&[&'static str]],
    ) -> Answer {
        match negotiate_in(request, processors) {
            Ok(EVENT_STREAM) => {
                let mut headers = Vec::new();
                let status = status_of(&outcome, true, &mut headers);
                headers.push(("x-request-id".to_owned(), request_id.to_owned()));
                let mut text = String::new();
                outcome.write(&mut text);
                Answer::Events(EventStream::new(status, headers, EventSource::Single(Some(text))))
            }
            _ => Answer::Response(self.respond_in(request, request_id, &[outcome], false, processors)),
        }
    }

    fn respond(&self, request: &Request, request_id: &str, outcomes: &[Outcome], batch: bool) -> Response {
        self.respond_in(request, request_id, outcomes, batch, DEFAULT_PROCESSORS)
    }

    fn respond_in(
        &self,
        request: &Request,
        request_id: &str,
        outcomes: &[Outcome],
        batch: bool,
        processors: &[&[&'static str]],
    ) -> Response {
        let media = match negotiate_in(request, processors) {
            Ok(media) if media == GRAPHQL_RESPONSE || media == JSON => media,
            Ok(_) => JSON,
            Err(acceptable) => return Graphql::not_acceptable(request_id, &acceptable),
        };
        let mut headers = vec![("content-type".to_owned(), format!("{media}; charset=utf-8"))];
        let mut status = 200;
        let mut text = String::new();
        if batch {
            text.push('[');
            for (position, outcome) in outcomes.iter().enumerate() {
                if position > 0 {
                    text.push(',');
                }
                outcome.write(&mut text);
            }
            text.push(']');
        } else if let Some(outcome) = outcomes.first() {
            outcome.write(&mut text);
            let application_json = media == JSON
                && outcome.errors.iter().any(|error| error.extension("originalError").is_none());
            status = status_of(outcome, application_json, &mut headers);
        }
        headers.push(("x-request-id".to_owned(), request_id.to_owned()));
        Response { status, headers, body: text.into_bytes() }
    }

    /// Answers a request to the endpoint; `None` for any other path. An event stream is collected into the
    /// body, so a transport that serves subscriptions uses [`Graphql::serve_answer`] instead.
    pub async fn serve(&self, request: &Request) -> Option<Response> {
        match self.serve_answer(request).await? {
            Answer::Response(response) => Some(response),
            Answer::Events(events) => {
                let (status, headers) = (events.status, events.headers.clone());
                Some(Response { status, headers, body: events.collect().await })
            }
        }
    }

    /// Answers a request to the endpoint, streaming a subscription (or any result the client asks for as
    /// `text/event-stream`) as server-sent events; `None` for any other path.
    pub async fn serve_answer(&self, request: &Request) -> Option<Answer> {
        if !self.owns(&request.target) {
            return None;
        }
        let too_large = match &request.body {
            Body::TooLarge => true,
            Body::Bytes(bytes) if bytes.len() as u64 > self.options.max_body_bytes => true,
            _ => request
                .header("content-length")
                .and_then(|length| length.trim().parse::<u64>().ok())
                .is_some_and(|length| length > self.options.max_body_bytes),
        };
        if too_large {
            let mut out = String::new();
            Outcome::failed(GraphqlError::coded(
                format!("The request body may not exceed {} bytes", self.options.max_body_bytes),
                "CANOPY_PAYLOAD_TOO_LARGE",
            ))
            .write(&mut out);
            return Some(Answer::Response(Response {
                status: 413,
                headers: vec![("content-type".to_owned(), JSON.to_owned())],
                body: out.into_bytes(),
            }));
        }
        let identity = self.rest.caller_of(request).await;
        if let Err(error) = &identity
            && error.code() == ErrorCode::RateLimited
        {
            return Some(Answer::Response(rate_limited(error, request, self.options.cors.as_ref())));
        }
        let request_id =
            request.header("x-request-id").filter(|given| is_request_id(given)).unwrap_or_else(uuid_v7);
        let mut answer = if request.method.eq_ignore_ascii_case("OPTIONS") && self.options.cors.is_some() {
            Answer::Response(Response {
                status: 204,
                headers: vec![
                    ("content-length".to_owned(), "0".to_owned()),
                    ("x-request-id".to_owned(), request_id.clone()),
                ],
                body: Vec::new(),
            })
        } else {
            match self.answer(request, &request_id, identity).await {
                Ok(answer) => answer,
                Err(error) => {
                    self.answer_one(request, &request_id, Outcome::failed(error), DEFAULT_PROCESSORS)
                }
            }
        };
        if let Some(cors) = &self.options.cors {
            let headers = match &mut answer {
                Answer::Response(response) => &mut response.headers,
                Answer::Events(events) => &mut events.headers,
            };
            for (name, value) in cors_headers(request, cors, self.options.cors_max_age_seconds) {
                match headers.iter_mut().find(|(key, _)| *key == name) {
                    Some(slot) => slot.1 = value,
                    None => headers.push((name, value)),
                }
            }
        }
        Some(answer)
    }

    async fn answer(
        &self,
        request: &Request,
        request_id: &str,
        identity: Result<Caller, CanopyError>,
    ) -> Result<Answer, GraphqlError> {
        if request.method != "GET" && request.method != "POST" {
            return Err(allow(bad_request("GraphQL only supports GET and POST requests.", 405), "GET, POST"));
        }
        let body = match &request.body {
            Body::Bytes(bytes) => bytes.as_slice(),
            _ => &[],
        };
        let params = if request.method == "GET" {
            let query = request.target.split_once('?').map_or("", |(_, query)| query);
            params_of(&search_params(query))?
        } else if content_type_is(request, "application/json")
            || content_type_is(request, "application/graphql+json")
        {
            let text = String::from_utf8_lossy(body);
            match parse_json(text.trim_start_matches('\u{feff}')) {
                Ok(Json::Null) => {
                    return Err(bad_request("POST body is expected to be object but received null", 400));
                }
                Ok(Json::Object(entries)) => Json::Object(entries),
                Ok(Json::Array(items)) => Json::Array(items),
                Ok(other) => {
                    return Err(bad_request(
                        format!("POST body is expected to be object but received {}", json_type(&other)),
                        400,
                    ));
                }
                Err(error) => {
                    let mut error_out = spec(bad_request("POST body sent invalid JSON.", 400));
                    error_out.extensions.push((
                        "originalError".to_owned(),
                        Json::Object(vec![
                            ("name".to_owned(), Json::String("SyntaxError".to_owned())),
                            ("message".to_owned(), Json::String(error.message().to_owned())),
                        ]),
                    ));
                    return Err(error_out);
                }
            }
        } else if content_type_is(request, "application/graphql") {
            Json::Object(vec![("query".to_owned(), Json::String(String::from_utf8_lossy(body).into_owned()))])
        } else if content_type_is(request, "application/x-www-form-urlencoded") {
            params_of(&search_params(&String::from_utf8_lossy(body)))?
        } else {
            return Ok(Answer::Response(Response {
                status: 415,
                headers: vec![("x-request-id".to_owned(), request_id.to_owned())],
                body: Vec::new(),
            }));
        };
        let caller = identity.map_err(|error| GraphqlError::from_canopy(&error))?;
        let compiled = self.schema_of(&caller).await.map_err(|error| GraphqlError::from_canopy(&error))?;
        if let Json::Array(items) = &params {
            if self.options.max_batch == 0 {
                return Err(bad_request("Batching is not supported.", 400));
            }
            if items.len() > self.options.max_batch {
                return Err(bad_request(
                    format!("Batching is limited to {} operations per request.", self.options.max_batch),
                    413,
                ));
            }
            let mut outcomes = Vec::with_capacity(items.len());
            for item in items {
                outcomes.push(self.operation(request, &caller, &compiled, item).await);
            }
            return Ok(Answer::Response(self.respond(request, request_id, &outcomes, true)));
        }
        let prepared = match self.prepare(request, &caller, &compiled, &params, None) {
            Ok(prepared) => prepared,
            Err(outcome) => return Ok(self.answer_one(request, request_id, outcome, DEFAULT_PROCESSORS)),
        };
        let services = Services {
            reads: self.reads(),
            writes: self.rest.write_path().map(Arc::as_ref),
            caller: &caller,
            idempotency_key: prepared.idempotency_key.clone(),
        };
        if prepared.operation.operation_type != OperationType::Subscription || self.live.is_none() {
            let result = execute(
                &compiled.generated,
                &compiled.schema,
                &prepared.document,
                &prepared.operation,
                &prepared.variables,
                &services,
            )
            .await;
            return Ok(self.answer_one(request, request_id, result.into(), DEFAULT_PROCESSORS));
        }
        let source = match subscription_source(
            &compiled.generated,
            &compiled.schema,
            &prepared.document,
            &prepared.operation,
            &prepared.variables,
            &services,
        ) {
            Ok(source) => source,
            Err(result) => {
                return Ok(self.answer_one(request, request_id, result.into(), SUBSCRIPTION_PROCESSORS));
            }
        };
        if let Err(acceptable) = negotiate_in(request, STREAM_PROCESSORS) {
            return Ok(Answer::Response(Graphql::not_acceptable(request_id, &acceptable)));
        }
        let run = self
            .follow(request, caller, compiled, prepared, source)
            .map_err(|error| GraphqlError::from_canopy(&error))?;
        let headers = vec![("x-request-id".to_owned(), request_id.to_owned())];
        Ok(Answer::Events(EventStream::new(200, headers, EventSource::Live(Box::new(run)))))
    }

    /// Follows the live query of a subscription for the request's credentials.
    fn follow(
        &self,
        request: &Request,
        caller: Caller,
        compiled: Arc<CompiledSchema>,
        prepared: Prepared,
        source: SubscriptionSource,
    ) -> Result<SubscriptionRun, CanopyError> {
        let live = self
            .live
            .as_ref()
            .ok_or_else(|| CanopyError::new(ErrorCode::Unavailable, "Live queries need realtime"))?;
        let credentials = credentials_from_headers(request)?;
        let stream = live.follow(
            LiveCredentials { key: credentials.key, token: credentials.token },
            request.client_address.clone(),
            source.query,
        )?;
        Ok(SubscriptionRun {
            rest: Arc::clone(&self.rest),
            compiled,
            prepared,
            caller,
            kind: source.kind,
            stream,
            tracker: ChangeTracker::default(),
            changes: VecDeque::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepting(accept: Option<&str>) -> Request {
        let request = Request::new("POST", "/graphql/v1");
        match accept {
            Some(accept) => request.with_header("accept", accept),
            None => request,
        }
    }

    #[test]
    fn the_first_acceptable_media_type_of_the_header_wins() {
        assert_eq!(negotiate(&accepting(None)), Ok(JSON));
        assert_eq!(negotiate(&accepting(Some("application/graphql-response+json"))), Ok(GRAPHQL_RESPONSE));
        assert_eq!(
            negotiate(&accepting(Some("application/json, application/graphql-response+json"))),
            Ok(JSON)
        );
        assert_eq!(
            negotiate(&accepting(Some("application/graphql-response+json, application/json"))),
            Ok(GRAPHQL_RESPONSE)
        );
        assert_eq!(negotiate(&accepting(Some("application/*"))), Ok(JSON));
        assert_eq!(negotiate(&accepting(Some("application/json; charset=latin1"))).ok(), None);
        assert_eq!(
            negotiate(&accepting(Some("text/html"))),
            Err(vec!["text/event-stream", "multipart/mixed", GRAPHQL_RESPONSE, JSON])
        );
    }

    #[test]
    fn cors_follows_the_yoga_rules_for_each_setting() {
        let from = |origin: &str| Request::new("POST", "/graphql/v1").with_header("origin", origin);
        let names = |headers: &[(String, String)]| {
            headers.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>()
        };
        assert_eq!(
            names(&cors_headers(&from("https://a.test"), &Cors::Any, 600)),
            [
                "access-control-allow-origin=https://a.test",
                "vary=Origin",
                "access-control-allow-headers=apikey, authorization, content-type, accept, idempotency-key, x-request-id",
                "access-control-max-age=600"
            ]
        );
        let one = Cors::Origins(vec!["https://a.test".into()]);
        assert_eq!(
            cors_headers(&from("https://evil.test"), &one, 0)[0].1,
            "https://a.test",
            "a single origin is always named"
        );
        let two = Cors::Origins(vec!["https://a.test".into(), "https://b.test".into()]);
        assert!(cors_headers(&from("https://evil.test"), &two, 600).is_empty());
        let allowed = names(&cors_headers(
            &from("https://b.test").with_header("access-control-request-method", "POST"),
            &two,
            600,
        ));
        assert!(allowed.contains(&"access-control-allow-origin=https://b.test".to_owned()));
        assert!(allowed.contains(&"access-control-allow-methods=POST".to_owned()));
        assert!(allowed.contains(&"access-control-allow-credentials=true".to_owned()));
        assert!(
            cors_headers(&Request::new("POST", "/graphql/v1"), &Cors::Any, 600).is_empty(),
            "no Origin, no headers"
        );
    }

    #[test]
    fn a_rate_limited_request_gets_the_handler_body_and_retry_after() {
        let error = canopy_auth_error();
        let response = rate_limited(
            &error,
            &Request::new("POST", "/graphql/v1").with_header("origin", "https://a.test"),
            Some(&Cors::Any),
        );
        assert_eq!(response.status, 429);
        assert_eq!(response.header("retry-after"), Some("3"));
        assert_eq!(response.header("access-control-allow-origin"), Some("*"));
        assert_eq!(
            String::from_utf8_lossy(&response.body),
            r#"{"errors":[{"message":"Too many requests. Retry in 3 seconds.","extensions":{"code":"CANOPY_RATE_LIMITED","details":{"retryAfterSeconds":3},"http":{"status":429}}}]}"#
        );
    }

    fn canopy_auth_error() -> CanopyError {
        CanopyError::new(ErrorCode::RateLimited, "Too many requests. Retry in 3 seconds.")
            .with_details(r#"{"retryAfterSeconds":3}"#)
    }

    #[test]
    fn form_values_decode_plus_and_percent_escapes() {
        assert_eq!(
            search_params("query=%7B+a+%7D&x=%zz&y"),
            [("query".into(), "{ a }".into()), ("x".into(), "%zz".into()), ("y".into(), String::new())]
        );
    }
}
