use std::fmt::Write;
use std::io::{self, IsTerminal};
use std::process::ExitCode;

use indexmap::IndexMap;
use reqwest::Method;
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

use crate::invocation::Invocation;
use crate::remote::{self, AdminClient, AdminError, string_field};
use crate::{output, prompt, storage_error};

struct Entry<'a> {
    id: &'a str,
    name: String,
    prefix: String,
    role: String,
    user_id: String,
    expires: Option<String>,
    last_used: Option<String>,
    revoked: Option<String>,
    active: bool,
}

impl<'a> Entry<'a> {
    fn read(value: &'a Value) -> Option<Self> {
        Some(Self {
            id: value.get("id")?.as_str()?,
            name: Value::String(string_field(value, "name")).to_string(),
            prefix: string_field(value, "prefix"),
            role: string_field(value, "role"),
            user_id: string_field(value, "userId"),
            expires: date(value.get("expiresAt")),
            last_used: date(value.get("lastUsedAt")),
            revoked: date(value.get("revokedAt")),
            active: value.get("active").and_then(Value::as_bool) == Some(true),
        })
    }
}

fn date(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let value = value.get("$date").unwrap_or(value);
    let timestamp = if let Some(millis) = value.get("$numberLong") {
        let millis: i64 = millis.as_str()?.parse().ok()?;
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()?
    } else {
        let raw = value.as_str()?;
        OffsetDateTime::parse(raw, &Rfc3339)
            .or_else(|_| OffsetDateTime::parse(&format!("{raw}T00:00:00Z"), &Rfc3339))
            .ok()?
    }
    .to_offset(UtcOffset::UTC);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        timestamp.year(),
        u8::from(timestamp.month()),
        timestamp.day(),
        timestamp.hour(),
        timestamp.minute(),
        timestamp.second(),
        timestamp.millisecond()
    ))
}

fn refused(error: AdminError) -> String {
    if error.reason.as_deref() == Some("session_required") {
        "Admin API tokens cannot manage tokens. Log in with a session (canopy login <url> with a token from Studio or POST /admin/v1/login) and try again.".into()
    } else {
        error.message
    }
}

fn create_body(call: &Invocation) -> Result<String, String> {
    let name = call.text("name").ok_or("admin tokens create needs --name <name>")?;
    let mut body = IndexMap::new();
    body.insert("name", Value::String(name.into()));
    if let Some(role) = call.text("role") {
        if !matches!(role, "owner" | "admin" | "developer" | "viewer") {
            return Err("--role must be owner, admin, developer or viewer".into());
        }
        body.insert("role", Value::String(role.into()));
    }
    if let Some(expires) = call.text("expires") {
        let digits = expires.strip_suffix('d').unwrap_or(expires);
        let days = digits
            .parse::<u16>()
            .ok()
            .filter(|_| {
                !digits.starts_with('0')
                    && digits.len() <= 4
                    && digits.bytes().all(|byte| byte.is_ascii_digit())
            })
            .ok_or("--expires needs a number of days, such as 90 or 90d")?;
        body.insert("expiresInDays", Value::from(days));
    }
    serde_json::to_string(&body).map_err(|error| error.to_string())
}

fn create(client: &AdminClient, body: String) -> Result<ExitCode, String> {
    let reply = client.call(Method::POST, "/tokens", Some(body)).map_err(refused)?;
    let (Some(entry), Some(token)) = (Entry::read(&reply), reply.get("token").and_then(Value::as_str)) else {
        return Err("The server did not return a token".into());
    };
    output(format_args!(
        "{}  {}  {}  expires {}",
        entry.id,
        entry.role,
        entry.name,
        entry.expires.as_deref().unwrap_or("never")
    ))?;
    output(format_args!("{token}"))?;
    output(format_args!(
        "This is the only time the token is shown. Store it as a CI secret and pass it as CANOPY_ADMIN_TOKEN, with CANOPY_ADMIN_URL set to the project URL."
    ))?;
    Ok(ExitCode::SUCCESS)
}

fn pad(text: &str, width: usize) -> String {
    format!("{text}{}", " ".repeat(width.saturating_sub(text.encode_utf16().count())))
}

fn list(client: &AdminClient, all: bool) -> Result<ExitCode, String> {
    let path = if all { "/tokens?all=true" } else { "/tokens" };
    let reply = client.call(Method::GET, path, None).map_err(refused)?;
    let entries = reply.get("data").and_then(Value::as_array);
    let mut entries = entries.into_iter().flatten().filter_map(Entry::read).peekable();
    if entries.peek().is_none() {
        output(format_args!(
            "No admin API tokens. Create one with canopy admin tokens create --name ci --env <name>"
        ))?;
    }
    for entry in entries {
        let admin = if all { format!("  admin {}", entry.user_id) } else { String::new() };
        let state = match entry.revoked {
            Some(revoked) => format!("revoked {revoked}"),
            None if entry.active => "active".into(),
            None => "expired".into(),
        };
        output(format_args!(
            "{}  {}  {}  {}{admin}  expires {}  last used {}  {state}",
            entry.id,
            pad(&format!("{}...", entry.prefix), 20),
            pad(&entry.role, 9),
            entry.name,
            entry.expires.as_deref().unwrap_or("never"),
            entry.last_used.as_deref().unwrap_or("never")
        ))?;
    }
    Ok(ExitCode::SUCCESS)
}

fn revoke(client: &AdminClient, id: &str, yes: bool) -> Result<ExitCode, String> {
    if !yes {
        if !io::stdin().is_terminal() {
            return Err(
                "Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.".into()
            );
        }
        prompt(&format!("Revoke the admin API token {id}? Jobs that use it stop working at once. [y/N] "))?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer).map_err(|error| error.to_string())?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            output(format_args!("Not applied."))?;
            return Ok(ExitCode::FAILURE);
        }
    }
    let mut path = String::from("/tokens/");
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            path.push(char::from(byte));
        } else {
            write!(path, "%{byte:02X}").map_err(|error| error.to_string())?;
        }
    }
    let reply = client.call(Method::DELETE, &path, None).map_err(refused)?;
    let entry = Entry::read(&reply);
    let (id, name) = entry.as_ref().map_or((id, "\"\""), |entry| (entry.id, entry.name.as_str()));
    output(format_args!("revoked  {id}  {name}"))?;
    Ok(ExitCode::SUCCESS)
}

pub(crate) fn run(name: &str, args: &[String], call: &Invocation) -> Result<ExitCode, String> {
    let environment = call.text("env").ok_or_else(|| format!(
        "{name} works on a project through its admin API: pass --env <name> (with canopy login <url> --env <name>, or CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN)."
    ))?;
    let body = (name == "admin tokens create").then(|| create_body(call)).transpose()?;
    let client = remote::resolve(environment, |error| storage_error(error, call.has_flag("debug")))?;
    match (body, args) {
        (Some(body), _) => create(&client, body),
        (None, [id]) => revoke(&client, id, call.has_flag("yes")),
        _ => list(&client, call.has_flag("all")),
    }
}

#[cfg(test)]
mod tests {
    use super::date;
    use serde_json::json;

    #[test]
    fn dates_from_admin_ejson_use_utc_and_milliseconds() {
        for value in [
            json!({"$date": "2031-01-01T00:00:00Z"}),
            json!("2031-01-01T01:00:00+01:00"),
            json!({"$date": {"$numberLong": "1924992000000"}}),
        ] {
            assert_eq!(date(Some(&value)).as_deref(), Some("2031-01-01T00:00:00.000Z"));
        }
        assert_eq!(date(Some(&json!("invalid"))), None);
    }
}
