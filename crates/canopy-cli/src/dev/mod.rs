//! `canopy dev`: the gateway in process, the project's policies hot reloaded on save, the config and env
//! files restarting it, and with `--with-mongo` a local replica set.

mod drift;
mod gateway;
mod mongo;
mod signals;
mod watch;

use std::path::{Component, Path};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use canopy_config::authoring::{Command, redact_uri};
use canopy_policy::{LintEnvironment, PolicySet, lint_policies};
use canopy_protocol::json::{Json, write_json};
use ring::rand::SecureRandom as _;
use tokio::sync::Notify;

use crate::invocation::Invocation;
use crate::project::{LoadError, Loading, Project, load_from};
use crate::{error_line, output};

use gateway::PolicySource;
use watch::Watched;

const POLL: Duration = Duration::from_millis(50);
pub(crate) const SETTLE: Duration = Duration::from_millis(30);

fn port_flag(call: &Invocation, flag: &str) -> Result<Option<u16>, String> {
    match call.text(flag) {
        None => Ok(None),
        Some(value) if value.bytes().all(|byte| byte.is_ascii_digit()) => value
            .parse::<u16>()
            .map(Some)
            .map_err(|_| format!("--{flag} needs a port number between 0 and 65535")),
        Some(_) => Err(format!("--{flag} needs a port number between 0 and 65535")),
    }
}

/// `canopy dev`.
pub(crate) fn run(call: &Invocation) -> Result<ExitCode, String> {
    let ports = [port_flag(call, "port"), port_flag(call, "mongo-port")];
    let errors: Vec<String> = ports.iter().filter_map(|port| port.as_ref().err().cloned()).collect();
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    let [server_port, mongo_port] = ports.map(|port| port.ok().flatten());
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut overrides = Vec::new();
    let mut binary = None;
    if call.has_flag("with-mongo") {
        let env = crate::project::environment(call);
        let database = call
            .text("database")
            .map(str::to_owned)
            .or_else(|| env.get("CANOPY_DB").cloned())
            .or_else(|| {
                env.get("MONGODB_URI").and_then(|uri| canopy_config::authoring::database_from_uri(uri))
            })
            .filter(|database| !database.is_empty())
            .unwrap_or_else(|| "app".to_owned());
        let port = mongo_port.unwrap_or(27017);
        let mut log = |line: &str| {
            let _ = output(format_args!("{line}"));
        };
        let started = if !call.has_flag("mongo-binary") && mongo::docker_available() {
            let image = call
                .text("mongo-image")
                .map(str::to_owned)
                .or_else(|| env.get("CANOPY_MONGO_IMAGE").cloned())
                .unwrap_or_else(|| mongo::DEFAULT_IMAGE.to_owned());
            mongo::start_docker(&cwd, port, &database, &image, &mut log)
        } else {
            if !call.has_flag("mongo-binary") {
                log("Docker is not running: using the MongoDB binaries");
            }
            let version = call.text("mongo-version").unwrap_or(mongo::DEFAULT_VERSION);
            mongo::start_binary(&cwd, port, &database, version, &mongo::cache_dir(&env), &mut log).map(
                |running| {
                    let uri = running.uri.clone();
                    binary = Some(running);
                    uri
                },
            )
        };
        match started {
            Ok(uri) => {
                output(format_args!("MongoDB is ready at {uri}"))?;
                overrides.push(("MONGODB_URI".to_owned(), uri));
            }
            Err(message) => return Err(format!("--with-mongo: {message}")),
        }
    }
    let result = serve(call, &overrides, server_port);
    if let Some(binary) = binary {
        binary.stop();
    }
    result
}

/// A gateway running in process.
struct Running {
    stop: Arc<Notify>,
    task: tokio::task::JoinHandle<Result<(), String>>,
    updates: tokio::sync::mpsc::UnboundedSender<PolicySet>,
}

impl Running {
    fn stop(self, runtime: &tokio::runtime::Runtime) -> Result<(), String> {
        self.stop.notify_one();
        match runtime.block_on(self.task) {
            Ok(result) => result,
            Err(error) => Err(error.to_string()),
        }
    }
}

