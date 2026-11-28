//! Static Studio assets and the standalone Studio HTTP service.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use canopy_realtime::{Body, full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::AsyncReadExt as _;
use tokio::net::TcpListener;
use tokio::sync::Notify;

const BASE: &str = "/studio";
const PREFIX: &str = "/studio/";
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const REVALIDATE: &str = "no-cache";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const UNBUILT: &str =
    "Canopy Studio is not built. Run `bun --filter @canopy/studio-app build` and restart the server.";

#[derive(Clone)]
struct Asset {
    body: Bytes,
    etag: HeaderValue,
}

/// The static Studio application and its immutable asset cache.
#[derive(Default)]
pub(crate) struct Studio {
    root: Option<PathBuf>,
    immutable: Mutex<HashMap<String, Asset>>,
}

impl Studio {
    /// Reads the configured asset root. An unset directory represents an unbuilt app.
    pub(crate) fn from_env() -> Self {
        Self {
            root: std::env::var_os("CANOPY_STUDIO_DIR").filter(|value| !value.is_empty()).map(PathBuf::from),
            ..Self::default()
        }
    }

    /// Whether Studio is configured to serve alongside other routes.
    pub(crate) fn configured(&self) -> bool {
        self.root.is_some()
    }

    /// Whether a request belongs to the Studio mount.
    pub(crate) fn matches(path: &str) -> bool {
        path == BASE || path.starts_with(PREFIX)
    }

    async fn load(&self, relative: &str, immutable: bool) -> Option<Asset> {
        if immutable && let Some(asset) = self.immutable.lock().ok()?.get(relative).cloned() {
            return Some(asset);
        }
        let root = tokio::fs::canonicalize(self.root.as_ref()?).await.ok()?;
        let path = tokio::fs::canonicalize(root.join(relative)).await.ok()?;
        if !path.starts_with(&root) || !tokio::fs::metadata(&path).await.ok()?.is_file() {
            return None;
        }
        let mut file = tokio::fs::File::open(path).await.ok()?;
        let info = file.metadata().await.ok()?;
        let modified = match info.modified().ok()?.duration_since(UNIX_EPOCH) {
            Ok(duration) => format!("{:x}", duration.as_millis()),
            Err(error) if error.duration().as_millis() == 0 => "0".to_owned(),
            Err(error) => format!("-{:x}", error.duration().as_millis()),
        };
        let etag = HeaderValue::from_str(&format!("W/\"{:x}-{modified}\"", info.len())).ok()?;
        let mut body = Vec::new();
        file.read_to_end(&mut body).await.ok()?;
        let asset = Asset { body: Bytes::from(body), etag };
        if immutable {
            self.immutable.lock().ok()?.insert(relative.to_owned(), asset.clone());
        }
        Some(asset)
    }

    /// Serves the Studio mount with its cache and security headers.
    pub(crate) async fn serve(&self, request: Request<Incoming>) -> Response<Body> {
        let path = request.uri().path();
        if !Self::matches(path) {
            return text(StatusCode::NOT_FOUND, "Not found");
        }
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            let mut response = text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
            response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
            return response;
        }
        if path == BASE {
            let mut location = PREFIX.to_owned();
            if let Some(query) = request.uri().query().filter(|query| !query.is_empty()) {
                location.push('?');
                location.push_str(query);
            }
            return secure(redirect(StatusCode::PERMANENT_REDIRECT, &location));
        }
        let Some(relative) = path.strip_prefix(PREFIX).and_then(safe_relative) else {
            return text(StatusCode::NOT_FOUND, "Not found");
        };
        let immutable = relative.starts_with("assets/");
        let file = immutable || extension(&relative).is_some();
        let relative = if file { &relative } else { "index.html" };
        match self.load(relative, immutable).await {
            Some(asset) => asset_response(&request, asset, relative, immutable),
            None if relative == "index.html" => text(StatusCode::SERVICE_UNAVAILABLE, UNBUILT),
            None => text(StatusCode::NOT_FOUND, "Not found"),
        }
    }

    async fn standalone(&self, request: Request<Incoming>, port: u16) -> Response<Body> {
        match request.uri().path() {
            "/healthz" | "/readyz" => full(StatusCode::OK, "ok"),
            "/" => {
                let authority = request
                    .uri()
                    .authority()
                    .cloned()
                    .or_else(|| request.headers().get(header::HOST)?.to_str().ok()?.parse().ok());
                let scheme = request.uri().scheme_str().unwrap_or("http");
                let origin = authority.map_or_else(|| format!("127.0.0.1:{port}"), |value| value.to_string());
                redirect(StatusCode::FOUND, &format!("{scheme}://{origin}{PREFIX}"))
            }
            _ => self.serve(request).await,
        }
    }
}

