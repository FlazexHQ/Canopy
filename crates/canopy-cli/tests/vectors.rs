//! Replays the covered TypeScript CLI conformance vectors against the built binary.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;

const TOKEN_ID: &str = "fixture-token-id";
const TOKEN_PREFIX: &str = "canopy_pat_abcdef";
const ADMIN_TOKEN: &str = "canopy_pat_abcdef0123456789012345678901234567890123456";
const COVERED: [&str; 15] = [
    "help",
    "version",
    "no-command",
    "unknown-command",
    "unknown-flag",
    "login-help",
    "logout-help",
    "login-refused",
    "logout-refused",
    "dev-bad-port",
    "login-token-refused",
    "auth-import",
    "admin-token-create",
    "admin-token-list",
    "admin-token-revoke",
];

#[derive(Deserialize)]
struct Vectors {
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    id: String,
    cwd: String,
    args: Vec<String>,
    env: BTreeMap<String, Option<String>>,
    stdin: String,
    stdout: String,
    stderr: String,
    exit_code: i32,
    files: BTreeMap<String, Change>,
    file_input: Option<FileInput>,
}

#[derive(Deserialize)]
struct FileInput {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Change {
    before: Option<String>,
    after: Option<String>,
}

#[test]
fn refuses_http_for_non_localhost_before_sending_credentials() -> Result<(), Box<dyn std::error::Error>> {
    let url = "http://localhost.example.test/project";
    for args in [vec!["login", url], vec!["admin", "tokens", "list", "--env", "development"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_canopy"))
            .args(&args)
            .env("CANOPY_ADMIN_URL", url)
            .env("CANOPY_ADMIN_TOKEN", "do-not-send")
            .output()?;
        let prefix = if args[0] == "admin" { "--env development: " } else { "" };
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr)?,
            format!("{prefix}Admin tokens are only sent over HTTPS (http is allowed for localhost).\n")
        );
    }
    Ok(())
}

#[test]
fn login_registers_an_environment_and_logout_removes_the_token() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let credentials = directory.path().join("credentials.json");
    let environments = directory.path().join("environments.json");
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let url = format!("http://{}", listener.local_addr()?);
    let server = thread::spawn(move || {
        let mut commands = exchanges("admin-token-list").into_iter();
        let Some(identity) = commands.next() else {
            return Err(io::Error::other("missing identity exchange"));
        };
        serve(&listener, "fixture-session", identity)?;
        for exchange in exchanges("admin-token-list") {
            serve(&listener, "fixture-session", exchange)?;
        }
        Ok::<(), io::Error>(())
    });
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_canopy"))
            .args(args)
            .env_remove("CANOPY_ADMIN_URL")
            .env_remove("CANOPY_ADMIN_TOKEN")
            .env("CANOPY_CREDENTIALS", &credentials)
            .env("CANOPY_ENVIRONMENTS", &environments)
            .output()
    };
    let login = run(&["login", &format!("{url}/"), "--env", "fixture", "--token", " fixture-session "])?;
    assert_eq!(login.status.code(), Some(0), "{}", String::from_utf8_lossy(&login.stderr));
    assert!(login.stderr.is_empty());
    let protection = if cfg!(windows) { "in your Windows user profile, not encrypted" } else { "mode 0600" };
    assert_eq!(
        String::from_utf8(login.stdout)?,
        format!(
            "Logged in to {url} as remote@example.test (admin, development); no keychain was available, so the token is in the credentials file ({protection}).\n\
         --env fixture now selects {url} for canopy policies and canopy admin tokens.\n"
        )
    );
    assert_eq!(fs::read_to_string(&environments)?, format!("{{\n  \"fixture\": \"{url}\"\n}}\n"));
    let list = run(&["admin", "tokens", "list", "--env", "fixture"])?;
    assert_eq!(list.status.code(), Some(0), "{}", String::from_utf8_lossy(&list.stderr));
    assert_eq!(
        String::from_utf8(list.stdout)?,
        format!(
            "env fixture: {url} as remote@example.test (admin)\n{TOKEN_ID}  {TOKEN_PREFIX}...  admin      \"fixture\"  expires never  last used never  active\n"
        )
    );
    server.join().map_err(|_| io::Error::other("admin fixture thread failed"))??;
    let logout = run(&["logout", &url])?;
    assert_eq!(logout.status.code(), Some(0), "{}", String::from_utf8_lossy(&logout.stderr));
    assert_eq!(String::from_utf8(logout.stdout)?, format!("Logged out of {url}.\n"));
    assert_eq!(fs::read_to_string(&credentials)?, "{}\n");
    let list = run(&["admin", "tokens", "list", "--env", "fixture"])?;
    assert_eq!(list.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(list.stderr)?,
        format!(
            "No admin token for {url}: run canopy login {url} --env fixture, or set CANOPY_ADMIN_TOKEN.\n"
        )
    );
    Ok(())
}

