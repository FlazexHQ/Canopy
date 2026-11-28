//! Resolution of the canonical, unresolved config document that `canopy.js/emit` prints: environment
//! references, `.env` files, defaults, the well known `CANOPY_*` variables, the source of every value and
//! the masked text of `canopy config print`.

mod builtin;
mod cron;
mod normalize;
mod resolver;
mod spec;

use std::collections::HashMap;

use canopy_protocol::json::{Json, write_json};
use canopy_protocol::{CanopyError, ErrorCode};

pub use normalize::{database_from_uri, join_path};
use resolver::{Resolver, expand_auth, section};
use spec::{Kind, Spec};

/// The command a config is resolved for. It decides which unset variables are reported, and a config
/// function receives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Running the server.
    Start,
    /// `canopy dev`.
    Dev,
    /// The realtime sidecar.
    Realtime,
    /// Type generation and schema commands.
    Gen,
    /// The policy commands, and every command that only needs the meta database.
    Policies,
    /// `canopy doctor`.
    Doctor,
    /// `canopy config print`.
    Print,
}

impl Command {
    /// The name a config function receives.
    pub fn as_str(self) -> &'static str {
        match self {
            Command::Start => "start",
            Command::Dev => "dev",
            Command::Realtime => "realtime",
            Command::Gen => "gen",
            Command::Policies => "policies",
            Command::Doctor => "doctor",
            Command::Print => "print",
        }
    }

    /// Reads a command name.
    pub fn parse(name: &str) -> Option<Command> {
        Some(match name {
            "start" => Command::Start,
            "dev" => Command::Dev,
            "realtime" => Command::Realtime,
            "gen" => Command::Gen,
            "policies" => Command::Policies,
            "doctor" => Command::Doctor,
            "print" => Command::Print,
            _ => return None,
        })
    }

    fn needs(self, section: &str) -> bool {
        match self {
            Command::Start | Command::Dev | Command::Print => true,
            Command::Realtime => matches!(
                section,
                "mongodb"
                    | "environment"
                    | "auth"
                    | "keys"
                    | "policies"
                    | "realtime"
                    | "rateLimits"
                    | "cors"
                    | "server"
                    | "log"
                    | "dev"
                    | "collections"
            ),
            Command::Gen => {
                matches!(section, "mongodb" | "policies" | "collections" | "types" | "environment")
            }
            Command::Policies => matches!(section, "policies" | "environment"),
            Command::Doctor => matches!(
                section,
                "mongodb" | "auth" | "policies" | "realtime" | "environment" | "publicUrl" | "cors"
            ),
        }
    }
}

/// Where a resolved value came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A default.
    Default,
    /// The config file.
    File,
    /// An environment variable.
    Env {
        /// The variable.
        name: String,
        /// The env file it was read from, or `None` for the process environment.
        env_file: Option<String>,
    },
}

/// One reason a config does not validate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// The dotted setting path, for example `mongodb.uri`.
    pub path: String,
    /// What is wrong and how to fix it.
    pub message: String,
    /// True when only an unset variable is missing; commands that do not need the section ignore it.
    pub missing: bool,
}

/// What a resolution reads besides the document.
#[derive(Debug, Clone)]
pub struct ResolveOptions {
    /// The variables, after env files were merged in (the process environment wins).
    pub env: HashMap<String, String>,
    /// For variables that came from an env file: the file.
    pub env_files: HashMap<String, String>,
    /// The config file, or `None` in zero config mode.
    pub file: Option<String>,
    /// The directory paths in the config file are relative to.
    pub base_dir: String,
    /// The working directory, which paths from variables are relative to.
    pub cwd: String,
    /// The command the config is resolved for.
    pub command: Command,
}

/// A resolved config with the source of every value.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// The resolved settings, in the field order of the TypeScript resolver.
    pub config: Json,
    /// The source of each dotted path, in the order they were recorded.
    pub sources: Vec<(String, Source)>,
    /// Paths whose values must never be printed.
    pub secrets: Vec<String>,
}

impl Resolution {
    /// The value at a dotted path of the resolved config.
    pub fn value(&self, path: &str) -> Option<&Json> {
        let Json::Object(root) = &self.config else { return None };
        resolver::get(root, path)
    }

    /// The text at a dotted path of the resolved config.
    pub fn text(&self, path: &str) -> Option<&str> {
        match self.value(path) {
            Some(Json::String(text)) => Some(text),
            _ => None,
        }
    }

