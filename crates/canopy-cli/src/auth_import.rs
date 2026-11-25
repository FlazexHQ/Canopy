use std::fs;
use std::io::{self, Write as _};
use std::path::absolute;
use std::process::ExitCode;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

use crate::invocation::Invocation;
use crate::{output, remote, storage_error};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportUser<'a> {
    email: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    roles: Vec<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_metadata: Option<Metadata<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password_hash: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata<'a> {
    imported_from: ImportedFrom<'a>,
}

#[derive(Debug, Serialize)]
struct ImportedFrom<'a> {
    system: &'static str,
    id: &'a str,
}

#[derive(Serialize)]
struct ImportBatch<'a> {
    users: &'a [ImportUser<'a>],
}

#[derive(Deserialize)]
struct Batch {
    created: usize,
    skipped: usize,
    failed: Vec<Failure>,
}

#[derive(Deserialize)]
struct Failure {
    email: String,
    reason: String,
}

pub(crate) fn run(file: &str, call: &Invocation) -> Result<ExitCode, String> {
    match call.text("from") {
        Some("csv") => {}
        Some("firebase" | "auth0" | "cognito") => {
            return Err("This build supports only --from csv for auth import.".into());
        }
        _ => return Err("auth import needs --from firebase|auth0|cognito|csv".into()),
    }
    if call.text("hash-key").is_some() {
        return Err(
            "--hash-key is for --from firebase and needs --salt-separator (and --rounds, --mem-cost)".into(),
        );
    }
    if ["rounds", "mem-cost"]
        .into_iter()
        .filter_map(|flag| call.text(flag))
        .any(|value| number(value).is_none_or(|number| number.fract() != 0.0))
    {
        return Err("--rounds and --mem-cost must be integers".into());
    }

    let dry_run = call.has_flag("dry-run");
    let remote = if dry_run {
        None
    } else {
        let environment = call.text("env").ok_or(
            "auth import works on a project through its admin API: pass --env <name> (with canopy login <url> --env <name>, or CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN).",
        )?;
        Some(remote::resolve(environment, |error| storage_error(error, call.has_flag("debug")))?)
    };
    let file = absolute(file).map_err(|error| error.to_string())?;
    let contents = fs::read(&file).map_err(|error| format!("{}: {error}", file.display()))?;
    let fields = parse_csv(&String::from_utf8_lossy(&contents));
    let mut users = Vec::new();
    let mut unreadable = 0;
    if let Some((header, lines)) = fields.split_first() {
        let header: Vec<_> = header
            .iter()
            .map(|field| field.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
            .collect();
        for (index, fields) in lines.iter().enumerate() {
            match user(&header, fields) {
                Ok(user) => users.push(user),
                Err(reason) => {
                    unreadable += 1;
                    error(format_args!("skip   line {}: {reason}", index + 2))?;
                }
            }
        }
    }
    let with_passwords = users.iter().filter(|user| user.password_hash.is_some()).count();
    output(format_args!(
        "{} users read from {} ({with_passwords} with password hashes, {unreadable} unreadable)",
        users.len(),
        file.display(),
    ))?;
    let failed = if let Some(remote) = remote { import(&remote, &users)? } else { 0 };
    Ok(if unreadable == 0 && failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

fn import(remote: &remote::AdminClient, users: &[ImportUser<'_>]) -> Result<usize, String> {
    const BATCH_SIZE: usize = 500;
    let mut created = 0;
    let mut skipped = 0;
    let mut failed = Vec::new();
    let mut processed = 0;
    for users_batch in users.chunks(BATCH_SIZE) {
        let body =
            serde_json::to_string(&ImportBatch { users: users_batch }).map_err(|error| error.to_string())?;
        let reply = remote.call(Method::POST, "/users/import", Some(body)).map_err(|error| error.message)?;
        let batch: Batch = serde_json::from_value(reply)
            .map_err(|error| format!("Invalid user import response: {error}"))?;
        if batch.created.checked_add(batch.skipped).and_then(|count| count.checked_add(batch.failed.len()))
            != Some(users_batch.len())
        {
            return Err("Invalid user import response: counts do not match the batch size".into());
        }
        created += batch.created;
        skipped += batch.skipped;
        failed.extend(batch.failed);
        processed += users_batch.len();
        output(format_args!("{processed} / {}", users.len()))?;
    }
    for failure in &failed {
        error(format_args!("failed {}: {}", failure.email, failure.reason))?;
    }
    output(format_args!("{created} imported, {skipped} already existed, {} failed", failed.len()))?;
    Ok(failed.len())
}

fn error(line: std::fmt::Arguments<'_>) -> Result<(), String> {
    writeln!(io::stderr().lock(), "{line}").map_err(|error| error.to_string())
}

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut lines = Vec::new();
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.next_if_eq(&'"').is_some() {
                    field.push(ch);
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
        } else {
            match ch {
                '"' if field.is_empty() => quoted = true,
                ',' => fields.push(std::mem::take(&mut field)),
                '\r' | '\n' => {
                    if ch == '\r' {
                        chars.next_if_eq(&'\n');
                    }
                    fields.push(std::mem::take(&mut field));
                    if fields.iter().any(|cell| !cell.is_empty()) {
                        lines.push(std::mem::take(&mut fields));
                    } else {
                        fields.clear();
                    }
                }
                _ => field.push(ch),
            }
        }
    }
    fields.push(field);
    if fields.iter().any(|cell| !cell.is_empty()) {
        lines.push(fields);
    }
    lines
}

fn user<'a>(header: &[&str], fields: &'a [String]) -> Result<ImportUser<'a>, String> {
    let at = |name| {
        header
            .iter()
            .position(|field| *field == name)
            .and_then(|index| fields.get(index))
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    };
    let email = at("email").ok_or("no email")?;
    let password_hash = if let Some(hash) = at("password_hash") {
        let algorithm = at("password_algorithm").or_else(|| hash.starts_with("$2").then_some("bcrypt"));
        let password = match algorithm {
            Some("bcrypt" | "argon2id") => json!({ "algorithm": algorithm, "hash": hash }),
            Some("pbkdf2-sha256" | "pbkdf2-sha512" | "pbkdf2-sha1") => json!({
                "algorithm": algorithm, "hash": hash, "salt": at("password_salt").unwrap_or_default(),
                "iterations": number(at("password_iterations").unwrap_or("0")),
            }),
            _ => return Err(format!("unknown password_algorithm {}", algorithm.unwrap_or("(none)"))),
        };
        Some(password)
    } else {
        None
    };
    Ok(ImportUser {
        email,
        name: at("name"),
        email_verified: at("email_verified").map(truthy),
        disabled: at("disabled").filter(|value| truthy(value)).map(|_| true),
        created_at: at("created_at").and_then(date).map(crate::tokens::timestamp),
        roles: at("roles")
            .into_iter()
            .flat_map(|roles| roles.split(';'))
            .map(str::trim)
            .filter(|role| !role.is_empty())
            .collect(),
        app_metadata: at("id").map(|id| Metadata { imported_from: ImportedFrom { system: "csv", id } }),
        password_hash,
    })
}