fn safe_relative(path: &str) -> Option<String> {
    if path.starts_with('/') {
        return None;
    }
    let mut relative = Vec::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        let mut bytes = part.bytes();
        let mut decoded = Vec::with_capacity(part.len());
        while let Some(byte) = bytes.next() {
            let byte = if byte == b'%' {
                let high = char::from(bytes.next()?).to_digit(16)? as u8;
                let low = char::from(bytes.next()?).to_digit(16)? as u8;
                high * 16 + low
            } else {
                byte
            };
            if matches!(byte, b'/' | b'\\' | b':' | 0) {
                return None;
            }
            decoded.push(byte);
        }
        let part = String::from_utf8(decoded).ok()?;
        if part.starts_with('.') || part.ends_with(['.', ' ']) {
            return None;
        }
        relative.push(part);
    }
    Some(relative.join("/"))
}

fn extension(path: &str) -> Option<&str> {
    Path::new(path).extension().and_then(|ext| ext.to_str())
}

fn content_type(path: &str) -> &'static str {
    match extension(path).map(str::to_ascii_lowercase).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("webmanifest") => "application/manifest+json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn secure(mut response: Response<Body>) -> Response<Body> {
    for (name, value) in [
        ("content-security-policy", CSP),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-resource-policy", "same-origin"),
        ("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()"),
    ] {
        response.headers_mut().insert(name, HeaderValue::from_static(value));
    }
    response
}

fn text(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut response = secure(full(status, body));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(REVALIDATE));
    response
}

fn redirect(status: StatusCode, location: &str) -> Response<Body> {
    let Ok(location) = HeaderValue::from_str(location) else {
        return text(StatusCode::BAD_REQUEST, "Invalid request URL");
    };
    let mut response = full(status, Bytes::new());
    response.headers_mut().insert(header::LOCATION, location);
    response
}

fn asset_response(request: &Request<Incoming>, asset: Asset, path: &str, immutable: bool) -> Response<Body> {
    let not_modified = request.headers().get(header::IF_NONE_MATCH) == Some(&asset.etag);
    let length = asset.body.len();
    let body = if not_modified || request.method() == Method::HEAD { Bytes::new() } else { asset.body };
    let status = if not_modified { StatusCode::NOT_MODIFIED } else { StatusCode::OK };
    let mut response = secure(full(status, body));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(path)));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { IMMUTABLE } else { REVALIDATE }),
    );
    headers.insert(header::ETAG, asset.etag);
    if !not_modified {
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    }
    response
}

/// Runs the standalone service without starting MongoDB or realtime.
#[tokio::main(flavor = "current_thread")]
pub(crate) async fn start() -> Result<(), String> {
    use std::io::Write as _;

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_owned());
    let port = port.parse::<u16>().map_err(|_| "PORT must be a TCP port")?;
    let listener = TcpListener::bind((host.as_str(), port)).await.map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let studio = Arc::new(Studio::from_env());
    {
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{{\"t\":\"listening\",\"port\":{port}}}").map_err(|error| error.to_string())?;
        stdout.flush().map_err(|error| error.to_string())?;
    }
    let shutdown = crate::shutdown_signal(Arc::new(Notify::new()));
    tokio::pin!(shutdown);
    loop {
        let (socket, _) = tokio::select! {
            () = &mut shutdown => return Ok(()),
            accepted = listener.accept() => accepted.map_err(|error| error.to_string())?,
        };
        let studio = Arc::clone(&studio);
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let studio = Arc::clone(&studio);
                async move { Ok::<_, Infallible>(studio.standalone(request, port).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
}
