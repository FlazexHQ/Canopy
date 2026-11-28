use std::borrow::Cow;
use std::fs;
use std::io::{self, Write as _};
use std::path::absolute;
use std::process::ExitCode;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

use crate::invocation::Invocation;
use crate::{output, remote, storage_error};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportUser<'a> {
    email: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<Cow<'a, str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    roles: Vec<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_metadata: Option<Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_metadata: Option<&'a Map<String, Value>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    identities: Vec<Identity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password_hash: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    #[serde(flatten)]
    existing: Map<String, Value>,
    imported_from: ImportedFrom,
}

#[derive(Debug, Serialize)]
struct ImportedFrom {
    system: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
}

#[derive(Debug, Serialize)]
struct Identity {
    provider: &'static str,
    subject: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Csv,
    Firebase,
    Auth0,
    Cognito,
}

struct FirebaseHash<'a> {
    signer_key: &'a str,
    salt_separator: &'a str,
    rounds: f64,
    mem_cost: f64,
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
    let source = match call.text("from") {
        Some("csv") => Source::Csv,
        Some("firebase") => Source::Firebase,
        Some("auth0") => Source::Auth0,
        Some("cognito") => Source::Cognito,
        _ => return Err("auth import needs --from firebase|auth0|cognito|csv".into()),
    };
    let hash_key = call.text("hash-key");
    let salt_separator = call.text("salt-separator");
    if hash_key.is_some() && (source != Source::Firebase || salt_separator.is_none()) {
        return Err(
            "--hash-key is for --from firebase and needs --salt-separator (and --rounds, --mem-cost)".into(),
        );
    }
    let integer = |flag, default| {
        number(call.text(flag).unwrap_or(default))
            .filter(|number| number.fract() == 0.0)
            .ok_or("--rounds and --mem-cost must be integers")
    };
    let rounds = integer("rounds", "8")?;
    let mem_cost = integer("mem-cost", "14")?;
    let firebase = hash_key.zip(salt_separator).map(|(signer_key, salt_separator)| FirebaseHash {
        signer_key,
        salt_separator,
        rounds,
        mem_cost,
    });

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
    let contents = String::from_utf8_lossy(&contents);
    let mut users = Vec::new();
    let mut unreadable = 0;
    let mut add = |line, result| {
        match result {
            Ok(user) => users.push(user),
            Err(reason) => {
                unreadable += 1;
                error(format_args!("skip   line {line}: {reason}"))?;
            }
        }
        Ok::<(), String>(())
    };
    let fields;
    let entries;
    match source {
        Source::Csv | Source::Cognito => {
            fields = parse_csv(&contents);
            if let Some((header, lines)) = fields.split_first() {
                let header: Vec<_> = header.iter().map(|field| trim(field)).collect();
                for (index, fields) in lines.iter().enumerate() {
                    let result = if source == Source::Cognito {
                        cognito_user(&header, fields)
                    } else {
                        user(&header, fields)
                    };
                    add(index + 2, result)?;
                }
            }
        }
        Source::Firebase | Source::Auth0 => {
            entries = if source == Source::Firebase {
                serde_json::from_str(&contents)
            } else {
                parse_auth0(&contents)
            }
            .map_err(|error| error.to_string())?;
            let list = if source == Source::Firebase { entries.get("users") } else { Some(&entries) };
            for (index, entry) in list.and_then(Value::as_array).into_iter().flatten().enumerate() {
                add(index + 1, json_user(source, entry, firebase.as_ref()).ok_or_else(|| "no email".into()))?;
            }
        }
    }
    let with_passwords = users.iter().filter(|user| user.password_hash.is_some()).count();
    output(format_args!(
        "{} users read from {} ({with_passwords} with password hashes, {unreadable} unreadable)",
        users.len(),
        file.display(),
    ))?;
    if source == Source::Firebase && firebase.is_none() {
        output(format_args!(
            "No --hash-key given: Firebase password hashes are left out, so these users need a magic link or a reset."
        ))?;
    }
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

