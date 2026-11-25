use std::time::Duration;

use canopy_protocol::ErrorCode;
use reqwest::Method;
use reqwest::blocking::Client;
use serde_json::Value;
use url::Url;

use crate::credentials::{Credentials, nonempty_env, project_key, read_environment};
use crate::output;

pub(crate) fn require_secure(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid URL")?;
    if parsed.scheme() == "http" && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("Admin tokens are only sent over HTTPS (http is allowed for localhost).".into());
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct AdminError {
    pub(crate) code: ErrorCode,
    pub(crate) message: String,
    pub(crate) reason: Option<String>,
}

pub(crate) struct Identity {
    pub(crate) email: String,
    pub(crate) role: String,
    pub(crate) environment: String,
}

pub(crate) struct AdminClient {
    pub(crate) url: String,
    token: String,
}

impl AdminClient {
    pub(crate) fn new(url: String, token: String) -> Self {
        Self { url, token }
    }

    pub(crate) fn call(&self, method: Method, path: &str, body: Option<String>) -> Result<Value, AdminError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let unavailable = |_| AdminError {
            code: ErrorCode::Unavailable,
            message: format!("{} did not answer", self.url),
            reason: None,
        };
        let response = Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .and_then(|client| {
                let request = client
                    .request(method, format!("{}/admin/v1{path}", self.url))
                    .header(reqwest::header::ACCEPT, "application/json")
                    .bearer_auth(&self.token);
                match body {
                    Some(body) => {
                        request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body)
                    }
                    None => request,
                }
                .send()
            })
            .map_err(unavailable)?;
        let status = response.status();
        let body =
            response.text().ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        if let Some(code) = body.get("code").and_then(Value::as_str).and_then(ErrorCode::parse) {
            return Err(AdminError {
                code,
                message: body
                    .get("detail")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("HTTP {}", status.as_u16()), str::to_owned),
                reason: body.pointer("/details/reason").and_then(Value::as_str).map(str::to_owned),
            });
        }
        let code = match status.as_u16() {
            401 => ErrorCode::Unauthorized,
            403 => ErrorCode::Forbidden,
            404 => ErrorCode::NotFound,
            _ => ErrorCode::Internal,
        };
        Err(AdminError {
            code,
            message: format!("{} answered HTTP {}", self.url, status.as_u16()),
            reason: None,
        })
    }

    pub(crate) fn me(&self) -> Result<Identity, AdminError> {
        let body = self.call(Method::GET, "/me", None)?;
        let user = body.get("user").filter(|user| user.is_object()).ok_or_else(|| AdminError {
            code: ErrorCode::Internal,
            message: format!("{} did not answer like a Canopy admin API", self.url),
            reason: None,
        })?;
        Ok(Identity {
            email: string_field(user, "email"),
            role: string_field(user, "role"),
            environment: string_field(&body, "environment"),
        })
    }
}

pub(crate) fn string_field(value: &Value, field: &str) -> String {
    match value.get(field) {
        None | Some(Value::Null) => String::new(),
        Some(value) => display_value(value),
    }
}

fn display_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| if value.is_null() { String::new() } else { display_value(value) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}

pub(crate) fn resolve(
    environment: &str,
    store_error: impl Fn(String) -> String,
) -> Result<AdminClient, String> {
    let url = match nonempty_env("CANOPY_ADMIN_URL") {
        Some(url) => Some(url),
        None => read_environment(environment).map_err(&store_error)?,
    }
    .ok_or_else(|| format!(
        "No project for --env {environment}: run canopy login <url> --env {environment}, or set CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN."
    ))?;
    let token = match nonempty_env("CANOPY_ADMIN_TOKEN") {
        Some(token) => Some(token),
        None => {
            let account = project_key(&url).map_err(&store_error)?;
            Credentials::open().and_then(|credentials| credentials.read(&account)).map_err(store_error)?
        }
    }
    .ok_or_else(|| {
        format!(
            "No admin token for {url}: run canopy login {url} --env {environment}, or set CANOPY_ADMIN_TOKEN."
        )
    })?;
    let client = AdminClient::new(url, token);
    require_secure(&client.url).map_err(|error| format!("--env {environment}: {error}"))?;
    let identity = client.me().map_err(|error| format!("--env {environment}: {}", error.message))?;
    if matches!(environment, "production" | "development") && identity.environment != environment {
        return Err(format!(
            "--env {environment} points at {}, which runs with CANOPY_ENV={}. Log in to the right project with canopy login <url> --env {environment}.",
            client.url, identity.environment
        ));
    }
    output(format_args!("env {environment}: {} as {} ({})", client.url, identity.email, identity.role))?;
    Ok(client)
}
