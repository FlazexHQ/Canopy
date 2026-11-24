//! OpenTelemetry traces of the gateway, the spans the TypeScript server records: one server span for every
//! request a Rust route answers (continuing the caller's `traceparent`), one client span for every MongoDB
//! command, as a child of the request that caused it, and one span for every policy set loaded. Spans are
//! exported over OTLP/HTTP with protobuf, configured by the standard `OTEL_*` variables (endpoint, headers,
//! sampler, batch sizes, service name). Spans never carry document contents, filters or credentials.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use canopy_mongo::mongodb::event::EventHandler;
use canopy_mongo::mongodb::event::command::CommandEvent;
use canopy_policy::PolicySet;
use opentelemetry::context::FutureExt;
use opentelemetry::propagation::{Extractor, TextMapCompositePropagator, TextMapPropagator};
use opentelemetry::trace::{Span, SpanKind, Status, TraceContextExt, Tracer, TracerProvider};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider};

/// Commands that carry no request work: handshakes, monitoring and session cleanup.
const QUIET_COMMANDS: [&str; 8] =
    ["hello", "ismaster", "isMaster", "ping", "saslStart", "saslContinue", "buildInfo", "endSessions"];

/// The most command spans waiting for their reply. A command whose reply never arrives cannot hold memory
/// forever: past the limit new commands are not traced until replies make room.
const MAX_OPEN_COMMANDS: usize = 10_000;

/// Whether `OTEL_SDK_DISABLED` turns the SDK off, as the specification reads it.
fn sdk_disabled(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

/// Checks `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` and `OTEL_EXPORTER_OTLP_PROTOCOL`: the gateway exports with
/// `http/protobuf` only, so another protocol is refused at startup rather than silently ignored.
fn check_protocol(traces: Option<&str>, generic: Option<&str>) -> Result<(), String> {
    match traces.or(generic).map(str::trim) {
        None | Some("" | "http/protobuf") => Ok(()),
        Some(other) => Err(format!(
            "canopyd exports traces over OTLP/HTTP with protobuf: OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf, not {other}"
        )),
    }
}

/// The low cardinality route of a path, so span names carry no collection names or ids.
pub(crate) fn route_of(path: &str) -> &str {
    for prefix in ["/rest/v1", "/graphql/v1", "/storage/v1", "/realtime/v1", "/auth/v1", "/admin/v1"] {
        if let Some(rest) = path.strip_prefix(prefix)
            && (rest.is_empty() || rest.starts_with('/'))
        {
            return prefix;
        }
    }
    if matches!(path, "/healthz" | "/readyz" | "/.well-known/jwks.json") {
        return path;
    }
    if path == "/studio" || path.starts_with("/studio/") {
        return "/studio";
    }
    "other"
}

/// The parts of a command span that do not depend on its reply: name and attributes.
fn command_span(command_name: &str, db: &str, target: Option<&str>) -> (String, Vec<KeyValue>) {
    let name = match target {
        Some(collection) => format!("{command_name} {db}.{collection}"),
        None => format!("{command_name} {db}"),
    };
    let mut attributes = vec![
        KeyValue::new("db.system.name", "mongodb"),
        KeyValue::new("db.namespace", db.to_owned()),
        KeyValue::new("db.operation.name", command_name.to_owned()),
    ];
    if let Some(collection) = target {
        attributes.push(KeyValue::new("db.collection.name", collection.to_owned()));
    }
    (name, attributes)
}

struct Headers<'a>(&'a [(String, String)]);

impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, value)| value.as_str())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.iter().map(|(name, _)| name.as_str()).collect()
    }
}

type CommandKey = (String, u32, i32);

/// The tracer of the gateway. Cloning shares it.
#[derive(Clone)]
pub(crate) struct Telemetry {
    provider: SdkTracerProvider,
    tracer: SdkTracer,
    propagator: Arc<TextMapCompositePropagator>,
    commands: Arc<Mutex<HashMap<CommandKey, opentelemetry_sdk::trace::Span>>>,
}