fn csv_field<'a>(header: &[&str], fields: &'a [String], name: &str) -> Option<&'a str> {
    let index = header.iter().position(|field| *field == name)?;
    fields.get(index).map(String::as_str)
}

fn cognito_user<'a>(header: &[&str], fields: &'a [String]) -> Result<ImportUser<'a>, String> {
    let at = |name| csv_field(header, fields, name);
    let email = at("email").filter(|email| !email.is_empty()).ok_or("no email")?;
    let name = at("name").map(str::to_owned).unwrap_or_else(|| {
        [at("given_name"), at("family_name")]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    });
    let enabled = at("enabled").or_else(|| at("cognito:enabled")).filter(|value| !value.is_empty());
    let id = at("sub").or_else(|| at("cognito:username")).map(Value::from);
    Ok(ImportUser {
        email,
        name: (!name.is_empty()).then_some(name.into()),
        email_verified: at("email_verified").filter(|value| !value.is_empty()).map(truthy),
        disabled: enabled.filter(|value| !truthy(value)).map(|_| true),
        created_at: None,
        roles: Vec::new(),
        app_metadata: Some(metadata("cognito", id, None)),
        user_metadata: None,
        identities: Vec::new(),
        password_hash: None,
    })
}

fn parse_auth0(text: &str) -> serde_json::Result<Value> {
    let text = trim(text);
    if text.starts_with('[') {
        serde_json::from_str(text)
    } else {
        text.lines()
            .filter(|line| !trim(line).is_empty())
            .map(serde_json::from_str)
            .collect::<serde_json::Result<Vec<_>>>()
            .map(Value::Array)
    }
}

fn metadata(system: &'static str, id: Option<Value>, existing: Option<&Map<String, Value>>) -> Metadata {
    let mut existing = existing.cloned().unwrap_or_default();
    existing.remove("importedFrom");
    Metadata { existing, imported_from: ImportedFrom { system, id } }
}

fn json_user<'a>(
    source: Source,
    entry: &'a Value,
    firebase: Option<&FirebaseHash<'_>>,
) -> Option<ImportUser<'a>> {
    let entry = entry.as_object()?;
    let at = |field| entry.get(field);
    let non_null = |field| at(field).filter(|value| !value.is_null());
    let mut user = ImportUser {
        email: match source {
            Source::Auth0 => non_null("email").or_else(|| at("Email")),
            _ => at("email"),
        }?
        .as_str()?,
        name: None,
        email_verified: None,
        disabled: None,
        created_at: None,
        roles: Vec::new(),
        app_metadata: None,
        user_metadata: None,
        identities: Vec::new(),
        password_hash: None,
    };
    if source == Source::Firebase {
        user.name = at("displayName").and_then(Value::as_str).map(Into::into);
        user.email_verified = at("emailVerified").and_then(Value::as_bool);
        user.disabled = is_true(at("disabled"));
        user.created_at = json_date(at("createdAt"));
        user.app_metadata = Some(metadata("firebase", at("localId").cloned(), None));
        user.identities = identities(source, at("providerUserInfo"));
        if let (Some(config), Some(hash), Some(salt)) =
            (firebase, at("passwordHash").and_then(Value::as_str), at("salt").and_then(Value::as_str))
        {
            user.password_hash = Some(json!({
                "algorithm": "firebase-scrypt", "signerKey": config.signer_key,
                "saltSeparator": config.salt_separator, "rounds": config.rounds, "memCost": config.mem_cost,
                "salt": salt, "hash": hash,
            }));
        }
    } else {
        user.name = at("name").and_then(Value::as_str).map(Into::into);
        user.email_verified = at("email_verified").and_then(Value::as_bool);
        user.disabled = is_true(at("blocked"));
        user.created_at = json_date(non_null("created_at").or_else(|| at("Created At")));
        user.app_metadata =
            Some(metadata("auth0", at("user_id").cloned(), at("app_metadata").and_then(Value::as_object)));
        user.user_metadata = at("user_metadata").and_then(Value::as_object);
        user.identities = identities(source, at("identities"));
        user.password_hash = non_null("passwordHash")
            .or_else(|| non_null("password_hash"))
            .or_else(|| at("custom_password_hash"))
            .and_then(Value::as_str)
            .filter(|hash| hash.starts_with("$2"))
            .map(|hash| json!({ "algorithm": "bcrypt", "hash": hash }));
    }
    Some(user)
}

