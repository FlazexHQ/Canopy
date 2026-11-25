use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};

use canopy_config::authoring::{Command, Resolution, ResolveError, ResolveOptions, resolve_config};
use canopy_protocol::json::{Json, parse_json};

use crate::bundle::Bundle;
use crate::invocation::Invocation;

const NAMES: &[&str] = &["canopy.config.ts", "canopy.config.mts", "canopy.config.js", "canopy.config.mjs"];

/// Why a project could not be loaded.
pub(crate) enum LoadError {
    /// A message printed as it is.
    Message(String),
    /// An unexpected failure: printed with the `--debug` hint.
    Unexpected(String),
    /// A part of the bundle is invalid. `part` is `config`, `policies`, `tests` or `schema`.
    Invalid { part: String, message: String },
}

impl LoadError {
    /// The text printed on standard error, without the trailing newline.
    pub(crate) fn text(&self, debug: bool) -> String {
        match self {
            LoadError::Message(message) => message.clone(),
            LoadError::Unexpected(message) => crate::storage_error(message.clone(), debug),
            LoadError::Invalid { part, message } if part == "policies" || part == "tests" => {
                format!("error  {message}")
            }
            LoadError::Invalid { message, .. } => message.clone(),
        }
    }
}

/// A loaded project: the emitted bundle and the config resolved from it.
pub(crate) struct Project {
    pub(crate) cwd: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) mode: &'static str,
    pub(crate) command: Command,
    pub(crate) file: Option<PathBuf>,
    pub(crate) bundle: Bundle,
    pub(crate) resolution: Resolution,
    /// The policy directory: `--dir`, else `policies.dir` of the config, else `canopy/policies`.
    pub(crate) policy_dir: PathBuf,
}

impl Project {
    /// A setting of the resolved config.
    pub(crate) fn text(&self, path: &str) -> Option<&str> {
        self.resolution.text(path).filter(|text| !text.is_empty())
    }
}

/// The variables a command reads: the process environment, with `CANOPY_ENV` set by `--env production` or
/// `--env development`.
pub(crate) fn environment(call: &Invocation) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    if let Some(name @ ("production" | "development")) = call.text("env") {
        env.insert("CANOPY_ENV".to_owned(), name.to_owned());
    }
    env
}

/// Finds `canopy.config.{ts,mts,js,mjs}` or `canopy/canopy.config.*`, walking up from `cwd`.
pub(crate) fn find_config(cwd: &Path) -> Option<PathBuf> {
    let mut dir = Some(cwd);
    while let Some(current) = dir {
        for base in [current.to_path_buf(), current.join("canopy")] {
            for name in NAMES {
                let candidate = base.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        dir = current.parent();
    }
    None
}

/// Resolves a path against a directory and normalizes it, as `path.resolve` does: `.` segments are dropped
/// and `..` segments remove their parent.
pub(crate) fn absolute(base: &Path, path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in base.join(path).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn loader() -> String {
    std::env::current_exe().map_or_else(|_| "canopy".to_owned(), |path| display(&path))
}

/// Loads the project of a command: finds the config, emits the bundle (or reads `--bundle`), checks it and
/// resolves the config for `command`.
pub(crate) fn load(call: &Invocation, command: Command, needs_policies: bool) -> Result<Project, LoadError> {
    load_with(call, command, command, needs_policies)
}

/// Loads the project, evaluating the config function for `emit_as` and resolving it for `command`.
pub(crate) fn load_with(
    call: &Invocation,
    command: Command,
    emit_as: Command,
    needs_policies: bool,
) -> Result<Project, LoadError> {
    let cwd = std::env::current_dir().map_err(|error| LoadError::Unexpected(error.to_string()))?;
    let env = environment(call);
    let file = match call.text("config") {
        Some(file) => {
            let path = absolute(&cwd, file);
            if !path.is_file() {
                return Err(LoadError::Unexpected(format!(
                    "Cannot find module '{}' imported from {}",
                    display(&path),
                    loader()
                )));
            }
            Some(path)
        }
        None => find_config(&cwd),
    };
    let dir_flag = call.text("dir").map(|dir| absolute(&cwd, dir));
    let mode = if env.get("CANOPY_ENV").map(String::as_str) == Some("production") {
        "production"
    } else {
        "development"
    };
    let root = file
        .as_deref()
        .and_then(Path::parent)
        .map(|parent| {
            if parent.file_name().is_some_and(|name| name == "canopy") {
                parent.parent().unwrap_or(parent)
            } else {
                parent
            }
        })
        .map_or_else(|| cwd.clone(), Path::to_path_buf);
    let emit = |policies: Option<&Path>| -> Result<Bundle, LoadError> {
        match call.text("bundle") {
            Some(path) => read_bundle(&absolute(&cwd, path)),
            None => emit(&Emit {
                root: &root,
                file: file.as_deref(),
                policies,
                mode,
                command: emit_as,
                env: &env,
            }),
        }
    };
    let mut bundle = if file.is_none() && dir_flag.is_none() && call.text("bundle").is_none() {
        Bundle::empty(mode, emit_as)
    } else {
        emit(dir_flag.as_deref())?
    };
    let resolution = resolve(&bundle, &env, file.as_deref(), &cwd, command)?;
    let policy_dir = dir_flag.unwrap_or_else(|| match resolution.text("policies.dir") {
        Some(dir) => PathBuf::from(dir),
        None => cwd.join("canopy").join("policies"),
    });
    let emitted_dir = bundle.files_policies.as_ref().map(|dir| root.join(dir));
    if needs_policies
        && call.text("bundle").is_none()
        && emitted_dir.as_deref().map(normalized) != Some(normalized(&policy_dir))
    {
        bundle = emit(Some(&policy_dir))?;
    }
    Ok(Project { cwd, root, mode, command: emit_as, file, bundle, resolution, policy_dir })
}

fn normalized(path: &Path) -> PathBuf {
    path.components().collect()
}

/// Resolves the config of a bundle with the process environment.
fn resolve(
    bundle: &Bundle,
    env: &HashMap<String, String>,
    file: Option<&Path>,
    cwd: &Path,
    command: Command,
) -> Result<Resolution, LoadError> {
    let base_dir = file.and_then(Path::parent).unwrap_or(cwd);
    let options = ResolveOptions {
        env: env.clone(),
        env_files: HashMap::new(),
        file: file.map(display),
        base_dir: display(base_dir),
        cwd: display(cwd),
        command,
    };
    let empty = Json::Object(vec![
        ("version".to_owned(), Json::Number(1.0)),
        ("config".to_owned(), Json::Object(Vec::new())),
    ]);
    resolve_config(bundle.config.as_ref().unwrap_or(&empty), &options).map_err(|error| match error {
        ResolveError::Config(error) => LoadError::Message(error.message()),
        ResolveError::Document(error) => LoadError::Invalid {
            part: "config".to_owned(),
            message: format!("{}: {}", error.path, error.message),
        },
    })
}

/// Reads a bundle file written by `canopy build`.
pub(crate) fn read_bundle(path: &Path) -> Result<Bundle, LoadError> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        LoadError::Message(format!("Could not read the bundle {}: {error}", display(path)))
    })?;
    let json = parse_json(text.trim_start_matches('\u{feff}'))
        .map_err(|error| LoadError::Message(format!("{} is not JSON: {}", display(path), error.message())))?;
    Bundle::parse(&json)
}