impl Telemetry {
    /// Starts the exporter from the `OTEL_*` variables, or returns `None` when `OTEL_SDK_DISABLED` is `true`.
    /// Fails when the variables ask for an export protocol other than `http/protobuf`.
    pub(crate) fn start() -> Result<Option<Telemetry>, String> {
        let var = |name: &str| std::env::var(name).ok();
        if sdk_disabled(var("OTEL_SDK_DISABLED").as_deref()) {
            return Ok(None);
        }
        check_protocol(
            var("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").as_deref(),
            var("OTEL_EXPORTER_OTLP_PROTOCOL").as_deref(),
        )?;
        let exporter = SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .build()
            .map_err(|error| format!("Could not start the trace exporter: {error}"))?;
        let mut resource = Resource::builder();
        if var("OTEL_SERVICE_NAME").is_none_or(|name| name.trim().is_empty()) {
            resource = resource.with_service_name("canopy");
        }
        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(resource.build())
            .build();
        let tracer = provider.tracer("canopy");
        let propagator = TextMapCompositePropagator::new(vec![
            Box::new(TraceContextPropagator::new()),
            Box::new(BaggagePropagator::new()),
        ]);
        Ok(Some(Telemetry {
            provider,
            tracer,
            propagator: Arc::new(propagator),
            commands: Arc::new(Mutex::new(HashMap::new())),
        }))
    }

    /// The context of a server span for a request, continuing its `traceparent`, `tracestate` and `baggage`.
    /// End it with [`Telemetry::finish`].
    pub(crate) fn server(
        &self,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        route: Option<&str>,
    ) -> Context {
        let parent = self.propagator.extract(&Headers(headers));
        let route = route.unwrap_or_else(|| route_of(path));
        let span = self
            .tracer
            .span_builder(format!("{method} {route}"))
            .with_kind(SpanKind::Server)
            .with_attributes([
                KeyValue::new("http.request.method", method.to_owned()),
                KeyValue::new("http.route", route.to_owned()),
                KeyValue::new("url.path", path.to_owned()),
            ])
            .start_with_context(&self.tracer, &parent);
        parent.with_span(span)
    }

    /// Ends the server span of `context` with the response status; a `5xx` marks it failed.
    pub(crate) fn finish(context: &Context, status: u16) {
        let span = context.span();
        span.set_attribute(KeyValue::new("http.response.status_code", i64::from(status)));
        if status >= 500 {
            span.set_status(Status::error(""));
        }
        span.end();
    }

    /// Loads a policy set inside a `canopy.policy.load` span, which carries the version of the set loaded and
    /// fails when the load fails.
    pub(crate) async fn policy_load<E: std::fmt::Display>(
        &self,
        load: impl Future<Output = Result<PolicySet, E>>,
    ) -> Result<PolicySet, E> {
        let span = self.tracer.span_builder("canopy.policy.load").start(&self.tracer);
        let context = Context::current().with_span(span);
        let result = load.with_context(context.clone()).await;
        let span = context.span();
        match &result {
            Ok(set) => span.set_attribute(KeyValue::new("version", set.version().to_owned())),
            Err(error) => span.set_status(Status::error(error.to_string())),
        }
        span.end();
        result
    }

    pub(crate) fn tracer(&self) -> SdkTracer {
        self.tracer.clone()
    }

    /// The command event handler that records a client span for every MongoDB command, as a child of the span
    /// active in the task that sent it.
    pub(crate) fn command_handler(&self) -> EventHandler<CommandEvent> {
        let telemetry = self.clone();
        EventHandler::callback(move |event| telemetry.command(event))
    }