fn date(value: &str) -> Option<OffsetDateTime> {
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        let millis: i64 = value.parse().ok()?;
        return OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok();
    }
    OffsetDateTime::parse(value, &Rfc3339)
        .or_else(|_| OffsetDateTime::parse(&format!("{value}T00:00:00Z"), &Rfc3339))
        .ok()
        .map(|date| date.to_offset(UtcOffset::UTC))
}

fn truthy(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes")
}

fn number(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    value.parse::<f64>().ok().filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::{parse_csv, user};
    use serde_json::json;

    #[test]
    fn reads_quoted_csv_and_import_fields() -> Result<(), String> {
        let header = [
            "email",
            "name",
            "id",
            "roles",
            "email_verified",
            "disabled",
            "created_at",
            "password_hash",
            "password_algorithm",
            "password_salt",
            "password_iterations",
        ];
        let lines = parse_csv(concat!(
            "fixture@example.test,\"Last, \"\"First\"\"\r\nName\",legacy-42,staff; ;owner,Yes,1,2026-01-02,",
            "dGFn,pbkdf2-sha256,c2FsdA==,100000\r\n",
            "\r\n",
            ",Missing email\r\n",
            "bad@example.test,,,,,,,hash,other",
        ));
        let [valid, missing, unknown] = lines.as_slice() else {
            return Err("Expected three CSV entries".into());
        };
        assert_eq!(
            serde_json::to_value(user(&header, valid)?).map_err(|error| error.to_string())?,
            json!({
                "email":"fixture@example.test",
                "passwordHash":{"algorithm":"pbkdf2-sha256","hash":"dGFn","salt":"c2FsdA==","iterations":100000.0},
                "emailVerified": true,
                "disabled": true,
                "name": "Last, \"First\"\r\nName",
                "appMetadata":{"importedFrom":{"system":"csv","id":"legacy-42"}},
                "createdAt":"2026-01-02T00:00:00.000Z",
                "roles":["staff","owner"],
            })
        );
        assert_eq!(user(&header, missing).err().as_deref(), Some("no email"));
        assert_eq!(user(&header, unknown).err().as_deref(), Some("unknown password_algorithm other"));
        Ok(())
    }
}
