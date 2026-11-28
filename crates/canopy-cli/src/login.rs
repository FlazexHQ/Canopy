use std::io::{self, IsTerminal, Read};
use std::process::ExitCode;

use canopy_protocol::ErrorCode;

use crate::credentials::{Credentials, Store, project_key, save_environment};
use crate::remote::{AdminClient, AdminError, require_secure};
use crate::{output, prompt, storage_error};

pub(crate) fn login(
    raw_url: &str,
    flag_token: Option<&str>,
    environment: Option<&str>,
    debug: bool,
) -> Result<ExitCode, String> {
    let url = project_key(raw_url).map_err(|error| format!("Not a project URL: {error}"))?;
    require_secure(&url)?;
    let token = match flag_token.map(str::to_owned).or_else(|| std::env::var("CANOPY_ADMIN_TOKEN").ok()) {
        Some(token) => token,
        None if io::stdin().is_terminal() => {
            prompt(&format!("Admin token for {url}: "))?;
            let result = rpassword::read_password();
            if cfg!(unix) && !io::stdout().is_terminal() {
                prompt("\n")?;
            }
            result.map_err(|error| storage_error(error.to_string(), debug))?
        }
        None => {
            let mut token = Vec::new();
            io::stdin().read_to_end(&mut token).map_err(|error| storage_error(error.to_string(), debug))?;
            String::from_utf8_lossy(&token).into_owned()
        }
    };
    let token = token.trim();
    if token.is_empty() {
        return Err("No token: pass --token, set CANOPY_ADMIN_TOKEN, or pipe it on standard input.".into());
    }
    let client = AdminClient::new(url, token.to_owned());
    let url = &client.url;
    let identity = client.me().map_err(|error| format!("{}\nNothing was stored.", refusal(url, error)))?;
    let store = Credentials::open()
        .and_then(|credentials| credentials.save(url, token))
        .map_err(|error| storage_error(error, debug))?;
    if let Some(environment) = environment {
        save_environment(environment, url).map_err(|error| storage_error(error, debug))?;
    }
    let where_stored = match store {
        Store::Keychain => "the token is in the OS keychain.",
        Store::Protected => "the token is in the credentials file, encrypted for your Windows account.",
        Store::File if cfg!(windows) => {
            "no keychain was available, so the token is in the credentials file (in your Windows user profile, not encrypted)."
        }
        Store::File => "no keychain was available, so the token is in the credentials file (mode 0600).",
    };
    output(format_args!(
        "Logged in to {url} as {} ({}, {}); {where_stored}",
        identity.email, identity.role, identity.environment
    ))?;
    if let Some(environment) = environment {
        output(format_args!(
            "--env {environment} now selects {url} for canopy policies and canopy admin tokens."
        ))?;
    }
    Ok(ExitCode::SUCCESS)
}

pub(crate) fn logout(raw_url: &str, debug: bool) -> Result<ExitCode, String> {
    let result = || {
        let url = project_key(raw_url)?;
        let found = Credentials::open()?.delete(&url)?;
        Ok((url, found))
    };
    let (url, found) = result().map_err(|error| storage_error(error, debug))?;
    if found {
        output(format_args!("Logged out of {url}."))?;
    } else {
        output(format_args!("No token stored for {url}."))?;
    }
    Ok(ExitCode::SUCCESS)
}

fn refusal(url: &str, error: AdminError) -> String {
    match error.code {
        ErrorCode::Unauthorized => format!(
            "{url} refused the token: it is unknown, expired, revoked or ended. Create an admin API token with canopy admin tokens create, or POST /admin/v1/login with \"transport\": \"bearer\" for a session token."
        ),
        ErrorCode::Forbidden if error.reason.as_deref() == Some("password_change_required") => {
            format!("{url} accepted the token, but the admin must change their password first.")
        }
        ErrorCode::Forbidden => format!("{url} refused the token: {}", error.message),
        ErrorCode::NotFound => format!(
            "{url} has no admin API at /admin/v1. With a private admin listener (CANOPY_ADMIN_LISTEN), log in to that address."
        ),
        ErrorCode::Unavailable => format!("{url} did not answer, so the token could not be verified."),
        _ => format!("Could not verify the token: {}", error.message),
    }
}