    /// The source recorded for a dotted path.
    pub fn source(&self, path: &str) -> Option<&Source> {
        self.sources.iter().find(|(key, _)| key == path).map(|(_, source)| source)
    }
}

/// Why a config cannot be used: every problem at once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    /// The config file, or `None` when only the environment configured Canopy.
    pub file: Option<String>,
    /// The problems, in the order they were found.
    pub problems: Vec<Problem>,
}

impl ConfigError {
    /// The message the CLI prints, listing every problem.
    pub fn message(&self) -> String {
        let place = self.file.as_deref().unwrap_or("the environment");
        let count = if self.problems.len() == 1 {
            "1 problem".to_owned()
        } else {
            format!("{} problems", self.problems.len())
        };
        let body = self
            .problems
            .iter()
            .map(|problem| {
                let message = problem
                    .message
                    .split('\n')
                    .map(|line| format!("    {line}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("  {}\n{message}", problem.path)
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!(
            "canopy: {place} has {count}\n\n{body}\n\nRun canopy config print --sources to see the resolved values and where they came from."
        )
    }

    /// The error with the `CANOPY_CONFIG_INVALID` code.
    pub fn to_error(&self) -> CanopyError {
        CanopyError::named(ErrorCode::ConfigInvalid, "ConfigError", self.message())
    }
}

/// A canonical config document that does not follow its schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentError {
    /// The JSON Pointer of the offending value.
    pub path: String,
    /// What is wrong.
    pub message: String,
}

impl DocumentError {
    /// The error with the `CANOPY_CONFIG_INVALID` code and the pointer in its message.
    pub fn to_error(&self) -> CanopyError {
        CanopyError::named(
            ErrorCode::ConfigInvalid,
            "ConfigError",
            format!("{}: {}", self.path, self.message),
        )
    }
}

/// Why a document could not be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// The document does not follow the canonical schema.
    Document(DocumentError),
    /// The settings do not validate.
    Config(ConfigError),
}

impl ResolveError {
    /// The message the CLI prints.
    pub fn message(&self) -> String {
        match self {
            ResolveError::Document(error) => format!("{}: {}", error.path, error.message),
            ResolveError::Config(error) => error.message(),
        }
    }
}

/// An environment reference of the canonical document: `{"$env": {name, type, secret, optional, default}}`.
pub(crate) struct EnvReference {
    pub(crate) name: String,
    pub(crate) secret: bool,
    pub(crate) optional: bool,
    pub(crate) default: Option<Json>,
}

impl EnvReference {
    pub(crate) fn read(value: &Json) -> Option<EnvReference> {
        let Json::Object(fields) = value else { return None };
        let [(key, payload)] = fields.as_slice() else { return None };
        if key != "$env" {
            return None;
        }
        let Some(Json::String(name)) = payload.get("name") else { return None };
        Some(EnvReference {
            name: name.clone(),
            secret: payload.get("secret") == Some(&Json::Bool(true)),
            optional: payload.get("optional") == Some(&Json::Bool(true)),
            default: payload.get("default").cloned(),
        })
    }
}

/// Escapes one JSON Pointer token.
pub fn pointer_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// The JSON Pointer of a dotted setting path inside the canonical document.
pub fn pointer(path: &str) -> String {
    let tokens: Vec<String> = path.split('.').map(pointer_token).collect();
    format!("/config/{}", tokens.join("/"))
}

fn variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn check_reference(payload: &Json, path: &str) -> Result<(), DocumentError> {
    let invalid = |message: &str| Err(DocumentError { path: path.to_owned(), message: message.to_owned() });
    let Json::Object(fields) = payload else { return invalid("An environment reference needs a document") };
    for (key, _) in fields {
        if !matches!(key.as_str(), "name" | "type" | "secret" | "optional" | "default") {
            return Err(DocumentError {
                path: format!("{path}/{}", pointer_token(key)),
                message: "Unknown environment reference field".to_owned(),
            });
        }
    }
    if !matches!(payload.get("name"), Some(Json::String(name)) if variable_name(name)) {
        return invalid("An environment reference needs a valid variable name");
    }
    if !matches!(payload.get("type"), Some(Json::String(kind)) if matches!(kind.as_str(), "string" | "int" | "bool" | "list" | "url" | "duration"))
    {
        return invalid("An environment reference needs a type: string, int, bool, list, url or duration");
    }
    let secret = payload.get("secret");
    let optional = payload.get("optional");
    if !matches!(secret, Some(Json::Bool(_))) || !matches!(optional, Some(Json::Bool(_))) {
        return invalid("An environment reference needs boolean secret and optional fields");
    }
    if payload.get("default").is_some()
        && (secret == Some(&Json::Bool(true)) || optional == Some(&Json::Bool(true)))
    {
        return invalid("Secret and optional environment references take no default");
    }
    Ok(())
}

fn check_references(value: &Json, path: &str) -> Result<(), DocumentError> {
    match value {
        Json::Object(fields) => {
            if let Some((_, payload)) = fields.iter().find(|(key, _)| key == "$env") {
                if fields.len() != 1 {
                    return Err(DocumentError {
                        path: path.to_owned(),
                        message: "An environment reference holds only $env".to_owned(),
                    });
                }
                return check_reference(payload, &format!("{path}/$env"));
            }
            if let [(key, _)] = fields.as_slice()
                && key == "$ejson"
            {
                return Ok(());
            }
            fields
                .iter()
                .try_for_each(|(key, item)| check_references(item, &format!("{path}/{}", pointer_token(key))))
        }
        Json::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(index, item)| check_references(item, &format!("{path}/{index}"))),
        _ => Ok(()),
    }
}

/// Checks a canonical version 1 config document and returns its `config` object.
pub fn read_document(document: &Json) -> Result<&Json, DocumentError> {
    let Json::Object(fields) = document else {
        return Err(DocumentError { path: String::new(), message: "Expected a config document".to_owned() });
    };
    for (key, _) in fields {
        if !matches!(key.as_str(), "version" | "config") {
            return Err(DocumentError {
                path: format!("/{}", pointer_token(key)),
                message: "Unknown config document field".to_owned(),
            });
        }
    }
    if document.get("version") != Some(&Json::Number(1.0)) {
        return Err(DocumentError {
            path: "/version".to_owned(),
            message: "Expected config document version 1".to_owned(),
        });
    }
    let config = document.get("config").unwrap_or(&Json::Null);
    if !matches!(config, Json::Object(_)) {
        return Err(DocumentError {
            path: "/config".to_owned(),
            message: "Expected a config object".to_owned(),
        });
    }
    check_references(config, "/config")?;
    Ok(config)
}

/// Validates a canonical config document and the environment, and applies every default. A variable fills
/// a setting the file leaves out, and a variable that contradicts the file is an error.
pub fn resolve_config(document: &Json, options: &ResolveOptions) -> Result<Resolution, ResolveError> {
    let input = read_document(document).map_err(ResolveError::Document)?;
    let mut resolver = Resolver::new(options);
    let root = Spec::of(Kind::Object(spec::root_fields()));
    let mut tree = match resolver.walk(&root, input, "") {
        Some(Json::Object(tree)) => tree,
        _ => Vec::new(),
    };
    expand_auth(&mut resolver, &mut tree);
    for (name, path, spec) in spec::well_known() {
        resolver.overlay(&mut tree, name, path, &spec);
    }
    let config = normalize::normalize(&mut resolver, &mut tree, options);
    let problems: Vec<Problem> = resolver
        .problems
        .into_iter()
        .filter(|problem| !problem.missing || options.command.needs(section(&problem.path)))
        .collect();
    if !problems.is_empty() {
        return Err(ResolveError::Config(ConfigError { file: options.file.clone(), problems }));
    }
    Ok(Resolution { config, sources: resolver.sources, secrets: resolver.secrets })
}

/// Masks the password of a MongoDB connection string.
pub fn redact_uri(uri: &str) -> String {
    let scheme = ["mongodb://", "mongodb+srv://"].into_iter().find(|scheme| uri.starts_with(scheme));
    let Some((scheme, rest)) = scheme.and_then(|scheme| uri.strip_prefix(scheme).map(|rest| (scheme, rest)))
    else {
        return uri.to_owned();
    };
    let Some((user, after)) = rest.split_once(':') else { return uri.to_owned() };
    if user.is_empty() || user.contains(['/', '@']) {
        return uri.to_owned();
    }
    let Some((_, host)) = after.split_once('@') else { return uri.to_owned() };
    format!("{scheme}{user}:••••@{host}")
}

fn source_label(resolution: &Resolution, path: &str) -> String {
    let candidates = [
        Some(path.to_owned()),
        path.strip_suffix("Ms").map(str::to_owned),
        path.strip_suffix("Seconds").map(str::to_owned),
        (path == "rest.mutationTtlMs").then(|| "rest.mutationTtl".to_owned()),
    ];
    let source = candidates.into_iter().flatten().find_map(|candidate| resolution.source(&candidate));
    match source {
        Some(Source::Env { name, env_file: None }) => format!("env {name}"),
        Some(Source::Env { name, env_file: Some(file) }) => format!("{name} from {file}"),
        Some(Source::File) => "config file".to_owned(),
        _ => "default".to_owned(),
    }
}

/// Renders a resolved config for `canopy config print`: one `path = value` line per setting, secrets
/// masked, and with `sources` the origin of each value.
pub fn format_config(resolution: &Resolution, sources: bool) -> String {
    let mut lines = Vec::new();
    visit(resolution, &resolution.config, "", sources, &mut lines);
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn visit(resolution: &Resolution, value: &Json, path: &str, sources: bool, lines: &mut Vec<String>) {
    let join = |key: &str| if path.is_empty() { key.to_owned() } else { format!("{path}.{key}") };
    match value {
        Json::Array(items)
            if !items.is_empty() && items.iter().all(|item| matches!(item, Json::Object(_))) =>
        {
            for (index, item) in items.iter().enumerate() {
                visit(resolution, item, &format!("{path}.{index}"), sources, lines);
            }
            return;
        }
        Json::Object(entries) if path != "auth.jwks" => {
            if entries.is_empty() && !path.is_empty() {
                lines.push(format!("{path} = {{}}"));
            }
            for (key, item) in entries {
                visit(resolution, item, &join(key), sources, lines);
            }
            return;
        }
        _ => {}
    }
    if path == "file" {
        return;
    }
    let secret = resolution.secrets.iter().any(|secret| {
        path == secret || path.strip_prefix(secret.as_str()).is_some_and(|rest| rest.starts_with('.'))
    });
    let shown = if secret {
        match value {
            Json::Array(items) => {
                format!("[{}]", items.iter().map(|_| "\"••••\"").collect::<Vec<_>>().join(", "))
            }
            _ => "\"••••\"".to_owned(),
        }
    } else if let (true, Json::String(uri)) = (path == "mongodb.uri", value) {
        resolver::quote(&redact_uri(uri))
    } else {
        let mut out = String::new();
        write_json(&mut out, value);
        out
    };
    let line = format!("{path} = {shown}");
    if sources {
        lines.push(format!("{line}  ({})", source_label(resolution, path)));
    } else {
        lines.push(line);
    }
}

/// Parses an env file: `KEY=value` lines, optional `export`, quotes and `#` comments. CRLF is accepted.
pub fn parse_env_file(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map_or(line, str::trim_start);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim_end();
        if !variable_name(key) {
            continue;
        }
        let value = value.trim_start();
        let mut chars = value.char_indices();
        let quote = value.chars().next().filter(|first| matches!(first, '"' | '\''));
        let mut close = None;
        if let Some(quote) = quote {
            chars.next();
            let mut escaped = false;
            for (index, ch) in chars {
                if escaped {
                    escaped = false;
                } else if quote == '"' && ch == '\\' {
                    escaped = true;
                } else if ch == quote {
                    close = Some(index);
                    break;
                }
            }
        }
        let value = match (quote, close) {
            (Some(quote), Some(close)) => {
                let inner = value.get(1..close).unwrap_or_default();
                if quote == '"' { inner.replace("\\n", "\n").replace("\\\"", "\"") } else { inner.to_owned() }
            }
            _ => {
                let mut cut = value.len();
                let mut previous: Option<(usize, char)> = None;
                for (index, ch) in value.char_indices() {
                    if ch == '#'
                        && let Some((start, before)) = previous
                        && before.is_whitespace()
                    {
                        cut = start;
                        break;
                    }
                    previous = Some((index, ch));
                }
                value.get(..cut).unwrap_or(value).trim().to_owned()
            }
        };
        match out.iter_mut().find(|(name, _)| name == key) {
            Some((_, slot)) => *slot = value,
            None => out.push((key.to_owned(), value)),
        }
    }
    out
}
