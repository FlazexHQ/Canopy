//! Replays the covered TypeScript CLI conformance vectors against the built binary.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

const COVERED: [&str; 11] = [
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
fn cli_vectors() -> Result<(), Box<dyn std::error::Error>> {
    let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cli");
    let vectors: Vectors = serde_json::from_slice(&fs::read(oracle.join("vectors.json"))?)?;
    assert_eq!(vectors.steps.len(), 57);
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
    let listener =
        if step.id == "login-token-refused" { Some(TcpListener::bind(("127.0.0.1", 0))?) } else { None };
    let admin_url = listener
        .as_ref()
        .map(|listener| listener.local_addr())
        .transpose()?
        .map(|address| format!("http://{address}"));
    let expand = |text: &str| match &admin_url {
        Some(url) => text.replace("<admin-url>", url),
        None => text.to_owned(),
    };
    let normalize = |text: &str| {
        let text = text.replace("\r\n", "\n").replace('\\', "/");
        let text = text.replace(&project.to_string_lossy().replace('\\', "/"), "<project>");
        match &admin_url {
            Some(url) => text.replace(url, "<admin-url>"),
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
        let token = step.stdin.trim().to_owned();
        thread::spawn(move || refuse_token(listener, &token))
    });
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(expand(&step.stdin).as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if let Some(server) = server {
        server.join().map_err(|_| io::Error::other("admin fixture thread failed"))??;
    }

    assert_eq!(output.status.code(), Some(step.exit_code), "{} exit code", step.id);
    assert_eq!(normalize(&String::from_utf8(output.stdout)?), step.stdout, "{} stdout", step.id);
    assert_eq!(normalize(&String::from_utf8(output.stderr)?), step.stderr, "{} stderr", step.id);
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

fn refuse_token(listener: TcpListener, token: &str) -> io::Result<()> {
    listener.set_nonblocking(true)?;
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
    assert_eq!(request.trim_end(), "GET /admin/v1/me HTTP/1.1");
    let mut authorization = None;
    loop {
        request.clear();
        if reader.read_line(&mut request)? == 0 || request.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = request.split_once(':')
            && name.eq_ignore_ascii_case("authorization")
        {
            authorization = Some(value.trim().to_owned());
        }
    }
    assert_eq!(authorization, Some(format!("Bearer {token}")));
    let body = r#"{"code":"CANOPY_UNAUTHORIZED","detail":"Log in to use the admin API"}"#;
    write!(
        stream,
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/problem+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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
