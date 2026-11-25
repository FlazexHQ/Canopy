//! HTTP parity and filesystem boundary checks for the standalone Studio role.

use std::collections::BTreeMap;
use std::fs::{self, File, FileTimes};
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{Value, json};

const GATEWAY: &str = env!("CARGO_BIN_EXE_canopyd");
const BUN: &str = include_str!("../../../conformance/http/studio/bun.json");
const NODE: &str = include_str!("../../../conformance/http/studio/node.json");

struct Fixture(PathBuf);

impl Fixture {
    fn new(oracle: &Value) -> Result<Self, Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("canopy-studio-r6-{}", std::process::id()));
        fs::create_dir(&root)?;
        let fixture = Self(root);
        let studio = fixture.0.join("studio");
        for (name, bytes) in oracle["assets"].as_object().ok_or("fixture assets missing")? {
            let path = studio.join(name);
            fs::create_dir_all(path.parent().ok_or("asset directory missing")?)?;
            let mut file = File::create(path)?;
            file.write_all(bytes.as_str().ok_or("asset bytes missing")?.as_bytes())?;
            let modified = oracle["modified"].as_u64().ok_or("mtime missing")?;
            file.set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(modified)))?;
        }
        fs::write(fixture.0.join("outside.txt"), "private fixture")?;
        Ok(fixture)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Gateway(Child, u16);

impl Gateway {
    fn start(directory: Option<&Path>) -> Result<Self, Box<dyn std::error::Error>> {
        let mut command = Command::new(GATEWAY);
        command
            .env("CANOPY_ROLE", "studio")
            .env("HOST", "127.0.0.1")
            .env("PORT", "0")
            .env("MONGODB_URI", "invalid")
            .env_remove("CANOPY_STUDIO_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        if let Some(directory) = directory {
            command.env("CANOPY_STUDIO_DIR", directory);
        }
        let mut gateway = Self(command.spawn()?, 0);
        let mut line = String::new();
        BufReader::new(gateway.0.stdout.take().ok_or("stdout missing")?).read_line(&mut line)?;
        let listening: Value = serde_json::from_str(&line)?;
        assert_eq!(listening["t"], "listening");
        gateway.1 = u16::try_from(listening["port"].as_u64().ok_or("port missing")?)?;
        Ok(gateway)
    }

    fn request(&self, origin: &str, request: &Value) -> Result<Capture, Box<dyn std::error::Error>> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.1))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let method = request["method"].as_str().ok_or("method missing")?;
        let target = request["target"].as_str().ok_or("target missing")?;
        let host = origin.split_once("://").ok_or("scheme missing")?.1;
        let target = if target.starts_with("/?") { format!("{origin}{target}") } else { target.to_owned() };
        write!(stream, "{method} {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n")?;
        for (name, value) in request["headers"].as_object().ok_or("request headers missing")? {
            write!(stream, "{name}: {}\r\n", value.as_str().ok_or("header value missing")?)?;
        }
        write!(stream, "\r\n")?;
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        stream.read_line(&mut line)?;
        let status = line.split_whitespace().nth(1).ok_or("status missing")?.parse()?;
        let mut headers = BTreeMap::new();
        loop {
            line.clear();
            if stream.read_line(&mut line)? == 0 {
                return Err("response headers incomplete".into());
            }
            if line == "\r\n" {
                break;
            }
            let (name, value) = line.split_once(':').ok_or("malformed response header")?;
            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
        let mut body = Vec::new();
        stream.read_to_end(&mut body)?;
        Ok(Capture { status, headers, body })
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Capture {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl Capture {
    fn assert_matches(mut self, id: &Value, oracle: &Value) -> Result<(), Box<dyn std::error::Error>> {
        let headers: BTreeMap<String, String> = serde_json::from_value(oracle["headers"].clone())?;
        self.headers.remove("date");
        self.headers.remove("connection");
        if !headers.contains_key("content-length")
            && let Some(length) = self.headers.remove("content-length")
        {
            assert_eq!(length, self.body.len().to_string(), "{id}");
        }
        assert_eq!(u64::from(self.status), oracle["status"].as_u64().ok_or("status missing")?, "{id}");
        assert_eq!(self.headers, headers, "{id}");
        assert_eq!(self.body, oracle["body"].as_str().ok_or("body missing")?.as_bytes(), "{id}");
        Ok(())
    }
}

#[test]
fn studio_replays_the_http_oracle() -> Result<(), Box<dyn std::error::Error>> {
    let oracle: Value = serde_json::from_str(BUN)?;
    let mut node: Value = serde_json::from_str(NODE)?;
    for case in node["cases"].as_array_mut().ok_or("Node cases missing")? {
        if matches!(case["id"].as_str(), Some("health" | "readiness")) {
            assert_eq!(case["response"]["headers"], json!({ "content-type": "text/plain;charset=UTF-8" }));
            case["response"]["headers"] = json!({});
        }
    }
    assert_eq!(node, oracle);

    let fixture = Fixture::new(&oracle)?;
    let origin = oracle["origin"].as_str().ok_or("origin missing")?;
    let built = Gateway::start(Some(&fixture.0.join("studio")))?;
    let unbuilt = Gateway::start(Some(&fixture.0.join("missing")))?;
    let unset = Gateway::start(None)?;
    for case in oracle["cases"].as_array().ok_or("cases missing")? {
        let id = &case["id"];
        let gateway = if id == "unbuilt" { &unbuilt } else { &built };
        gateway.request(origin, &case["request"])?.assert_matches(id, &case["response"])?;
        if matches!(id.as_str(), Some("unbuilt" | "health" | "readiness")) {
            unset.request(origin, &case["request"])?.assert_matches(id, &case["response"])?;
        }
    }

    for target in [
        "/studio/../outside.txt",
        "/studio/%2e%2e/outside.txt",
        "/studio/assets%2fapp.123.js",
        "/studio/assets%5Capp.123.js",
        "/studio//index.html",
        "/studio/C:/notes",
        "/studio/C%3Anotes",
        "/studio/\\\\server\\share\\notes",
        "/studio///server/share/notes",
        "/studio/%5c%5cserver/share/notes",
    ] {
        let response = built.request(origin, &json!({ "method": "GET", "target": target, "headers": {} }))?;
        assert_eq!(response.status, 404, "{target}");
        assert_eq!(response.body, b"Not found", "{target}");
    }
    Ok(())
}