fn is_true(value: Option<&Value>) -> Option<bool> {
    (value.and_then(Value::as_bool) == Some(true)).then_some(true)
}

fn json_date(value: Option<&Value>) -> Option<String> {
    let date = match value? {
        Value::Number(number) => date_from_millis(&format!("{:.0}", number.as_f64()?.trunc())),
        Value::String(text) => date(text),
        _ => None,
    }?;
    Some(crate::tokens::timestamp(date))
}

fn identities(source: Source, entries: Option<&Value>) -> Vec<Identity> {
    entries
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let firebase = source == Source::Firebase;
            let provider_field = if firebase { "providerId" } else { "provider" };
            let provider = match (source, js_string(entry.get(provider_field)?).as_str()) {
                (Source::Firebase, "google.com") | (Source::Auth0, "google-oauth2") => "google",
                (Source::Firebase, "github.com") | (Source::Auth0, "github") => "github",
                (Source::Firebase, "apple.com") | (Source::Auth0, "apple") => "apple",
                (Source::Firebase, "microsoft.com") | (Source::Auth0, "windowslive") => "microsoft",
                (Source::Auth0, "discord") => "discord",
                _ => return None,
            };
            let subject = if firebase {
                entry.get("rawId")?.as_str()?.to_owned()
            } else {
                js_string(entry.get("user_id")?)
            };
            Some(Identity { provider, subject })
        })
        .collect()
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| if entry.is_null() { String::new() } else { js_string(entry) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Number(number) => {
            number.as_f64().map_or_else(|| number.to_string(), |number| number.to_string())
        }
        _ => value.to_string(),
    }
}

fn user<'a>(header: &[&str], fields: &'a [String]) -> Result<ImportUser<'a>, String> {
    let at = |name| csv_field(header, fields, name).filter(|value| !value.is_empty());
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
        name: at("name").map(Into::into),
        email_verified: at("email_verified").map(truthy),
        disabled: at("disabled").filter(|value| truthy(value)).map(|_| true),
        created_at: at("created_at").and_then(date).map(crate::tokens::timestamp),
        roles: at("roles")
            .into_iter()
            .flat_map(|roles| roles.split(';'))
            .map(str::trim)
            .filter(|role| !role.is_empty())
            .collect(),
        app_metadata: at("id").map(|id| metadata("csv", Some(Value::from(id)), None)),
        user_metadata: None,
        identities: Vec::new(),
        password_hash,
    })
}

fn date(value: &str) -> Option<OffsetDateTime> {
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        return date_from_millis(value);
    }
    OffsetDateTime::parse(value, &Rfc3339)
        .or_else(|_| OffsetDateTime::parse(&format!("{value}T00:00:00Z"), &Rfc3339))
        .ok()
        .map(|date| date.to_offset(UtcOffset::UTC))
}

fn date_from_millis(value: &str) -> Option<OffsetDateTime> {
    let millis: i64 = value.parse().ok()?;
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()
}

fn truthy(value: &str) -> bool {
    matches!(trim(value).to_ascii_lowercase().as_str(), "true" | "1" | "yes")
}

fn trim(value: &str) -> &str {
    value.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
}