struct Emit<'a> {
    root: &'a Path,
    file: Option<&'a Path>,
    policies: Option<&'a Path>,
    mode: &'a str,
    command: Command,
    env: &'a HashMap<String, String>,
}

/// A JavaScript runtime that can run the emitter.
struct Runtime {
    program: PathBuf,
    kind: &'static str,
}

fn program_names(name: &str) -> Vec<OsString> {
    if !cfg!(windows) {
        return vec![OsString::from(name)];
    }
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
    extensions
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(|extension| OsString::from(format!("{name}{}", extension.to_ascii_lowercase())))
        .collect()
}

/// Finds a program on `PATH`, trying each `PATHEXT` extension on Windows so `.cmd` shims are found too.
fn which(name: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    let path = env.get("PATH").or_else(|| env.get("Path")).cloned()?;
    let names = program_names(name);
    std::env::split_paths(&path).find_map(|dir| {
        names.iter().map(|candidate| dir.join(candidate)).find(|candidate| candidate.is_file())
    })
}

fn node_major(program: &Path) -> Option<u32> {
    let output = Process::new(program).arg("--version").stdin(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().strip_prefix('v')?.split('.').next()?.parse().ok()
}

/// Detects the runtime in the order Bun, Node 24 or later, Deno. `CANOPY_RUNTIME` picks one by name.
fn runtime(env: &HashMap<String, String>) -> Result<Runtime, LoadError> {
    let wanted = env.get("CANOPY_RUNTIME").map(String::as_str).filter(|name| !name.is_empty());
    if let Some(name) = wanted
        && !matches!(name, "bun" | "node" | "deno")
    {
        return Err(LoadError::Message(format!("CANOPY_RUNTIME is {name:?}; use bun, node or deno.")));
    }
    for kind in ["bun", "node", "deno"] {
        if wanted.is_some_and(|name| name != kind) {
            continue;
        }
        let Some(program) = which(kind, env) else { continue };
        if kind == "node" && node_major(&program).is_none_or(|major| major < 24) {
            continue;
        }
        return Ok(Runtime { program, kind });
    }
    Err(LoadError::Message(
        "No JavaScript runtime to load the project: install Bun, Node.js 24 or later, or Deno, or pass --bundle <file> from canopy build."
            .to_owned(),
    ))
}

fn export_target(value: &Json) -> Option<String> {
    match value {
        Json::String(path) => Some(path.clone()),
        Json::Object(conditions) => ["import", "node", "default"]
            .iter()
            .find_map(|condition| conditions.iter().find(|(key, _)| key == condition))
            .and_then(|(_, target)| export_target(target)),
        _ => None,
    }
}

/// The emitter module: `CANOPY_EMITTER`, else `exports["./emit/cli"]` of the nearest installed `canopy.js`.
fn emitter(root: &Path, env: &HashMap<String, String>) -> Result<PathBuf, LoadError> {
    if let Some(path) = env.get("CANOPY_EMITTER").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let mut dir = Some(root);
    while let Some(current) = dir {
        let package = current.join("node_modules").join("canopy.js");
        if let Ok(text) = std::fs::read_to_string(package.join("package.json")) {
            let target = parse_json(&text)
                .ok()
                .and_then(|json| json.get("exports").and_then(|exports| exports.get("./emit/cli")).cloned())
                .and_then(|target| export_target(&target));
            return match target {
                Some(target) => Ok(package.join(target.trim_start_matches("./"))),
                None => Err(LoadError::Message(format!(
                    "The canopy.js installed in {} has no emitter (canopy.js/emit/cli); update canopy.js.",
                    display(current)
                ))),
            };
        }
        dir = current.parent();
    }
    Err(LoadError::Message(format!(
        "canopy.js is not installed in {}: add it with your package manager (for example bun add canopy.js), or pass --bundle <file> from canopy build.",
        display(root)
    )))
}

fn last_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|line| !line.is_empty())
}