/// The lines the Rust usage text adds to the recorded TypeScript one: each is inserted right after its anchor
/// line, and every recorded line stays as it was. The additions are the commands and options the TypeScript CLI
/// does not have (`build`, `--bundle` and the `--out` description for `build`). Every other
/// difference fails the replay.
const USAGE_ADDITIONS: &[(&str, &[&str])] = &[
    (
        "  config print           Print the resolved config with secrets masked",
        &[
            "  build                  Write the project's bundle (config, policies, tests, schema) for deployments",
            "                         that publish without a JavaScript runtime",
        ],
    ),
    (
        "  --database <name>      App database (default: the config, else $CANOPY_DB or the URI path)",
        &[
            "  --bundle <file>        Read the project from a bundle written by canopy build instead of running the config",
        ],
    ),
    (
        "  --out <file>           pull: schema file to write (default: canopy.schema.ts, or canopy.schema.js with --js)",
        &["                         build: the bundle (default canopy.bundle.json)"],
    ),
];

/// A recorded output with the usage additions applied when it contains the usage text.
fn with_usage_additions(recorded: &str) -> String {
    if !recorded.contains("Usage: canopy <command> [options]") {
        return recorded.to_owned();
    }
    let mut out = String::new();
    let mut applied = 0;
    for line in recorded.split_inclusive('\n') {
        out.push_str(line);
        if let Some((_, added)) =
            USAGE_ADDITIONS.iter().find(|(anchor, _)| line.trim_end_matches('\n') == *anchor)
        {
            applied += 1;
            for addition in *added {
                out.push_str(addition);
                out.push('\n');
            }
        }
    }
    assert_eq!(applied, USAGE_ADDITIONS.len(), "every anchor of the usage additions is a recorded line");
    out
}

#[test]
fn the_usage_additions_only_insert_lines() {
    let recorded = include_str!("../../../conformance/cli/vectors.json");
    let vectors: Vectors = serde_json::from_str(recorded).expect("vectors");
    let help = vectors.steps.iter().find(|step| step.id == "help").expect("help step");
    let expanded = with_usage_additions(&help.stdout);
    let added: usize = USAGE_ADDITIONS.iter().map(|(_, lines)| lines.len()).sum();
    assert_eq!(expanded.lines().count(), help.stdout.lines().count() + added);
    let kept: Vec<&str> = expanded
        .lines()
        .filter(|line| !USAGE_ADDITIONS.iter().any(|(_, lines)| lines.contains(line)))
        .collect();
    assert_eq!(kept, help.stdout.lines().collect::<Vec<_>>());
}

#[test]
fn cli_vectors() -> Result<(), Box<dyn std::error::Error>> {
    let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cli");
    let vectors: Vectors = serde_json::from_slice(&fs::read(oracle.join("vectors.json"))?)?;
    assert_eq!(vectors.steps.len(), 61);
    let mut covered = BTreeSet::new();
    for step in &vectors.steps {
        if COVERED.contains(&step.id.as_str()) {
            replay(&oracle.join("fixture"), step)?;
            assert!(covered.insert(step.id.as_str()), "duplicate step {}", step.id);
        } else {
            eprintln!("pending: {} ({})", step.id, step.args.join(" "));
        }
    }
    assert_eq!(covered.len(), COVERED.len());
    Ok(())
}

