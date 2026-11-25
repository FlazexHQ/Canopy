use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;
use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::Value;
use url::Url;

pub(crate) fn login(raw_url: &str, flag_token: Option<&str>) -> Result<(&'static str, ExitCode), String> {
    let parsed = Url::parse(raw_url).map_err(|_| "Not a project URL: Invalid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Not a project URL: {raw_url} is not an http or https URL"));
    }
    if parsed.scheme() == "http" && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("Admin tokens are only sent over HTTPS (http is allowed for localhost).".into());
    }
    let url = format!("{}{}", parsed.origin().ascii_serialization(), parsed.path().trim_end_matches('/'));
    let token = match flag_token.map(str::to_owned).or_else(|| std::env::var("CANOPY_ADMIN_TOKEN").ok()) {
        Some(token) => token,
        None if io::stdin().is_terminal() => String::new(),
        None => {
            let mut token = Vec::new();
            io::stdin().read_to_end(&mut token).map_err(|error| error.to_string())?;
            String::from_utf8_lossy(&token).into_owned()
        }
    };
    let token = token.trim();
    if token.is_empty() {
        return Err("No token: pass --token, set CANOPY_ADMIN_TOKEN, or pipe it on standard input.".into());
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let response = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .and_then(|client| {
            client
                .get(format!("{url}/admin/v1/me"))
                .header(reqwest::header::ACCEPT, "application/json")
                .bearer_auth(token)
                .send()
        })
        .map_err(|_| {
            format!("{url} did not answer, so the token could not be verified.\nNothing was stored.")
        })?;

    let status = response.status();
    let body = response.text().ok().and_then(|body| serde_json::from_str::<Value>(&body).ok());
    let error = if status.is_success() {
        if body.as_ref().and_then(|body| body.get("user")).is_some_and(Value::is_object) {
            "Storing a verified admin token is not implemented in this build.".into()
        } else {
            format!("Could not verify the token: {url} did not answer like a Canopy admin API")
        }
    } else {
        refusal(&url, status.as_u16(), body.as_ref())
    };
    Err(format!("{error}\nNothing was stored."))
}

fn refusal(url: &str, status: u16, body: Option<&Value>) -> String {
    let code = body.and_then(|body| body.get("code")).and_then(Value::as_str);
    let detail = body.and_then(|body| body.get("detail")).and_then(Value::as_str);
    match (code, status) {
        (Some("CANOPY_UNAUTHORIZED"), _) | (None, 401) => format!(
            "{url} refused the token: it is unknown, expired, revoked or ended. Create an admin API token with canopy admin tokens create, or POST /admin/v1/login with \"transport\": \"bearer\" for a session token."
        ),
        (Some("CANOPY_FORBIDDEN"), _) | (None, 403) => {
            if body.and_then(|body| body.pointer("/details/reason")).and_then(Value::as_str)
                == Some("password_change_required")
            {
                format!("{url} accepted the token, but the admin must change their password first.")
            } else {
                format!(
                    "{url} refused the token: {}",
                    detail.map_or_else(|| format!("{url} answered HTTP {status}"), str::to_owned)
                )
            }
        }
        (Some("CANOPY_NOT_FOUND"), _) | (None, 404) => format!(
            "{url} has no admin API at /admin/v1. With a private admin listener (CANOPY_ADMIN_LISTEN), log in to that address."
        ),
        (Some("CANOPY_UNAVAILABLE"), _) => {
            format!("{url} did not answer, so the token could not be verified.")
        }
        _ => format!(
            "Could not verify the token: {}",
            detail.map_or_else(|| format!("{url} answered HTTP {status}"), str::to_owned)
        ),
    }
}