struct Session {
    keys: Option<(String, String)>,
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    let _ = ring::rand::SystemRandom::new().fill(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn strings(value: Option<&Json>) -> Vec<String> {
    match value {
        Some(Json::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Json::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Loads the project for `canopy dev`, with session keys when the development config has none. Errors are
/// printed as the TypeScript CLI does; `None` means the project did not load.
fn load(call: &Invocation, overrides: &[(String, String)], session: &mut Session) -> Option<(Project, bool)> {
    let loading = Loading {
        command: Command::Dev,
        emit_as: Command::Dev,
        needs_policies: false,
        schema: None,
        env_files: true,
        overrides,
    };
    let report = |error: &LoadError| {
        let text = match error {
            LoadError::Message(message) => message.clone(),
            LoadError::Unexpected(message) => format!("error  {message}"),
            LoadError::Invalid { part, message } if part == "config" => message.clone(),
            LoadError::Invalid { message, .. } => format!("error  {message}"),
        };
        let _ = error_line(format_args!("{text}"));
    };
    let mut project = match load_from(call, &loading) {
        Ok(project) => project,
        Err(error) => {
            report(&error);
            return None;
        }
    };
    let resolution = &project.resolution;
    let generated = resolution.text("environment") == Some("development")
        && strings(resolution.value("keys.publishable")).is_empty()
        && strings(resolution.value("keys.secret")).is_empty();
    if generated {
        let (publishable, secret) = session
            .keys
            .get_or_insert_with(|| {
                (format!("canopy_pk_dev_{}", random_hex(12)), format!("canopy_sk_dev_{}", random_hex(18)))
            })
            .clone();
        let extra =
            [("CANOPY_PUBLISHABLE_KEYS".to_owned(), publishable), ("CANOPY_SECRET_KEYS".to_owned(), secret)];
        if let Err(error) = project.resolve_with(&extra) {
            report(&error);
            return None;
        }
    }
    Some((project, generated))
}

/// The policy set the gateway starts with, and where it comes from.
fn policy_source(project: &Project) -> Result<(PolicySource, Option<PolicySet>), String> {
    if project.dir_given {
        return Ok((PolicySource::Folder, Some(project.bundle.policy_set()?)));
    }
    let watch = project.resolution.value("policies.watch") != Some(&Json::Bool(false));
    Ok((PolicySource::Database { watch }, None))
}

fn start(
    runtime: &tokio::runtime::Runtime,
    project: &Project,
    port: u16,
) -> Result<(Running, u16, Option<String>, Option<PolicySet>), String> {
    let (source, policies) = policy_source(project)?;
    let document = gateway::document(&project.resolution, port, &source);
    let mut text = String::new();
    write_json(&mut text, &document);
    let (updates, incoming) = tokio::sync::mpsc::unbounded_channel();
    let (listening, bound) = tokio::sync::oneshot::channel();
    let setup_token = Arc::new(Mutex::new(None));
    let stop = Arc::new(Notify::new());
    let embedding = canopyd::Embedding {
        policies: incoming,
        listening,
        setup_token: Arc::clone(&setup_token),
        stop: Arc::clone(&stop),
    };
    let task = runtime.spawn(canopyd::embedded(text, policies.clone(), embedding));
    let running = Running { stop, task, updates };
    let port = match runtime.block_on(bound) {
        Ok(port) => port,
        Err(_) => {
            let message = match runtime.block_on(running.task) {
                Ok(Err(message)) => message,
                Ok(Ok(())) => "the server stopped before it listened".to_owned(),
                Err(error) => error.to_string(),
            };
            return Err(message);
        }
    };
    let token = setup_token.lock().ok().and_then(|token| token.clone());
    let active = match policies {
        Some(set) => Some(set),
        None => {
            let uri = project.text("mongodb.uri").unwrap_or_default().to_owned();
            let meta = project.text("mongodb.metaDatabase").unwrap_or("canopy").to_owned();
            runtime.block_on(async {
                let client = canopy_mongo::mongodb::Client::with_uri_str(&uri).await.ok()?;
                canopy_mongo::load_policies(&client.database(&meta)).await.ok()
            })
        }
    };
    Ok((running, port, token, active))
}

fn relative(from: &Path, to: &Path) -> String {
    let from: Vec<Component<'_>> = from.components().collect();
    let to: Vec<Component<'_>> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = from.iter().skip(common).map(|_| "..".to_owned()).collect();
    parts.extend(to.iter().skip(common).map(|part| part.as_os_str().to_string_lossy().into_owned()));
    parts.join(std::path::MAIN_SEPARATOR_STR)
}

fn banner(
    project: &Project,
    port: u16,
    generated: bool,
    setup_token: Option<&str>,
    set: Option<&PolicySet>,
    schema: Option<&str>,
) -> Vec<String> {
    let config = &project.resolution;
    let url = format!("http://localhost:{port}");
    let ws = format!("ws://localhost:{port}");
    let off = |path: &str| matches!(config.value(path), Some(Json::Bool(false)) | None);
    let mut lines = vec![
        format!(
            "Canopy dev  (config {})",
            project
                .file
                .as_deref()
                .map_or_else(|| "none, CANOPY_* variables".to_owned(), |file| relative(&project.cwd, file))
        ),
        String::new(),
        format!("  REST      {}", if off("rest") { "off".to_owned() } else { format!("{url}/rest/v1") }),
        format!(
            "  Realtime  {}",
            if off("realtime") { "off".to_owned() } else { format!("{ws}/realtime/v1") }
        ),
        format!(
            "  GraphQL   {}",
            if off("rest") || off("graphql") { "off".to_owned() } else { format!("{url}/graphql/v1") }
        ),
        format!(
            "  MongoDB   {}  (app database {})",
            redact_uri(project.text("mongodb.uri").unwrap_or_default()),
            project.text("mongodb.database").unwrap_or_default()
        ),
    ];
    let publishable = strings(config.value("keys.publishable"));
    let secret = strings(config.value("keys.secret"));
    match (generated, publishable.first(), secret.first()) {
        (true, Some(publishable), Some(secret)) => {
            lines.push(format!("  Keys      publishable {publishable}"));
            lines.push(format!(
                "            secret      {secret}  (generated for this session; never ship it)"
            ));
        }
        _ => lines.push(format!(
            "  Keys      {}, {} secret",
            publishable
                .first()
                .map_or_else(|| "no publishable key".to_owned(), |key| format!("publishable {key}")),
            secret.len()
        )),
    }
    let auth = match config.value("auth") {
        Some(auth @ Json::Object(_)) if auth.get("kind") == Some(&Json::String("builtin".to_owned())) => {
            "built in (users in the auth database)".to_owned()
        }
        Some(auth @ Json::Object(_)) => match auth.get("issuer") {
            Some(Json::String(issuer)) => issuer.clone(),
            _ => String::new(),
        },
        _ => "API keys only (no identity provider configured)".to_owned(),
    };
    lines.push(format!("  Auth      {auth}"));
    let empty = Vec::new();
    let definitions = set.map_or(&empty[..], PolicySet::collections);
    let contexts = set.map(PolicySet::contexts).cloned().unwrap_or_default();
    let errors = lint_policies(definitions, &contexts, &LintEnvironment::default())
        .iter()
        .filter(|finding| finding.severity == "error")
        .count();
    let count: usize = definitions.iter().map(|definition| definition.policies.len()).sum();
    let source = match config.text("policies.dir") {
        Some(dir) => {
            let shown = relative(&project.cwd, Path::new(dir));
            if shown.is_empty() { ".".to_owned() } else { shown }
        }
        None => "the meta database".to_owned(),
    };
    lines.push(format!(
        "  Policies  {} collections, {count} policies from {source}, {errors} lint errors",
        definitions.len()
    ));
    let studio =
        config.text("server.adminListen").map_or_else(|| url.clone(), |admin| format!("http://{admin}"));
    lines.push(format!("  Studio    {studio}/studio"));
    if let Some(token) = setup_token {
        lines.push(format!("            no owner yet: claim it in Studio with the setup token {token}"));
    }
    if let Some(file) = schema {
        lines.push(format!("  Schema    {file}  (warns when MongoDB drifts from it)"));
    }
    lines.push(String::new());
    lines.push(
        "Watching the config and env files (restart) and the policies (hot reload). Ctrl+C stops.".to_owned(),
    );
    lines
}

fn print(lines: &[String]) {
    for line in lines {
        let _ = output(format_args!("{line}"));
    }
}

fn schema_file(cwd: &Path) -> Option<String> {
    ["canopy.schema.ts", "canopy.schema.js"]
        .into_iter()
        .find(|name| cwd.join(name).is_file())
        .map(str::to_owned)
}

/// The files whose change restarts the server: the config file and the env files next to it.
fn config_files(project: &Project) -> Watched {
    let dir =
        project.file.as_deref().and_then(Path::parent).map_or_else(|| project.cwd.clone(), Path::to_path_buf);
    let file = project.file.clone();
    Watched::new(dir, false, move |path: &Path| {
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        file.as_deref().is_some_and(|file| file == path) || name == ".env" || name.starts_with(".env.")
    })
}

fn policy_files(project: &Project) -> Option<Watched> {
    project.dir_given.then(|| Watched::new(project.policy_dir.clone(), true, |_: &Path| true))
}

struct Server {
    running: Running,
    config: Watched,
    policies: Option<Watched>,
    drift: Option<drift::Drift>,
}

impl Server {
    fn stop(self, runtime: &tokio::runtime::Runtime) -> Result<(), String> {
        if let Some(drift) = self.drift {
            drift.stop();
        }
        self.running.stop(runtime)
    }
}

fn launch(
    runtime: &tokio::runtime::Runtime,
    call: &Invocation,
    overrides: &[(String, String)],
    loaded: (Project, bool),
    port: u16,
) -> Option<Server> {
    let (project, generated) = loaded;
    match start(runtime, &project, port) {
        Ok((running, bound, token, active)) => {
            let schema = schema_file(&project.cwd);
            print(&banner(&project, bound, generated, token.as_deref(), active.as_ref(), schema.as_deref()));
            let config = config_files(&project);
            let policies = policy_files(&project);
            let target = (
                project.text("mongodb.uri").unwrap_or_default(),
                project.text("mongodb.database").unwrap_or_default(),
            );
            let drift = schema.map(|file| {
                let mut drift = drift::Drift::start(runtime, &project.cwd, &file, target, overrides);
                drift.poll(runtime, call, true);
                drift
            });
            Some(Server { running, config, policies, drift })
        }
        Err(message) => {
            let _ = error_line(format_args!("error  Canopy did not start: {message}"));
            None
        }
    }
}

fn reload_policies(
    call: &Invocation,
    server: &Server,
    overrides: &[(String, String)],
    session: &mut Session,
) {
    let Some((project, _)) = load(call, overrides, session) else {
        let _ = error_line(format_args!("error  policy reload rejected, keeping the previous policies"));
        return;
    };
    match project.bundle.policy_set() {
        Ok(set) if project.bundle.policies.is_some() => {
            let _ = server.running.updates.send(set);
        }
        Ok(_) => {
            let _ = error_line(format_args!(
                "error  policy reload rejected, keeping the previous policies: no policy folder at {}",
                project.policy_dir.display()
            ));
        }
        Err(message) => {
            let _ = error_line(format_args!(
                "error  policy reload rejected, keeping the previous policies: {message}"
            ));
        }
    }
}

fn configured_port(project: &Project) -> u16 {
    match project.resolution.value("server.port") {
        Some(Json::Number(port)) if (0.0..=65_535.0).contains(port) && port.fract() == 0.0 => {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let port = *port as u16;
            port
        }
        _ => 8080,
    }
}

fn serve(call: &Invocation, overrides: &[(String, String)], port: Option<u16>) -> Result<ExitCode, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("canopy-dev")
        .build()
        .map_err(|error| error.to_string())?;
    let (signal, stopped) = mpsc::channel::<()>();
    runtime.spawn(signals::wait(signal));
    let mut session = Session { keys: None };
    let Some((project, generated)) = load(call, overrides, &mut session) else {
        return Ok(ExitCode::FAILURE);
    };
    let requested = port.unwrap_or_else(|| configured_port(&project));
    let Some(mut server) = launch(&runtime, call, overrides, (project, generated), requested) else {
        return Ok(ExitCode::FAILURE);
    };
    loop {
        match stopped.recv_timeout(POLL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if server.running.task.is_finished() {
            if let Some(drift) = server.drift {
                drift.stop();
            }
            let running = server.running;
            let message = match runtime.block_on(running.task) {
                Ok(Ok(())) => "the server stopped".to_owned(),
                Ok(Err(message)) => message,
                Err(error) => error.to_string(),
            };
            error_line(format_args!("error  {message}"))?;
            return Ok(ExitCode::FAILURE);
        }
        if server.config.changed(SETTLE) {
            output(format_args!("Config changed, restarting"))?;
            let Some((project, generated)) = load(call, overrides, &mut session) else {
                error_line(format_args!("Keeping the running server until the config is fixed."))?;
                continue;
            };
            if let Err(message) = server.stop(&runtime) {
                error_line(format_args!("error  {message}"))?;
            }
            let next_port = port.unwrap_or_else(|| configured_port(&project));
            match launch(&runtime, call, overrides, (project, generated), next_port) {
                Some(next) => server = next,
                None => return Ok(ExitCode::FAILURE),
            }
            continue;
        }
        if server.policies.as_mut().is_some_and(|policies| policies.changed(SETTLE)) {
            reload_policies(call, &server, overrides, &mut session);
        }
        if let Some(drift) = server.drift.as_mut() {
            drift.poll(&runtime, call, false);
        }
    }
    server.stop(&runtime)?;
    runtime.shutdown_timeout(Duration::from_secs(2));
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::relative;
    use std::path::Path;

    #[test]
    fn relative_paths_walk_up_like_node() {
        let base = std::env::temp_dir();
        assert_eq!(relative(&base.join("a"), &base.join("a").join("b")), "b");
        assert_eq!(relative(&base.join("a"), &base.join("a")), "");
        let up = relative(&base.join("a").join("b"), &base.join("c"));
        assert_eq!(up, Path::new("..").join("..").join("c").to_string_lossy());
    }
}
