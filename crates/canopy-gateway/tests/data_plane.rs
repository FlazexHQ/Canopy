//! The gateway as a process in front of an upstream server: which requests the Data API routes answer
//! themselves and which go to the upstream, byte for byte. The recorded requests of `conformance/http/find` and
//! `conformance/http/reads` are sent over a real socket to the gateway with their routes selected, and every
//! other request is shown to reach the upstream untouched. The replay needs a MongoDB replica set in
//! `CANOPY_TEST_MONGODB_URI` and is skipped without one; the fail closed tests need none.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../../canopy-http/tests/common/mod.rs"]
mod common;

#[path = "../../canopy-graphql/tests/graphql_replay/mod.rs"]
mod graphql_replay;

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use canopy_mongo::mongodb::Client;
use canopy_protocol::json::{Json, write_json};
use common::{
    case_files, case_files_of, fixture, get, list, mongodb_uri, problems_of, request_of, seed, text,
};
use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{KeyValue, any_value};
use opentelemetry_proto::tonic::trace::v1::Span;
use opentelemetry_proto::tonic::trace::v1::span::SpanKind;
use prost::Message as _;

const GATEWAY: &str = env!("CARGO_BIN_EXE_canopy-gateway");

/// What the upstream saw: the method and the exact request target of each request, in arrival order.
type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// An upstream server that answers every request with `upstream <method> <target>` and `x-upstream: yes`, and
/// remembers what it was asked.
async fn upstream() -> (u16, Seen) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("an upstream port");
    let port = listener.local_addr().expect("an address").port();
    let seen: Seen = Arc::default();
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let log = Arc::clone(&log);
                    async move {
                        let method = request.method().as_str().to_owned();
                        let target =
                            request.uri().path_and_query().map_or_else(String::new, |t| t.to_string());
                        log.lock().expect("the log").push((method.clone(), target.clone()));
                        let mut response =
                            Response::new(Full::new(Bytes::from(format!("upstream {method} {target}"))));
                        response.headers_mut().insert("x-upstream", "yes".parse().expect("a header value"));
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await;
            });
        }
    });
    (port, seen)
}

/// A gateway process. Closing its standard input drains it; dropping this kills it.
struct Gateway {
    child: Child,
    port: u16,
}

impl Gateway {
    /// Starts the gateway on `config` (with `routes` from the environment when given) and waits until it listens.
    async fn start(config: String, routes: Option<&str>) -> Gateway {
        Gateway::start_with(config, routes, &[]).await
    }