fn emit(request: &Emit<'_>) -> Result<Bundle, LoadError> {
    let module = emitter(request.root, request.env)?;
    let runtime = runtime(request.env)?;
    let mut process = Process::new(&runtime.program);
    if runtime.kind == "deno" {
        process.args(["run", "--allow-read", "--allow-env"]);
    }
    process.arg(&module);
    process.arg("--root").arg(request.root);
    if let Some(file) = request.file {
        process.arg("--config").arg(file);
    }
    if let Some(policies) = request.policies {
        process.arg("--policies").arg(policies);
    }
    process.args(["--mode", request.mode, "--command", request.command.as_str()]);
    process.current_dir(request.root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if runtime.kind == "node" {
        process.env("NODE_NO_WARNINGS", "1");
    }
    let output = process.output().map_err(|error| {
        LoadError::Unexpected(format!("Could not start {}: {error}", display(&runtime.program)))
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        let line = last_line(&stdout)
            .ok_or_else(|| LoadError::Unexpected("The emitter printed no bundle".to_owned()))?;
        let json = parse_json(line).map_err(|error| {
            LoadError::Unexpected(format!("The emitter printed invalid JSON: {}", error.message()))
        })?;
        return Bundle::parse(&json);
    }
    let reported =
        last_line(&stderr).and_then(|line| parse_json(line).ok()).and_then(|json| json.get("error").cloned());
    let Some(error) = reported else {
        let text = stderr.trim();
        return Err(LoadError::Unexpected(if text.is_empty() {
            format!("The emitter stopped with {}", output.status)
        } else {
            text.to_owned()
        }));
    };
    let text = |key: &str| match error.get(key) {
        Some(Json::String(text)) => Some(text.clone()),
        _ => None,
    };
    let message = text("message").unwrap_or_else(|| "The project could not be loaded".to_owned());
    match text("part") {
        Some(part) if output.status.code() == Some(1) => {
            let path = text("path").filter(|path| !path.is_empty());
            let message = match (part.as_str(), path) {
                ("config", Some(path)) if !message.starts_with(&path) => format!("{path}: {message}"),
                _ => message,
            };
            Err(LoadError::Invalid { part, message })
        }
        _ => Err(LoadError::Unexpected(message)),
    }
}

/// Loads the project for a command that reads the database: like the TypeScript CLI, an explicit
/// `--mongodb-uri` or `--env` loads it as the policy commands do, so an unset app variable is not reported.
pub(crate) fn configure(
    call: &Invocation,
    load_as: Command,
    needs_policies: bool,
) -> Result<Project, LoadError> {
    let command = if (call.text("mongodb-uri").is_some() || call.has_flag("env")) && load_as != Command::Print
    {
        Command::Policies
    } else {
        load_as
    };
    load(call, command, needs_policies)
}

/// Emits the policies of another folder of the project, as `policies pull` does to check what it wrote.
pub(crate) fn emit_policies(
    call: &Invocation,
    project: &Project,
    dir: &Path,
) -> Result<canopy_policy::PolicySet, LoadError> {
    let env = environment(call);
    let bundle = emit(&Emit {
        root: &project.root,
        file: project.file.as_deref(),
        policies: Some(dir),
        mode: project.mode,
        command: project.command,
        env: &env,
    })?;
    bundle.policy_set().map_err(LoadError::Unexpected)
}