fn replay(fixture: &Path, step: &Step) -> Result<(), Box<dyn std::error::Error>> {
    let project = tempfile::tempdir()?;
    let project = project.path();
    copy_fixture(fixture, project)?;
    if let Some(input) = &step.file_input {
        fs::write(project.join(&input.path), &input.content)?;
    }
    let before = snapshot(project)?;
    let exchanges = exchanges(&step.id);
    let listener = (!exchanges.is_empty()).then(|| TcpListener::bind(("127.0.0.1", 0))).transpose()?;
    let admin_url = listener
        .as_ref()
        .map(|listener| listener.local_addr())
        .transpose()?
        .map(|address| format!("http://{address}"));
    let expand = |text: &str| match &admin_url {
        Some(url) => text.replace("<admin-url>", url).replace("<admin-token-id>", TOKEN_ID),
        None => text.to_owned(),
    };
    let resolved = fs::canonicalize(project)?.to_string_lossy().replace('\\', "/");
    let normalize = |text: &str| {
        let text = text.replace("\r\n", "\n").replace('\\', "/");
        let text = text
            .replace(&resolved, "<project>")
            .replace(&project.to_string_lossy().replace('\\', "/"), "<project>");
        match &admin_url {
            Some(url) => text
                .replace(url, "<admin-url>")
                .replace(ADMIN_TOKEN, "<admin-token>")
                .replace(TOKEN_PREFIX, "<admin-token-prefix>")
                .replace(TOKEN_ID, "<admin-token-id>"),
            None => text,
        }
    };

    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy"));
    command
        .current_dir(project.join(&step.cwd))
        .args(step.args.iter().map(|arg| expand(arg)))
        .env_clear()
        .env("NODE_NO_WARNINGS", "1")
        .env("CANOPY_CREDENTIALS", project.join("credentials.json"))
        .env("CANOPY_ENVIRONMENTS", project.join("environments.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if cfg!(windows)
        && let Some(root) = std::env::var_os("SystemRoot")
    {
        command.env("SystemRoot", root);
    }
    for (name, value) in &step.env {
        if let Some(value) = value {
            command.env(name, expand(value));
        } else {
            command.env_remove(name);
        }
    }

    let mut child = command.spawn()?;
    let server = listener.map(|listener| {
        let token =
            if step.id == "login-token-refused" { step.stdin.trim() } else { "<session-token>" }.to_owned();
        thread::spawn(move || {
            listener.set_nonblocking(true)?;
            for exchange in exchanges {
                serve(&listener, &token, exchange)?;
            }
            Ok::<(), io::Error>(())
        })
    });
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(expand(&step.stdin).as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if let Some(server) = server {
        server.join().map_err(|_| io::Error::other("admin fixture thread failed"))??;
    }

    assert_eq!(output.status.code(), Some(step.exit_code), "{} exit code", step.id);
    let expected_stdout = with_usage_additions(&step.stdout);
    let expected_stderr = with_usage_additions(&step.stderr);
    assert_eq!(normalize(&String::from_utf8(output.stdout)?), expected_stdout, "{} stdout", step.id);
    assert_eq!(normalize(&String::from_utf8(output.stderr)?), expected_stderr, "{} stderr", step.id);
    let after = snapshot(project)?;
    let mut changes = BTreeMap::new();
    for name in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
        let (old, new) = (before.get(name), after.get(name));
        if old != new {
            let contents = |bytes: &Vec<u8>| std::str::from_utf8(bytes).map(&normalize);
            changes.insert(
                name.clone(),
                Change { before: old.map(contents).transpose()?, after: new.map(contents).transpose()? },
            );
        }
    }
    assert_eq!(changes, step.files, "{} file changes", step.id);
    Ok(())
}

struct Exchange {
    request: &'static str,
    body: &'static str,
    status: &'static str,
    reply: serde_json::Value,
}

fn exchanges(id: &str) -> Vec<Exchange> {
    let mut entry = json!({
        "id": TOKEN_ID, "name": "fixture", "prefix": TOKEN_PREFIX, "role": "admin",
        "userId": "fixture-admin-id", "createdAt": {"$date":"2031-01-01T00:00:00Z"},
        "createdBy": "fixture-admin-id", "active": true
    });
    let token_exchange = match id {
        "login-token-refused" => {
            return vec![Exchange {
                request: "GET /admin/v1/me HTTP/1.1",
                body: "",
                status: "401 Unauthorized",
                reply: json!({"code":"CANOPY_UNAUTHORIZED","detail":"Log in to use the admin API"}),
            }];
        }
        "auth-import" => Exchange {
            request: "POST /admin/v1/users/import HTTP/1.1",
            body: r#"{"users":[{"email":"user@example.test","name":"Fixture User","appMetadata":{"importedFrom":{"system":"csv","id":"fixture"}}}]}"#,
            status: "200 OK",
            reply: json!({"created":1,"skipped":0,"failed":[]}),
        },
        "admin-token-create" => {
            entry["token"] = json!(ADMIN_TOKEN);
            Exchange {
                request: "POST /admin/v1/tokens HTTP/1.1",
                body: r#"{"name":"fixture"}"#,
                status: "201 Created",
                reply: entry,
            }
        }
        "admin-token-list" => Exchange {
            request: "GET /admin/v1/tokens HTTP/1.1",
            body: "",
            status: "200 OK",
            reply: json!({"data": [entry]}),
        },
        "admin-token-revoke" => {
            entry["revokedAt"] = json!({"$date":"2031-01-01T00:00:01Z"});
            entry["active"] = json!(false);
            Exchange {
                request: "DELETE /admin/v1/tokens/fixture-token-id HTTP/1.1",
                body: "",
                status: "200 OK",
                reply: entry,
            }
        }
        _ => return Vec::new(),
    };
    vec![
        Exchange {
            request: "GET /admin/v1/me HTTP/1.1",
            body: "",
            status: "200 OK",
            reply: json!({"user":{"email":"remote@example.test","role":"admin"},"environment":"development"}),
        },
        token_exchange,
    ]
}

fn serve(listener: &TcpListener, token: &str, exchange: Exchange) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    };
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(&mut stream);
    let mut request = String::new();
    reader.read_line(&mut request)?;
    assert_eq!(request.trim_end(), exchange.request);
    let mut headers = BTreeMap::new();
    loop {
        request.clear();
        if reader.read_line(&mut request)? == 0 || request.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = request.split_once(':') {
            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    assert_eq!(headers.get("authorization"), Some(&format!("Bearer {token}")));
    assert_eq!(headers.get("accept").map(String::as_str), Some("application/json"));
    assert_eq!(
        headers.get("content-type").map(String::as_str),
        (!exchange.body.is_empty()).then_some("application/json")
    );
    assert!(!headers.contains_key("transfer-encoding"));
    let length = headers
        .get("content-length")
        .map_or(Ok(0), |length| length.parse::<usize>())
        .map_err(io::Error::other)?;
    assert_eq!(length, exchange.body.len());
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    assert_eq!(body, exchange.body.as_bytes());
    let body = exchange.reply.to_string();
    let content_type =
        if exchange.status == "401 Unauthorized" { "application/problem+json" } else { "application/json" };
    write!(
        stream,
        "HTTP/1.1 {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        exchange.status,
        body.len()
    )
}

fn copy_fixture(source: &Path, destination: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir(&path)?;
            copy_fixture(&entry.path(), &path)?;
        } else {
            fs::copy(entry.path(), path)?;
        }
    }
    Ok(())
}

fn snapshot(root: &Path) -> io::Result<BTreeMap<String, Vec<u8>>> {
    fn visit(root: &Path, directory: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                visit(root, &path, files)?;
            } else if kind.is_file() {
                let relative = path.strip_prefix(root).map_err(io::Error::other)?;
                files.insert(relative.to_string_lossy().replace('\\', "/"), fs::read(path)?);
            } else {
                return Err(io::Error::other(format!("unexpected fixture entry {}", path.display())));
            }
        }
        Ok(())
    }

    let mut files = BTreeMap::new();
    visit(root, root, &mut files)?;
    Ok(files)
}