    /// Starts the gateway as [`Gateway::start`] does, with `env` set and no other `OTEL_*` variable.
    async fn start_with(config: String, routes: Option<&str>, env: &[(&str, &str)]) -> Gateway {
        let mut command = Command::new(GATEWAY);
        command.args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        command.env_remove("CANOPY_DATA_PLANE_ROUTES").env_remove("CANOPY_TRACING");
        for (name, _) in std::env::vars() {
            if name.starts_with("OTEL_") {
                command.env_remove(name);
            }
        }
        if let Some(routes) = routes {
            command.env("CANOPY_DATA_PLANE_ROUTES", routes);
        }
        command.envs(env.iter().copied());
        let mut child = command.spawn().expect("the gateway starts");
        let stdin = child.stdin.as_mut().expect("standard input");
        stdin.write_all(format!("{config}\n").as_bytes()).expect("the configuration is written");
        stdin.flush().expect("flushed");
        let stdout = child.stdout.take().expect("standard output");
        let line = tokio::task::spawn_blocking(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).map(|_| line)
        })
        .await
        .expect("the reader finishes")
        .expect("a line");
        let port = line
            .split("\"port\":")
            .nth(1)
            .and_then(|rest| rest.trim_end_matches(['}', '\n', '\r']).parse().ok())
            .unwrap_or_else(|| panic!("the gateway did not report a port: {line:?}"));
        Gateway { child, port }
    }

    /// Writes one line to the gateway's standard input.
    fn send_line(&mut self, line: &str) {
        let stdin = self.child.stdin.as_mut().expect("standard input");
        stdin.write_all(format!("{line}\n").as_bytes()).expect("written");
        stdin.flush().expect("flushed");
    }

    /// Sends a request with its exact target over a new connection.
    async fn send(&self, request: &canopy_http::Request) -> canopy_http::Response {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.expect("connected");
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.expect("a handshake");
        tokio::spawn(connection);
        let mut builder = Request::builder()
            .method(request.method.as_str())
            .uri(request.target.as_str())
            .header("host", format!("127.0.0.1:{}", self.port));
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let body = match &request.body {
            canopy_http::Body::Bytes(bytes) => Bytes::from(bytes.clone()),
            other => panic!("a test sends bytes, not {other:?}"),
        };
        let response = sender
            .send_request(builder.body(Full::new(body)).expect("a request"))
            .await
            .unwrap_or_else(|error| panic!("{} {}: {error}", request.method, request.target));
        let (parts, body) = response.into_parts();
        let body = body.collect().await.expect("a body").to_bytes();
        canopy_http::Response {
            status: parts.status.as_u16(),
            headers: parts
                .headers
                .iter()
                .map(|(name, value)| {
                    (name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned())
                })
                .collect(),
            body: body.to_vec(),
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn json_text(json: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, json);
    out
}

/// The launcher document of a gateway that reads `database` with the policies, keys and tokens of the fixture.
fn launcher(fixture: &Json, uri: &str, database: &str, upstream: u16, extra: &str) -> String {
    let body_limit = fixture
        .get("maxBodyBytes")
        .map_or_else(String::new, |limit| format!(r#","maxBodyBytes":{}"#, json_text(limit)));
    let auth = get(fixture, "auth");
    let policies = get(fixture, "policies");
    let limits = get(fixture, "readLimits");
    let keys = |name: &str| json_text(get(auth, name));
    let document = format!(
        r#"{{"mongodb":{{"uri":{uri},"database":"{database}","metaDatabase":"{database}_meta"}},
"server":{{"host":"127.0.0.1","port":0,"metricsPort":0,"shards":2}},
"auth":{{"issuer":{issuer},"jwks":{jwks},"rolesClaim":{roles}}},
"keys":{{"publishable":{publishable},"secret":{secret}}},
"policies":{{"stored":{stored},"contexts":{contexts}}},
"realtime":{{"checkpoints":"off","drainWindowMs":100}},
"rateLimits":false,
"rest":{{"defaultLimit":{default},"maxLimit":{max},"maxSkip":{skip},"idTypes":{id_types}{body_limit}}},
"proxy":{{"url":"http://127.0.0.1:{upstream}"}},
"log":{{"level":"error"}}{extra}}}"#,
        uri = json_text(&Json::String(uri.to_owned())),
        issuer = json_text(get(auth, "issuer")),
        jwks = json_text(get(auth, "jwks")),
        roles = json_text(get(auth, "rolesClaim")),
        publishable = keys("publishableKeys"),
        secret = keys("secretKeys"),
        stored = json_text(get(policies, "collections")),
        contexts = json_text(get(policies, "contexts")),
        default = json_text(get(limits, "defaultLimit")),
        max = json_text(get(limits, "maxLimit")),
        skip = json_text(get(limits, "maxSkip")),
        id_types = json_text(get(fixture, "idTypes")),
    );
    document.replace(['\n', '\r'], "")
}

/// The recorded cases the gateway does not answer, because the TypeScript server does: a path outside the REST
/// base path is the server's own `404`, and a path that is not validly percent encoded is answered before any
/// route is chosen. In a real deployment the upstream gives the recorded answer, which the TypeScript replay of
/// the same files shows.
const LEFT_TO_THE_UPSTREAM: [&str; 2] = ["outside-base-path", "bad-percent-encoding"];

/// The requests that are not the collection routes: they must reach the upstream untouched.
fn other_requests() -> Vec<(&'static str, &'static str)> {
    vec![
        ("POST", "/rest/v1/todos"),
        ("PATCH", "/rest/v1/todos?where=%7B%7D"),
        ("DELETE", "/rest/v1/todos"),
        ("GET", "/rest/v1/todos/abc"),
        ("PUT", "/rest/v1/todos/abc"),
        ("POST", "/rest/v1/todos/_count"),
        ("POST", "/rest/v1/_batch"),
        ("GET", "/rest/v1/openapi.json"),
        ("GET", "/rest/v1"),
        ("GET", "/rest/v1/a/b/c"),
        ("GET", "/graphql/v1"),
        ("POST", "/graphql/v1"),
        ("GET", "/storage/v1/object/x"),
        ("GET", "/auth/v1/jwks"),
        ("GET", "/"),
        ("GET", "/rest/v10/todos"),
    ]
}

fn owned_requests() -> Vec<(&'static str, &'static str)> {
    vec![
        ("GET", "/rest/v1/todos"),
        ("GET", "/rest/v1/todos?limit=1"),
        ("OPTIONS", "/rest/v1/todos"),
        ("PUT", "/rest/v1/todos"),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_selected_find_route_answers_every_recorded_request_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_gateway_find_rs");
    seed(&client.database(&database), &fixture).await;
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut failures = Vec::new();
    let mut total = 0;
    let mut passed_on = 0;
    for (routes, extra) in
        [(Some("find"), String::new()), (None, r#","dataPlane":{"routes":["find"]}"#.to_owned())]
    {
        let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, &extra), routes).await;
        let mut count = 0;
        for (file, json) in case_files() {
            for case in list(&json, "cases") {
                count += 1;
                let id = text(case, "id");
                let request = request_of(&fixture, case);
                let response = gateway.send(&request).await;
                if LEFT_TO_THE_UPSTREAM.contains(&id) {
                    if response.header("x-upstream") != Some("yes") {
                        failures.push(format!("{file} {id}: the gateway answered a request it must pass on"));
                    }
                    passed_on += 1;
                    continue;
                }
                if response.header("x-upstream").is_some() {
                    failures.push(format!("{file} {id}: the upstream answered"));
                    continue;
                }
                let problems = problems_of(case, &response);
                if !problems.is_empty() {
                    failures.push(format!("{file} {id}: {}", problems.join("; ")));
                }
            }
        }
        total = count;
    }
    client.database(&database).drop().await.expect("the scratch database drops");
    assert!(total >= 200, "{total} cases");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(passed_on, 2 * LEFT_TO_THE_UPSTREAM.len(), "each gateway passes those cases on");
    let reached = seen.lock().unwrap().clone();
    assert_eq!(
        reached.len(),
        passed_on,
        "only the requests that are not the collection route reach the upstream: {reached:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_selected_read_routes_answer_every_recorded_read_request_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_gateway_reads_rs");
    seed(&client.database(&database), &fixture).await;
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let gateway = Gateway::start(
        launcher(&fixture, &uri, &database, port, ""),
        Some("count,distinct,aggregate,query,explain,document"),
    )
    .await;
    let mut failures = Vec::new();
    let mut total = 0;
    for (file, json) in case_files_of("reads") {
        for case in list(&json, "cases") {
            total += 1;
            let id = text(case, "id");
            let response = gateway.send(&request_of(&fixture, case)).await;
            if response.header("x-upstream").is_some() {
                failures.push(format!("{file} {id}: the upstream answered"));
                continue;
            }
            let problems = problems_of(case, &response);
            if !problems.is_empty() {
                failures.push(format!("{file} {id}: {}", problems.join("; ")));
            }
        }
    }
    let find = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/todos")).await;
    client.database(&database).drop().await.expect("the scratch database drops");
    assert!(total >= 70, "{total} cases");
    assert!(failures.is_empty(), "{} of {total} cases differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(find.header("x-upstream"), Some("yes"), "find is not selected, so the upstream answers it");
    assert_eq!(*seen.lock().unwrap(), [("GET".to_owned(), "/rest/v1/todos".to_owned())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_writes_route_answers_every_recorded_write_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to write to");
        return;
    };
    let fixture = common::read_json(&common::directory_of("writes").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_gateway_writes_rs");
    let meta = format!("{database}_meta");
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, ""), Some("writes")).await;
    let cases = common::write_cases();
    let mut failures = Vec::new();
    for case in &cases {
        common::reset_writes(&client, &database, &meta, &fixture).await;
        for (index, step) in list(case, "steps").iter().enumerate() {
            let response = gateway.send(&common::write_request_of(&fixture, get(step, "request"))).await;
            if response.header("x-upstream").is_some() {
                failures.push(format!("{} step {index}: the upstream answered", text(case, "id")));
                continue;
            }
            failures.extend(common::write_step_problems(case, index, Some(&response)));
        }
        failures.extend(common::write_state_problems(&client, &database, &meta, case).await);
    }
    let read = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/notes")).await;
    client.database(&database).drop().await.expect("the scratch database drops");
    client.database(&meta).drop().await.expect("the meta database drops");
    assert!(cases.len() > 80, "{} cases", cases.len());
    assert!(
        failures.is_empty(),
        "{} failures in {} cases:
{}",
        failures.len(),
        cases.len(),
        failures.join(
            "
"
        )
    );
    assert_eq!(read.header("x-upstream"), Some("yes"), "find is not selected, so the upstream answers it");
    assert_eq!(*seen.lock().unwrap(), [("GET".to_owned(), "/rest/v1/notes".to_owned())]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_requests_the_routes_answer_are_sampled_into_the_request_log() {
    use canopy_mongo::mongodb::bson::{Bson, Document, doc};
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to log to");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (port, _) = upstream().await;
    let service = common::get_as(&fixture, "service", "/");
    let mut logged = Vec::new();
    for rate in [1.0, 0.0] {
        let database = common::scratch_name("canopy_gateway_log_rs");
        seed(&client.database(&database), &fixture).await;
        let meta = client.database(&format!("{database}_meta"));
        meta.collection::<Document>("settings")
            .insert_one(doc! { "_id": "settings", "requestLogSampleRate": rate })
            .await
            .expect("the settings are written");
        let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, ""), Some("find,count")).await;
        let mut find = canopy_http::Request::new("GET", "/rest/v1/todos/../todos?limit=1&title=eq.private");
        find.headers = service.headers.clone();
        let mut count = canopy_http::Request::new("POST", "/rest/v1/todos/_count").with_body(b"{}".to_vec());
        count.headers = service.headers.clone();
        count.headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let mut ids = Vec::new();
        for request in [find, count] {
            let response = gateway.send(&request).await;
            assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
            ids.push(response.header("x-request-id").expect("a request id").to_owned());
        }
        let log = meta.collection::<Document>("request_log");
        let started = Instant::now();
        let mut entries: Vec<Document> = Vec::new();
        while started.elapsed() < Duration::from_secs(if rate > 0.0 { 5 } else { 1 }) {
            let mut cursor = log.find(doc! {}).sort(doc! { "_id": 1 }).await.expect("a find");
            entries.clear();
            while cursor.advance().await.expect("a document") {
                entries.push(cursor.deserialize_current().expect("a document"));
            }
            if entries.len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        drop(gateway);
        client.database(&database).drop().await.expect("dropped");
        meta.drop().await.expect("dropped");
        logged.push((rate, entries, ids));
    }
    let (_, entries, ids) = &logged[0];
    assert_eq!(entries.len(), 2, "every request is kept at a rate of 1: {entries:?}");
    for (entry, (method, path, id)) in
        entries.iter().zip([("GET", "/rest/v1/todos", &ids[0]), ("POST", "/rest/v1/todos/_count", &ids[1])])
    {
        let keys: Vec<&str> = entry.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["_id", "at", "surface", "method", "path", "status", "durationMs", "ip", "requestId"]
        );
        assert_eq!(entry.get_str("surface").ok(), Some("rest"));
        assert_eq!(entry.get_str("method").ok(), Some(method));
        assert_eq!(entry.get_str("path").ok(), Some(path), "the path without its query and dot segments");
        assert_eq!(entry.get("status"), Some(&Bson::Int32(200)));
        assert!(matches!(entry.get("durationMs"), Some(Bson::Int32(_) | Bson::Double(_))));
        assert_eq!(entry.get_str("ip").ok(), Some("127.0.0.1"));
        assert_eq!(entry.get_str("requestId").ok(), Some(id.as_str()));
        assert!(matches!(entry.get("at"), Some(Bson::DateTime(_))));
    }
    assert!(logged[1].1.is_empty(), "nothing is kept at a rate of 0: {:?}", logged[1].1);
}

/// What a collector received: every span of every OTLP/HTTP export, with the service name of its resource.
type Exported = Arc<Mutex<Vec<(String, Span)>>>;

/// An OTLP/HTTP collector that decodes the protobuf exports sent to `/v1/traces`.
async fn collector() -> (u16, Exported) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a collector port");
    let port = listener.local_addr().expect("an address").port();
    let exported: Exported = Arc::default();
    let spans = Arc::clone(&exported);
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let spans = Arc::clone(&spans);
            tokio::spawn(async move {
                let service = service_fn(move |request: Request<Incoming>| {
                    let spans = Arc::clone(&spans);
                    async move {
                        let path = request.uri().path().to_owned();
                        let body = request.into_body().collect().await.expect("a body").to_bytes();
                        if path == "/v1/traces" {
                            let export = ExportTraceServiceRequest::decode(body).expect("an OTLP export");
                            let mut spans = spans.lock().expect("the spans");
                            for resource in export.resource_spans {
                                let service = resource
                                    .resource
                                    .iter()
                                    .flat_map(|resource| &resource.attributes)
                                    .find(|attribute| attribute.key == "service.name")
                                    .map(attribute_text)
                                    .unwrap_or_default();
                                for scope in resource.scope_spans {
                                    spans.extend(scope.spans.into_iter().map(|span| (service.clone(), span)));
                                }
                            }
                        }
                        let mut response = Response::new(Full::new(Bytes::new()));
                        response.headers_mut().insert(
                            "content-type",
                            "application/x-protobuf".parse().expect("a header value"),
                        );
                        Ok::<_, std::convert::Infallible>(response)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await;
            });
        }
    });
    (port, exported)
}

fn attribute_text(attribute: &KeyValue) -> String {
    match attribute.value.as_ref().and_then(|value| value.value.as_ref()) {
        Some(any_value::Value::StringValue(text)) => text.clone(),
        Some(any_value::Value::IntValue(number)) => number.to_string(),
        Some(any_value::Value::BoolValue(flag)) => flag.to_string(),
        other => format!("{other:?}"),
    }
}

fn attribute(span: &Span, key: &str) -> Option<String> {
    span.attributes.iter().find(|attribute| attribute.key == key).map(attribute_text)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn traces_continue_the_callers_trace_and_name_only_routes_and_commands() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_gateway_traces_rs");
    seed(&client.database(&database), &fixture).await;
    let (upstream_port, seen) = upstream().await;
    let (collector_port, exported) = collector().await;
    let endpoint = format!("http://127.0.0.1:{collector_port}");
    let gateway = Gateway::start_with(
        launcher(&fixture, &uri, &database, upstream_port, r#","telemetry":{"tracing":true}"#),
        Some("find,count"),
        &[("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint), ("OTEL_BSP_SCHEDULE_DELAY", "50")],
    )
    .await;
    let trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    let parent = "00f067aa0ba902b7";
    let find = common::get_as(&fixture, "alice", "/rest/v1/todos?title=eq.todo%201")
        .with_header("traceparent", format!("00-{trace}-{parent}-01"));
    let found = gateway.send(&find).await;
    let mut count = common::get_as(&fixture, "alice", "/rest/v1/todos/_count");
    count.method = "POST".to_owned();
    count = count.with_header("content-type", "application/json");
    count.body = canopy_http::Body::Bytes(b"{}".to_vec());
    let counted = gateway.send(&count).await;
    let mut insert = common::get_as(&fixture, "alice", "/rest/v1/todos");
    insert.method = "POST".to_owned();
    insert.body = canopy_http::Body::Bytes(b"{}".to_vec());
    let proxied = gateway.send(&insert.with_header("traceparent", format!("00-{trace}-{parent}-01"))).await;
    assert_eq!((found.status, counted.status), (200, 200));
    assert_eq!(proxied.header("x-upstream"), Some("yes"));

    let started = Instant::now();
    let spans = loop {
        let spans = exported.lock().expect("the spans").clone();
        let servers = spans.iter().filter(|(_, span)| span.kind == SpanKind::Server as i32).count();
        let commands = spans.iter().filter(|(_, span)| span.kind == SpanKind::Client as i32).count();
        if servers >= 2 && commands >= 2 {
            break spans;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "no spans were exported: {spans:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    drop(gateway);
    client.database(&database).drop().await.expect("the scratch database drops");

    let servers: Vec<&Span> =
        spans.iter().map(|(_, span)| span).filter(|span| span.kind == SpanKind::Server as i32).collect();
    assert_eq!(servers.len(), 2, "one server span per request a route answers, none for the upstream's");
    let get = servers.iter().find(|span| span.name == "GET /rest/v1").expect("the find span");
    assert_eq!(hex(&get.trace_id), trace, "the caller's trace continues");
    assert_eq!(hex(&get.parent_span_id), parent, "the caller's span is the parent");
    assert_eq!(attribute(get, "http.request.method").as_deref(), Some("GET"));
    assert_eq!(attribute(get, "http.route").as_deref(), Some("/rest/v1"));
    assert_eq!(attribute(get, "url.path").as_deref(), Some("/rest/v1/todos"));
    assert_eq!(attribute(get, "http.response.status_code").as_deref(), Some("200"));
    let post = servers.iter().find(|span| span.name == "POST /rest/v1").expect("the count span");
    assert_ne!(hex(&post.trace_id), trace, "a request without traceparent starts its own trace");
    assert!(post.parent_span_id.is_empty());
    assert_eq!(attribute(post, "url.path").as_deref(), Some("/rest/v1/todos/_count"));

    for server in [get, post] {
        let children: Vec<&Span> = spans
            .iter()
            .map(|(_, span)| span)
            .filter(|span| span.kind == SpanKind::Client as i32 && span.parent_span_id == server.span_id)
            .collect();
        let read = children
            .iter()
            .find(|span| attribute(span, "db.collection.name").as_deref() == Some("todos"))
            .unwrap_or_else(|| panic!("{} has no MongoDB span of todos: {children:?}", server.name));
        assert_eq!(read.trace_id, server.trace_id);
        assert_eq!(attribute(read, "db.system.name").as_deref(), Some("mongodb"));
        assert_eq!(attribute(read, "db.namespace").as_deref(), Some(database.as_str()));
        let operation = attribute(read, "db.operation.name").expect("an operation");
        assert_eq!(read.name, format!("{operation} {database}.todos"));
    }
    for (service, span) in &spans {
        assert_eq!(service, "canopy");
        let text = format!("{} {:?}", span.name, span.attributes);
        for private in ["alice", "todo 1", "canopy_pk", "Bearer"] {
            assert!(!text.contains(private), "a span carries {private}: {text}");
        }
        assert!(
            !["hello", "isMaster", "ismaster", "ping", "endSessions"]
                .iter()
                .any(|quiet| span.name.starts_with(quiet)),
            "{} is traced",
            span.name
        );
    }
    assert_eq!(seen.lock().unwrap().len(), 1, "only the insert reached the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_beyond_the_limit_answers_413_and_never_reaches_the_upstream() {
    let fixture = fixture();
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dead = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300";
    let config = launcher(&fixture, dead, "unreachable", port, "")
        .replace(r#""rest":{"#, r#""rest":{"maxBodyBytes":64,"#);
    let gateway = Gateway::start(config, Some("count,aggregate")).await;
    let service = common::get_as(&fixture, "service", "/");
    for (target, body) in [
        ("/rest/v1/todos/_count", format!(r#"{{"filter":{{"title":"{}"}}}}"#, "x".repeat(80))),
        (
            "/rest/v1/todos/_aggregate",
            format!(r#"{{"pipeline":[{{"$match":{{"t":"{}"}}}}]}}"#, "y".repeat(4096)),
        ),
    ] {
        let mut request = canopy_http::Request::new("POST", target).with_body(body.into_bytes());
        request.headers = service.headers.clone();
        request.headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let response = gateway.send(&request).await;
        assert_eq!(response.status, 413, "{target}: {}", String::from_utf8_lossy(&response.body));
        assert!(String::from_utf8_lossy(&response.body).contains("The request body may not exceed 64 bytes"));
        assert!(response.header("x-upstream").is_none());
    }
    let mut small = canopy_http::Request::new("POST", "/rest/v1/todos/_count").with_body(b"{}".to_vec());
    small.headers = service.headers.clone();
    small.headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let response = gateway.send(&small).await;
    assert_eq!(
        response.status,
        503,
        "a body within the limit reaches the read: {}",
        String::from_utf8_lossy(&response.body)
    );
    assert!(seen.lock().unwrap().is_empty(), "no request reached the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn other_requests_reach_the_upstream_unchanged_and_without_the_route_so_do_all() {
    let fixture = fixture();
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dead = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300";
    let service = common::get_as(&fixture, "service", "/");

    let with_find = Gateway::start(launcher(&fixture, dead, "unreachable", port, ""), Some("find")).await;
    for (method, target) in other_requests() {
        seen.lock().unwrap().clear();
        let mut request = canopy_http::Request::new(method, target);
        request.headers = service.headers.clone();
        let response = with_find.send(&request).await;
        assert_eq!(response.header("x-upstream"), Some("yes"), "{method} {target} reaches the upstream");
        assert_eq!(response.status, 200, "{method} {target}");
        assert_eq!(
            String::from_utf8_lossy(&response.body),
            format!("upstream {method} {target}"),
            "{method} {target}: the upstream's answer comes back as it is"
        );
        assert_eq!(*seen.lock().unwrap(), [(method.to_owned(), target.to_owned())], "{method} {target}");
    }
    seen.lock().unwrap().clear();
    for (method, target) in owned_requests() {
        let mut request = canopy_http::Request::new(method, target);
        request.headers = service.headers.clone();
        let response = with_find.send(&request).await;
        assert!(response.header("x-upstream").is_none(), "{method} {target} is served by the gateway");
        assert!(response.header("x-request-id").is_some(), "{method} {target} carries a request id");
    }
    assert!(seen.lock().unwrap().is_empty(), "the owned requests never reach the upstream");
    drop(with_find);

    let without = Gateway::start(launcher(&fixture, dead, "unreachable", port, ""), None).await;
    seen.lock().unwrap().clear();
    let mut expected = Vec::new();
    for (method, target) in other_requests().into_iter().chain(owned_requests()) {
        let response = without.send(&canopy_http::Request::new(method, target)).await;
        assert_eq!(response.header("x-upstream"), Some("yes"), "{method} {target} without the route");
        assert_eq!(String::from_utf8_lossy(&response.body), format!("upstream {method} {target}"));
        expected.push((method.to_owned(), target.to_owned()));
    }
    assert_eq!(*seen.lock().unwrap(), expected, "without a route every request goes to the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_database_answers_503_from_the_route_and_never_data() {
    let fixture = fixture();
    let (port, seen) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dead = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300";
    let gateway = Gateway::start(launcher(&fixture, dead, "unreachable", port, ""), Some("find")).await;
    let response = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/todos")).await;
    assert_eq!(response.status, 503);
    let body = String::from_utf8(response.body.clone()).expect("text");
    assert!(body.contains("\"code\":\"CANOPY_UNAVAILABLE\""), "{body}");
    assert!(!body.contains("\"data\""), "{body}");
    assert!(response.header("x-upstream").is_none());
    assert!(seen.lock().unwrap().is_empty(), "a failing route is never retried on the upstream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policies_sent_while_running_apply_to_the_next_find() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set to read from");
        return;
    };
    let fixture = fixture();
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_gateway_policies_rs");
    seed(&client.database(&database), &fixture).await;
    let (port, _) = upstream().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut gateway = Gateway::start(launcher(&fixture, &uri, &database, port, ""), Some("find")).await;
    let alice = common::get_as(&fixture, "alice", "/rest/v1/todos");

    let before = gateway.send(&alice).await;
    assert_eq!(before.status, 200);
    assert!(!String::from_utf8_lossy(&before.body).starts_with("{\"data\":[]"), "alice reads todos");

    gateway.send_line(r#"{"t":"policies","stored":[],"contexts":null}"#);
    let started = Instant::now();
    let after = loop {
        let answer = gateway.send(&alice).await;
        if answer.status != 200 || started.elapsed() > Duration::from_secs(10) {
            break answer;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(after.status, 404, "{}", String::from_utf8_lossy(&after.body));
    assert!(String::from_utf8_lossy(&after.body).contains("Unknown collection 'todos'"));
    let service = gateway.send(&common::get_as(&fixture, "service", "/rest/v1/todos")).await;
    assert_eq!(service.status, 200, "the service role still reads");
    client.database(&database).drop().await.expect("the scratch database drops");
}

/// Runs the gateway with a configuration it must refuse, and returns its exit code and what it said.
fn refused(config: &str, routes: Option<&str>) -> (Option<i32>, String) {
    let mut command = Command::new(GATEWAY);
    command.args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env_remove("CANOPY_DATA_PLANE_ROUTES");
    if let Some(routes) = routes {
        command.env("CANOPY_DATA_PLANE_ROUTES", routes);
    }
    let mut child = command.spawn().expect("the gateway starts");
    child
        .stdin
        .as_mut()
        .expect("standard input")
        .write_all(format!("{config}\n").as_bytes())
        .expect("written");
    let mut stderr = child.stderr.take().expect("standard error");
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait().expect("waits") {
            break status.code();
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            panic!("the gateway kept running with a configuration it must refuse");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut message = String::new();
    stderr.read_to_string(&mut message).expect("standard error");
    (code, message)
}

#[test]
fn an_export_protocol_the_gateway_does_not_speak_stops_it_at_startup() {
    let document = r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"server":{"port":0,"metricsPort":0},"telemetry":{"tracing":true}}"#;
    let mut command = Command::new(GATEWAY);
    command.args(["--config", "-"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    for (name, _) in std::env::vars() {
        if name.starts_with("OTEL_") || name == "CANOPY_TRACING" {
            command.env_remove(name);
        }
    }
    command.env("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc");
    let mut child = command.spawn().expect("the gateway starts");
    child
        .stdin
        .as_mut()
        .expect("standard input")
        .write_all(format!("{document}\n").as_bytes())
        .expect("written");
    let output = child.wait_with_output().expect("the gateway exits");
    assert_eq!(output.status.code(), Some(1));
    let message = String::from_utf8_lossy(&output.stderr);
    assert!(message.contains("OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf, not grpc"), "{message}");
}

#[test]
fn a_route_name_the_gateway_does_not_know_stops_it_at_startup() {
    let document = r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"server":{"port":0,"metricsPort":0}}"#;
    for routes in ["batch", "find,insert", "QUERY", "find;count"] {
        let (code, message) = refused(document, Some(routes));
        assert_eq!(code, Some(1), "{routes}");
        assert!(
            message.contains(
                "dataPlane.routes may list find, count, distinct, aggregate, query, explain, document, writes and graphql, not"
            ),
            "{routes}: {message}"
        );
    }
    let (code, message) = refused(
        r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"dataPlane":{"routes":["find","batch"]}}"#,
        None,
    );
    assert_eq!(code, Some(1));
    assert!(message.contains("not batch"), "{message}");
    let (code, message) = refused(
        r#"{"mongodb":{"uri":"mongodb://127.0.0.1:1/app"},"rest":false,"dataPlane":{"routes":["find"]}}"#,
        None,
    );
    assert_eq!(code, Some(1));
    assert!(message.contains("rest: false disables"), "{message}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn selected_graphql_replays_the_typescript_oracle_through_the_gateway() {
    let Some(uri) = mongodb_uri() else {
        eprintln!("skipped: CANOPY_TEST_MONGODB_URI is not set, so there is no replica set");
        return;
    };
    let fixture = common::read_json(&common::directory_of("graphql").join("fixture.json"));
    let client = Client::with_uri_str(&uri).await.expect("a MongoDB client");
    let database = common::scratch_name("canopy_gateway_graphql");
    let meta = format!("{database}_meta");
    let (port, seen) = upstream().await;
    let limits = get(&fixture, "limits");
    let extra = format!(
        r#","graphql":{{"path":{},"maxDepth":{},"maxAliases":{},"maxComplexity":{},"maxBatch":{},"introspection":{},"persisted":{},"collections":{}}}"#,
        json_text(get(&fixture, "basePath")),
        json_text(get(limits, "maxDepth")),
        json_text(get(limits, "maxAliases")),
        json_text(get(limits, "maxComplexity")),
        json_text(get(&fixture, "maxBatch")),
        json_text(get(&fixture, "introspection")),
        json_text(get(&fixture, "persisted")),
        json_text(get(&fixture, "relations")),
    );
    let config = launcher(&fixture, &uri, &database, port, &extra);
    {
        let gateway = Gateway::start(config.clone(), None).await;
        let response = gateway.send(&canopy_http::Request::new("GET", text(&fixture, "basePath"))).await;
        assert_eq!(response.header("x-upstream"), Some("yes"));
    }
    {
        let cors = format!(r#"{extra},"cors":{{"origins":"*"}}"#);
        let gateway = Gateway::start(launcher(&fixture, &uri, &database, port, &cors), Some("graphql")).await;
        let request = canopy_http::Request::new("OPTIONS", text(&fixture, "basePath"))
            .with_header("origin", "https://example.test")
            .with_header("access-control-request-method", "POST");
        let response = gateway.send(&request).await;
        assert_eq!(response.status, 204);
        assert_eq!(response.header("access-control-allow-origin"), Some("https://example.test"));
        let response = gateway.send(&canopy_http::Request::new("POST", "/rest/v1/todos")).await;
        assert_eq!(response.header("x-upstream"), Some("yes"));
    }
    assert_eq!(
        seen.lock().expect("the upstream log").drain(..).collect::<Vec<_>>(),
        [
            ("GET".to_owned(), text(&fixture, "basePath").to_owned()),
            ("POST".to_owned(), "/rest/v1/todos".to_owned())
        ],
    );
    graphql_replay::replay(
        &client,
        &database,
        &meta,
        &fixture,
        async || Gateway::start(config.clone(), Some("graphql")).await,
        async |gateway: &Gateway, request| Some(gateway.send(request).await),
    )
    .await;
    assert!(seen.lock().expect("the upstream log").is_empty());
}