fn number(value: &str) -> Option<f64> {
    let value = trim(value);
    if value.is_empty() {
        return Some(0.0);
    }
    for (lower, upper, radix) in [("0x", "0X", 16), ("0o", "0O", 8), ("0b", "0B", 2)] {
        if let Some(digits) = value.strip_prefix(lower).or_else(|| value.strip_prefix(upper)) {
            if digits.is_empty() {
                return None;
            }
            return digits.chars().try_fold(0.0, |number, digit| {
                let next = number * f64::from(radix) + f64::from(digit.to_digit(radix)?);
                next.is_finite().then_some(next)
            });
        }
    }
    value.parse::<f64>().ok().filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::{FirebaseHash, Source, cognito_user, json_user, parse_auth0, parse_csv, user};
    use serde_json::{Value, json};

    #[test]
    fn maps_firebase_and_auth0_metadata_and_identities() -> Result<(), Box<dyn std::error::Error>> {
        let firebase: Value =
            serde_json::from_str(include_str!("../tests/fixtures/auth_import/firebase.json"))?;
        let entry = &firebase["users"][0];
        let hash = FirebaseHash { signer_key: "YQ==", salt_separator: "", rounds: 7.0, mem_cost: 12.0 };
        let user = json_user(Source::Firebase, entry, Some(&hash)).ok_or("Expected Firebase user")?;
        assert_eq!(
            serde_json::to_value(user)?,
            json!({
                "email": "firebase@example.com", "emailVerified": true, "name": "Firebase Fixture",
                "createdAt": "2023-11-14T22:13:20.000Z",
                "appMetadata": {"importedFrom": {"system": "firebase", "id": "firebase-fixture"}},
                "identities": [{"provider": "google", "subject": "firebase-google"}],
                "passwordHash": {"algorithm": "firebase-scrypt", "signerKey": "YQ==", "saltSeparator": "",
                    "rounds": 7.0, "memCost": 12.0, "salt": "42xEC+ixf3L2lw==",
                    "hash": "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ=="},
            })
        );

        let auth0 = parse_auth0(include_str!("../tests/fixtures/auth_import/auth0.ndjson"))?;
        let user = json_user(Source::Auth0, &auth0[0], None).ok_or("Expected Auth0 user")?;
        assert_eq!(
            serde_json::to_value(user)?,
            json!({
                "email": "bcrypt@example.com", "emailVerified": true, "name": "Auth0 Fixture",
                "createdAt": "2024-03-04T17:34:56.000Z",
                "appMetadata": {"plan": "fixture", "importedFrom": {"system": "auth0", "id": "auth0|fixture"}},
                "userMetadata": {"language": "en"},
                "identities": [{"provider": "microsoft", "subject": "123"}, {"provider": "discord", "subject": "null"}],
                "passwordHash": {"algorithm": "bcrypt", "hash": "$2a$04$yODyhWA0fPMZQcfT.zO7guS2dldAUljNlvaoUCncnUD/lszdhAy1i"},
            })
        );
        Ok(())
    }

    #[test]
    fn maps_cognito_attributes_and_missing_fields() -> Result<(), String> {
        let fields = parse_csv(include_str!("../tests/fixtures/auth_import/cognito.csv"));
        let [header, complete, missing, minimal] = fields.as_slice() else {
            return Err("Expected a header and three entries".into());
        };
        let header: Vec<_> = header.iter().map(|field| field.trim()).collect();
        let encode =
            |fields| serde_json::to_value(cognito_user(&header, fields)?).map_err(|error| error.to_string());
        assert_eq!(
            encode(complete.as_slice())?,
            json!({
                "email": "fixture@example.test", "name": "Last, First Fixture", "emailVerified": true,
                "disabled": true, "appMetadata": {"importedFrom": {"system": "cognito", "id": "cognito-fixture"}},
            })
        );
        assert_eq!(encode(missing.as_slice()), Err("no email".into()));
        assert_eq!(
            encode(minimal.as_slice())?,
            json!({
                "email": "minimal@example.test", "appMetadata": {"importedFrom": {"system": "cognito"}},
            })
        );
        Ok(())
    }

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