    fn command(&self, event: CommandEvent) {
        let Ok(mut open) = self.commands.lock() else { return };
        match event {
            CommandEvent::Started(started) => {
                if QUIET_COMMANDS.contains(&started.command_name.as_str()) || open.len() >= MAX_OPEN_COMMANDS
                {
                    return;
                }
                let target = started.command.get_str(&started.command_name).ok();
                let (name, attributes) = command_span(&started.command_name, &started.db, target);
                let span = self
                    .tracer
                    .span_builder(name)
                    .with_kind(SpanKind::Client)
                    .with_attributes(attributes)
                    .start_with_context(&self.tracer, &Context::current());
                let key = (started.connection.address.to_string(), started.connection.id, started.request_id);
                open.insert(key, span);
            }
            CommandEvent::Succeeded(succeeded) => {
                let key =
                    (succeeded.connection.address.to_string(), succeeded.connection.id, succeeded.request_id);
                if let Some(mut span) = open.remove(&key) {
                    span.end();
                }
            }
            CommandEvent::Failed(failed) => {
                let key = (failed.connection.address.to_string(), failed.connection.id, failed.request_id);
                if let Some(mut span) = open.remove(&key) {
                    span.set_status(Status::error(failed.failure.kind.to_string()));
                    span.end();
                }
            }
            _ => {}
        }
    }

    /// Exports the spans still queued and stops the exporter.
    pub(crate) fn shutdown(&self) {
        let _ = self.provider.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_name_the_surface_and_never_a_collection_or_id() {
        for (path, route) in [
            ("/rest/v1", "/rest/v1"),
            ("/rest/v1/todos", "/rest/v1"),
            ("/rest/v1/todos/_count", "/rest/v1"),
            ("/rest/v10/todos", "other"),
            ("/rest/v1x", "other"),
            ("/graphql/v1", "/graphql/v1"),
            ("/realtime/v1/sse", "/realtime/v1"),
            ("/auth/v1/token", "/auth/v1"),
            ("/admin/v1/keys/k1", "/admin/v1"),
            ("/healthz", "/healthz"),
            ("/readyz", "/readyz"),
            ("/.well-known/jwks.json", "/.well-known/jwks.json"),
            ("/studio", "/studio"),
            ("/studio/assets/app.js", "/studio"),
            ("/studios", "other"),
            ("/", "other"),
            ("/todos", "other"),
        ] {
            assert_eq!(route_of(path), route, "{path}");
        }
    }

    #[test]
    fn command_spans_name_the_command_database_and_collection_only() {
        let (name, attributes) = command_span("find", "app", Some("todos"));
        assert_eq!(name, "find app.todos");
        assert_eq!(
            attributes,
            vec![
                KeyValue::new("db.system.name", "mongodb"),
                KeyValue::new("db.namespace", "app"),
                KeyValue::new("db.operation.name", "find"),
                KeyValue::new("db.collection.name", "todos"),
            ]
        );
        let (name, attributes) = command_span("commitTransaction", "admin", None);
        assert_eq!(name, "commitTransaction admin");
        assert_eq!(attributes.len(), 3);
    }

    #[test]
    fn only_http_protobuf_is_accepted_as_the_export_protocol() {
        assert_eq!(check_protocol(None, None), Ok(()));
        assert_eq!(check_protocol(None, Some("http/protobuf")), Ok(()));
        assert_eq!(check_protocol(Some(" http/protobuf "), Some("grpc")), Ok(()));
        assert_eq!(check_protocol(Some(""), None), Ok(()));
        for (traces, generic, refused) in [
            (None, Some("grpc"), "grpc"),
            (Some("http/json"), None, "http/json"),
            (Some("grpc"), None, "grpc"),
        ] {
            assert_eq!(
                check_protocol(traces, generic),
                Err(format!(
                    "canopyd exports traces over OTLP/HTTP with protobuf: OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf, not {refused}"
                ))
            );
        }
    }

    #[test]
    fn the_sdk_is_off_only_when_disabled_is_true() {
        assert!(sdk_disabled(Some("true")));
        assert!(sdk_disabled(Some(" TRUE ")));
        assert!(!sdk_disabled(Some("false")));
        assert!(!sdk_disabled(Some("1")));
        assert!(!sdk_disabled(None));
    }
}
