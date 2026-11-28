//! Replays the TypeScript password, email, session and token flows against MongoDB.

#![allow(clippy::expect_used, clippy::print_stderr)]

use std::{
    cell::Cell,
    collections::{BTreeMap, HashMap},
    error::Error,
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bson::{Bson, DateTime, Document, doc};
use canopy_authn::{
    cookies::verify_session,
    server::{
        AuthMail, AuthOptions, AuthRouter,
        oauth::{ClientSecret, OidcProvider, SocialProvider, SocialProviderKind},
    },
};
use canopy_http::{Request, Response};
use canopy_mail::{EmailKind, Recipient, TemplateData, render_default};
use canopy_mongo::mongodb::{Client, Database};
use futures_util::{TryStreamExt, future::BoxFuture};
use percent_encoding::percent_decode_str;
use regex::Regex;
use ring::{hmac, signature};
use serde_json_bytes::{Value, json};
use url::Url;

#[path = "support/idp.rs"]
mod idp;
#[path = "support/passkey_replay.rs"]
mod passkey_replay;
#[path = "../../canopy-webauthn/tests/support/mod.rs"]
mod webauthn_support;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const GROUPS: [&str; 16] = [
    "email-password",
    "email-verification",
    "password-reset",
    "magic-link",
    "email-otp",
    "two-factor",
    "passkeys",
    "sessions",
    "tokens",
    "anonymous",
    "bearer",
    "rate-limits",
    "errors",
    "social",
    "provider-tokens",
    "oidc",
];

macro_rules! object {
    ($($key:literal : $value:expr),* $(,)?) => {
        Value::Object([$(($key.into(), serde_json_bytes::to_value(&$value).expect("ordered JSON field"))),*]
            .into_iter().collect())
    };
}
struct Outbox {
    messages: Mutex<Vec<Value>>,
    app: String,
    from: String,
}

impl AuthMail for Outbox {
    fn send<'a>(self: Arc<Self>, kind: EmailKind, recipient: Recipient<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let rendered = render_default(
                kind,
                &TemplateData {
                    app_name: &self.app,
                    email: recipient.email,
                    url: recipient.url,
                    otp: recipient.otp,
                    new_email: recipient.new_email,
                },
            );
            let mut message = object!("to":recipient.email, "from":self.from,
                "subject":rendered.subject, "text":rendered.text);
            if let Some(html) = rendered.html {
                message["html"] = json!(html);
            }
            self.messages.lock().expect("outbox lock").push(message);
        })
    }
}

#[derive(Default, Clone)]
struct Bindings(HashMap<String, String>);

impl Bindings {
    fn compare(&mut self, expected: &Value, actual: &Value, path: &str) -> Result<()> {
        match (expected, actual) {
            (Value::Object(expected), Value::Object(actual)) => {
                if !expected.keys().eq(actual.keys()) {
                    return Err(format!(
                        "{path}: expected fields {:?}, got {:?}",
                        expected.keys().map(|key| key.as_str()).collect::<Vec<_>>(),
                        actual.keys().map(|key| key.as_str()).collect::<Vec<_>>()
                    )
                    .into());
                }
                for ((key, expected), (_, actual)) in expected.iter().zip(actual) {
                    self.compare(expected, actual, &format!("{path}.{}", key.as_str()))?;
                }
            }
            (Value::Array(expected), Value::Array(actual)) if expected.len() == actual.len() => {
                for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                    self.compare(expected, actual, &format!("{path}[{index}]"))?;
                }
            }
            (Value::String(expected), Value::String(actual)) => self
                .compare_text(expected.as_str(), actual.as_str())
                .map_err(|error| format!("{path}: {error}"))?,
            (expected, actual) if expected == actual => {}
            _ => return Err(format!("{path}: expected {expected}, got {actual}").into()),
        }
        Ok(())
    }

    fn compare_text(&mut self, expected: &str, actual: &str) -> Result<()> {
        let mut source = String::from(r"\A");
        let mut cursor = 0;
        let mut captures = Vec::new();
        for part in placeholder().find_iter(expected) {
            source.push_str(&regex::escape(&expected[cursor..part.start()]));
            let name = part.as_str();
            if let Some(value) = self.0.get(name) {
                source.push_str(&regex::escape(value));
            } else {
                let (kind, _) = name.trim_matches(['<', '>']).rsplit_once('-').ok_or("placeholder kind")?;
                let shape = match kind {
                    "user-id" | "account-id" | "session-id" | "audit-id" | "revocation-id"
                    | "verification-id" | "rate-limit-id" | "target-id" | "two-factor-id" | "passkey-id" => {
                        "[a-f0-9]{24}"
                    }
                    "challenge" | "webauthn-user-id" => "[A-Za-z0-9_-]{43}",
                    "attestation-object" => "[A-Za-z0-9_-]+",
                    "session-token" | "better-auth-passkey-cookie" => "[A-Za-z0-9]{32}",
                    "email" => "temp-[a-z0-9]{32}",
                    "otp" => "[0-9]{6}",
                    "totp-secret" => "[A-Z2-7]{52}",
                    "backup-code" => "[A-Za-z0-9]{5}-[A-Za-z0-9]{5}",
                    "two-factor-cookie" => "2fa-[A-Za-z0-9]{20}",
                    "verification-identifier" => "2fa-attempts-2fa-[A-Za-z0-9]{20}",
                    "two-factor-secret" => "[0-9a-f]{144}",
                    "two-factor-backup-codes" => "[0-9a-f]{362}",
                    "mail-token" => "[A-Za-z0-9]{16,64}",
                    "mail-jwt-claims" => "[A-Za-z0-9_-]+",
                    "mail-jwt-signature" | "tampered-signature" => "[A-Za-z0-9_-]{43}",
                    "cookie-signature" => "[A-Za-z0-9+/]{43}",
                    "dont-remember-cookie" => "true",
                    "argon2id-salt" => "[A-Za-z0-9+/]{22}",
                    "argon2id-tag" => "[A-Za-z0-9+/]{43}",
                    "text" => r"test/auth/v1/reset-password/[A-Za-z0-9]{16,64}",
                    "state-cookie" | "nonce" => "[A-Za-z0-9_-]{32}",
                    "code-challenge" => "[A-Za-z0-9_-]{43}",
                    "code-verifier" | "verification-value" => "[A-Za-z0-9_-]{128}",
                    "code" => "code-[0-9]+",
                    "account-id-token" | "id-token-signature" => "[A-Za-z0-9_-]+",
                    _ => return Err(format!("Unknown placeholder {name}").into()),
                };
                captures.push(name);
                source.push_str(&format!("({shape})"));
            }
            cursor = part.end();
        }
        if cursor == 0 && expected == actual {
            return Ok(());
        }
        source.push_str(&regex::escape(&expected[cursor..]));
        source.push_str(r"\z");
        let regex = Regex::new(&source)?;
        let parts = regex.captures(actual).ok_or_else(|| format!("expected {expected:?}, got {actual:?}"))?;
        for (value, name) in parts.iter().skip(1).zip(captures) {
            self.bind(name, value.ok_or("missing regex capture")?.as_str())?;
        }
        Ok(())
    }

    fn bind(&mut self, name: &str, value: &str) -> Result<()> {
        match self.0.get(name) {
            Some(prior) if prior == value => Ok(()),
            Some(_) => Err(format!("Inconsistent binding for {name}").into()),
            None => {
                if self.0.iter().any(|(other, bound)| bound == value && other != name) {
                    return Err(format!("Duplicate binding for {name}").into());
                }
                self.0.insert(name.into(), value.into());
                Ok(())
            }
        }
    }

    fn resolve(&self, input: &str) -> Result<String> {
        let mut resolved = String::new();
        let mut cursor = 0;
        for part in placeholder().find_iter(input) {
            resolved.push_str(&input[cursor..part.start()]);
            resolved.push_str(
                self.0
                    .get(part.as_str())
                    .ok_or_else(|| format!("Unbound request value {}", part.as_str()))?,
            );
            cursor = part.end();
        }
        resolved.push_str(&input[cursor..]);
        Ok(resolved)
    }
}

fn placeholder() -> &'static Regex {
    static PATTERN: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"<[a-z][a-z0-9-]*-[0-9]+>").expect("placeholder pattern"));
    &PATTERN
}

fn str_at(value: &Value, key: &str) -> Result<String> {
    value[key].as_str().map(str::to_owned).ok_or_else(|| format!("Missing string field {key}").into())
}

fn percent_encode(value: &str) -> String {
    const NOT_COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(value, NOT_COMPONENT).to_string()
}

fn split_jwt(jwt: &str) -> Result<(&str, Value, Value, Vec<u8>)> {
    let (signed, signature) = jwt.rsplit_once('.').ok_or("JWT signature")?;
    let (header, claims) = signed.split_once('.').ok_or("JWT header")?;
    Ok((
        signed,
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header)?)?,
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims)?)?,
        URL_SAFE_NO_PAD.decode(signature)?,
    ))
}

fn check_access_jwt(jwt: &str, jwks: &Value) -> Result<Value> {
    let (signed, header, claims, tag) = split_jwt(jwt)?;
    let key = jwks["keys"]
        .as_array()
        .ok_or("JWKS key array")?
        .iter()
        .find(|key| key["kid"] == header["kid"] && key["alg"] == header["alg"])
        .ok_or("Access token key")?;
    let mut bytes = URL_SAFE_NO_PAD.decode(str_at(key, "x")?)?;
    let algorithm: &dyn signature::VerificationAlgorithm = match str_at(&header, "alg")?.as_str() {
        "EdDSA" => &signature::ED25519,
        "ES256" => {
            bytes.insert(0, 4);
            bytes.extend(URL_SAFE_NO_PAD.decode(str_at(key, "y")?)?);
            &signature::ECDSA_P256_SHA256_FIXED
        }
        _ => return Err("Unsupported signature algorithm".into()),
    };
    signature::UnparsedPublicKey::new(algorithm, bytes)
        .verify(signed.as_bytes(), &tag)
        .map_err(|_| "Invalid access token signature")?;
    Ok(
        object!("jwt": object!("header":header, "claims":claims, "signature":"verified with the JWKS of the case")),
    )
}

fn mail_with_jwts(mut mail: Value, secret: &str, expected: &Value, bindings: &mut Bindings) -> Result<Value> {
    let text = str_at(&mail, "text")?;
    let mut tokens = Vec::new();
    for link in text.split_whitespace().filter(|word| word.starts_with("https://")) {
        let url = Url::parse(link)?;
        if let Some(token) = url.path().strip_prefix("/auth/v1/reset-password/") {
            let key = "<mail-token-1>";
            bindings.compare_text(key, token)?;
        }
        for (_, token) in url.query_pairs().filter(|(name, _)| name == "token") {
            if url.path() == "/auth/v1/magic-link/verify" {
                bindings.compare_text("<mail-token-1>", &token)?;
                continue;
            }
            let (signed, header, claims, tag) = split_jwt(&token)?;
            let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
            hmac::verify(&key, signed.as_bytes(), &tag).map_err(|_| "Invalid mail JWT signature")?;
            tokens.push(object!("header":header, "claims":claims));
        }
    }
    if !tokens.is_empty() {
        mail["jwts"] = Value::Array(tokens);
    }
    bindings.compare(expected, &mail, "mail")?;
    Ok(mail)
}

fn response_value(response: Response, secret: &str, jwks: &Value) -> Result<Value> {
    let mut headers = BTreeMap::new();
    let mut cookies = Vec::new();
    for (name, value) in response.headers {
        if name == "set-cookie" {
            let mut parts = value.split(';').map(str::trim);
            let (name, encoded) =
                parts.next().and_then(|part| part.split_once('=')).ok_or("Set-Cookie pair")?;
            let value = percent_decode_str(encoded).decode_utf8()?;
            if !value.is_empty()
                && (verify_session(secret, encoded).is_none() || percent_encode(&value) != encoded)
            {
                return Err("Invalid cookie signature or encoding".into());
            }
            cookies.push(object!("name":name, "value":value, "attributes":parts.collect::<Vec<_>>()));
        } else if headers.insert(name, value).is_some() {
            return Err("Duplicate response header".into());
        }
    }
    let mut body: Value = if response.body.is_empty() {
        Value::Null
    } else if headers.get("content-type").is_some_and(|value| value.contains("json")) {
        serde_json::from_slice(&response.body)?
    } else {
        json!(String::from_utf8(response.body)?)
    };
    if let Some(token) = body["access_token"].as_str() {
        let verified = check_access_jwt(token, jwks)?;
        body["access_token"] = verified;
    }
    Ok(object!("status":response.status,"headers":headers,"cookies":cookies,"body":body))
}

fn ordered_document(value: &Value) -> Result<Document> {
    value
        .as_object()
        .ok_or("Expected EJSON document")?
        .iter()
        .map(|(field, value)| {
            let json: serde_json::Value = serde_json::from_str(&value.to_string())?;
            Ok((field.as_str().to_owned(), Bson::try_from(json)?))
        })
        .collect()
}

fn canonical(value: Bson) -> Value {
    match value {
        Bson::Document(document) => {
            Value::Object(document.into_iter().map(|(key, value)| (key.into(), canonical(value))).collect())
        }
        Bson::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        other => serde_json_bytes::to_value(other.into_canonical_extjson()).expect("Canonical EJSON"),
    }
}
async fn snapshot(
    db: &Database,
    prefix: &str,
    selected: Option<&[&str]>,
) -> Result<BTreeMap<String, Vec<Value>>> {
    let mut result = BTreeMap::new();
    for collection in db.list_collection_names().await? {
        if selected.is_some_and(|names| !names.contains(&collection.as_str())) {
            continue;
        }
        let documents: Vec<Document> =
            db.collection(&collection).find(doc! {}).sort(doc! {"_id":1}).await?.try_collect().await?;
        if !documents.is_empty() {
            result.insert(
                format!("{prefix}.{collection}"),
                documents.into_iter().map(|document| canonical(Bson::Document(document))).collect(),
            );
        }
    }
    Ok(result)
}

fn unordered(bindings: &mut Bindings, expected: &[Value], actual: &[Value], path: &str) -> Result<()> {
    if let Some((first, rest)) = expected.split_first() {
        for (index, document) in actual.iter().enumerate() {
            let mut trial = bindings.clone();
            if trial.compare(first, document, path).is_err() {
                continue;
            }
            let mut remaining = actual.to_vec();
            remaining.remove(index);
            if unordered(&mut trial, rest, &remaining, path).is_ok() {
                *bindings = trial;
                return Ok(());
            }
        }
        Err(format!("{path}: no matching document for {first}, got {}", json!(actual)).into())
    } else if actual.is_empty() {
        Ok(())
    } else {
        Err(format!("{path}: unexpected documents {}", json!(actual)).into())
    }
}

fn listed_session_caller(request: &Value) -> Result<&str> {
    let credential = request["headers"]["authorization"]
        .as_str()
        .and_then(|header| header.strip_prefix("Bearer "))
        .or_else(|| {
            request["cookies"].as_array()?.iter().find_map(|cookie| {
                let name = cookie["name"].as_str()?;
                if matches!(name, "__Secure-canopy.session_token" | "canopy.session_token") {
                    cookie["value"].as_str()
                } else {
                    None
                }
            })
        })
        .ok_or("Recorded session credential")?;
    Ok(credential.split_once('.').map_or(credential, |(token, _)| token))
}

async fn replay(case: &Value, fixture: &Value, auth: Database, meta: Database) -> Result<usize> {
    let secret = str_at(fixture, "secret")?;
    let public = str_at(fixture, "publicUrl")?;
    let selected = &case["options"];
    let algorithm = selected["algorithm"].as_str().unwrap_or("EdDSA");
    let startup = &fixture["startup"][algorithm];
    let jwks = &startup["jwks"];
    let keys = startup["signingKeys"]
        .as_array()
        .ok_or("Signing keys")?
        .iter()
        .map(ordered_document)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    auth.collection::<Document>("signing_keys").insert_many(keys).await?;
    let mut options = AuthOptions::new(Url::parse(&public)?, secret.clone());
    options.app_name = str_at(&fixture["options"], "appName")?;
    options.trusted_origins = vec![str_at(fixture, "appOrigin")?];
    options.require_email_verification =
        selected["emailPassword"]["requireEmailVerification"].as_bool().unwrap_or(true);
    options.algorithm = serde_json_bytes::from_value(json!(algorithm))?;
    options.access_token_ttl_seconds = selected["accessTokenTtlSeconds"].as_i64().unwrap_or(600);
    for (key, option) in [
        ("anonymous", "anonymous"),
        ("magic_link", "magicLink"),
        ("email_otp", "emailOtp"),
        ("two_factor", "twoFactor"),
        ("passkey", "passkeys"),
    ] {
        options.external.insert(
            key,
            json!(
                selected[option]
                    .as_bool()
                    .or_else(|| fixture["options"][option].as_bool())
                    .ok_or("feature setting")?
            ),
        );
    }
    let social = selected["socialProviders"]
        .as_object()
        .or_else(|| fixture["options"]["socialProviders"].as_object())
        .ok_or("Social providers")?;
    for (key, provider) in social {
        options.social_providers.push(SocialProvider {
            kind: SocialProviderKind::from_id(key.as_str()).ok_or("Social provider kind")?,
            client_id: str_at(provider, "clientId")?,
            client_secret: ClientSecret::Static(str_at(provider, "clientSecret")?),
            tenant_id: None,
        });
    }
    for provider in fixture["options"]["oidcProviders"].as_array().ok_or("OIDC providers")? {
        options.oidc_providers.push(OidcProvider {
            id: str_at(provider, "id")?,
            discovery_url: Url::parse(&str_at(provider, "discoveryUrl")?)?,
            client_id: str_at(provider, "clientId")?,
            client_secret: str_at(provider, "clientSecret")?,
            scopes: Vec::new(),
        });
    }
    let providers = Arc::new(idp::MockIdp::default());
    match case["id"].as_str() {
        Some("generic-oidc-link") => providers.set_user("oidc-link", "oidc-link@example.com", "OIDC Link"),
        Some("social-link-and-unlink") => providers.set_user("4242", "link@example.com", "Octo Cat"),
        Some("github") => providers.set_user("4242", "gh@example.com", "Octo Cat"),
        Some("provider-refresh") => providers.set_user("refresh-user", "refresh@example.com", "Refresh User"),
        Some("google") => providers.set_user("1093", "goo@example.com", "Goo Gle"),
        _ => {}
    }
    options.provider_http = Some(providers.clone());
    let outbox = Arc::new(Outbox {
        messages: Mutex::default(),
        app: str_at(&fixture["options"], "appName")?,
        from: "Canopy Oracle <auth@canopy.test>".into(),
    });
    let router = AuthRouter::open(auth.clone(), meta.clone(), options, outbox.clone()).await?;
    let discovery = providers.take_calls();
    if discovery.len() != 1 || discovery[0]["url"] != idp::DISCOVERY || discovery[0]["method"] != "GET" {
        return Err(format!("Expected one discovery request at startup, got {}", json!(discovery)).into());
    }
    let mut bindings = Bindings::default();
    let mut listed_session_ids = HashMap::new();
    let mut revoked_session_ids = Vec::new();
    let mut jars: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let steps = case["steps"].as_array().ok_or("Steps")?;
    let bearer_clients: std::collections::HashSet<_> = steps
        .iter()
        .filter(|step| {
            ["authorization", "x-canopy-ceremony"]
                .iter()
                .any(|name| step["request"]["headers"].get(*name).is_some())
        })
        .filter_map(|step| step["client"].as_str())
        .collect();
    let mut passkeys = steps
        .iter()
        .any(|step| {
            step["request"]["path"].as_str().is_some_and(|path| path.starts_with("/auth/v1/passkey/"))
        })
        .then(passkey_replay::ReplayPasskeys::load)
        .transpose()?;
    for (index, step) in steps.iter().enumerate() {
        let now = DateTime::parse_rfc3339_str(str_at(step, "clock")?)?.timestamp_millis();
        providers.set_now(now);
        let client = str_at(step, "client")?;
        providers.set_faults(idp::Faults {
            refuse_code: client == "refused",
            refuse_refresh: case["id"] == "provider-refresh" && index >= 11,
            wrong_nonce: client == "wrongNonce",
            wrong_audience: client == "wrongAudience",
            ..idp::Faults::default()
        });
        if let Some(expected) = step.get("provider") {
            let url = bindings.resolve(&str_at(expected, "url")?)?;
            let (status, location) = providers.authorize(&url);
            bindings
                .compare(expected, &object!("url": url, "status": status, "location": location), "provider")
                .map_err(|error| format!("step {} provider: {error}", index + 1))?;
            continue;
        }
        if step["request"]["headers"]["authorization"] == "Bearer <forged-bearer-1>" {
            let token = bindings.resolve("<session-token-2>")?;
            let prefix = token.get(..10).ok_or("Session token prefix")?;
            bindings.bind("<forged-bearer-1>", &format!("{prefix}AAAAAAAAAAAAAAAAAAAAAA"))?;
        }
        let request = &step["request"];
        let original = str_at(request, "path")?;
        if original.contains("<tampered-signature-1>") {
            let signature = bindings.resolve("<mail-jwt-signature-1>")?;
            let replacement = if signature.starts_with('A') { "B" } else { "A" };
            let tail = signature.get(1..).ok_or("Mail signature")?;
            bindings.bind("<tampered-signature-1>", &format!("{replacement}{tail}"))?;
        }
        let path = bindings.resolve(&original)?;
        if case["id"] == "social-link-and-unlink" && original.contains("code=<code-4>") {
            providers.set_user("4242", "other@example.com", "Octo Cat");
        }
        let check = async {
            let method = str_at(request, "method")?;
            let mut http = Request::new(method.clone(), path.clone());
            http.client_address = Some(str_at(request, "ip")?);
            for (key, value) in request["headers"].as_object().ok_or("Request headers")? {
                http = http.with_header(
                    key.as_str(),
                    bindings.resolve(value.as_str().ok_or("Request header value")?)?,
                );
            }
            let jar = jars.entry(client.clone()).or_default();
            if !jar.is_empty() {
                let pairs: Vec<_> =
                    jar.iter().map(|(name, value)| format!("{name}={}", percent_encode(value))).collect();
                http = http.with_header("cookie", pairs.join("; "));
            }
            if let Some(body) = request.get("body") {
                if let Some(code) = body["code"].as_str().filter(|code| code.starts_with("<totp-")) {
                    use canopy_authn::totp::{TotpOptions, base32_decode, totp};
                    let secret = base32_decode(&bindings.resolve("<totp-secret-1>")?).ok_or("TOTP secret")?;
                    assert_eq!(step["details"]["totpStep"].as_i64(), Some(now.div_euclid(30_000)));
                    bindings.bind(code, &totp(&secret, now, TotpOptions::default()))?;
                }
                if matches!(
                    path.as_str(),
                    "/auth/v1/passkey/verify-registration" | "/auth/v1/passkey/verify-authentication"
                ) {
                    passkeys.as_mut().ok_or("Passkey replay state")?.rebuild(
                        &mut bindings,
                        step,
                        path.ends_with("verify-registration"),
                    )?;
                }
                let text = match (method.as_str(), path.as_str(), body) {
                    ("POST", "/auth/v1/revoke-session", _) if step["response"]["status"] == 200 => {
                        let token = str_at(body, "token")?;
                        let id = listed_session_ids.get(&token).ok_or("Revocation target was not listed")?;
                        revoked_session_ids.push(String::clone(id));
                        object!("id": id).to_string()
                    }
                    (_, _, Value::String(text)) => text.as_str().to_owned(),
                    _ => body.to_string(),
                };
                http = http.with_body(bindings.resolve(&text)?.into_bytes());
            }
            let instant = Instant::now();
            let waited = &Cell::new(Duration::ZERO);
            let response = router
                .handle_endpoint_with_floor_timing(
                    &http,
                    now,
                    || instant + waited.get(),
                    |delay| async move { waited.set(delay) },
                )
                .await;
            let expected_wait = if step["heldForTheFloor"].as_bool() == Some(true) {
                Duration::from_millis(80)
            } else {
                Duration::ZERO
            };
            if waited.get() != expected_wait {
                return Err(format!("{path} floor waited {:?}, expected {expected_wait:?}", waited.get()).into());
            }
            let response = response_value(response, &secret, jwks)?;
            if case["id"] == "fresh-session-required"
                && step["response"]["body"]["user"]["id"] == "<user-id-2>"
            {
                let handle = str_at(&response["body"]["user"], "id")?;
                let bytes = URL_SAFE_NO_PAD.decode(&handle)?;
                assert_eq!(bytes.len(), 32, "Registration user handle length");
                assert!(
                    bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()),
                    "Registration user handle encoding"
                );
                bindings.bind("<user-id-2>", &handle)?;
            }
            let mut expected = step["response"].clone();
            if method == "GET" && path == "/auth/v1/list-sessions" && expected["status"] == 200 {
                let caller = listed_session_caller(request)?;
                // The Rust session list identifies sessions by id and keeps their bearer credentials private.
                for entry in expected["body"].as_array_mut().ok_or("Listed sessions")? {
                    let token = str_at(entry, "token")?;
                    let id = str_at(entry, "id")?;
                    let stored = auth
                        .collection::<Document>("sessions")
                        .find_one(doc! {"token": bindings.resolve(&token)?})
                        .await?
                        .ok_or("Stored listed session")?;
                    bindings.compare_text(&id, &canopy_authn::users::id_text(stored.get("_id").ok_or("Session id")?))?;
                    let fields = entry.as_object_mut().ok_or("Listed session fields")?;
                    fields.retain(|key, _| key.as_str() != "token");
                    fields.insert("current", json!(token == caller));
                    listed_session_ids.insert(token, id);
                }
            }
            if path.starts_with("/auth/v1/error?") {
                let mut headers: BTreeMap<_, _> = expected["headers"]
                    .as_object()
                    .ok_or("Error page headers")?
                    .iter()
                    .map(|(name, value)| (name.as_str(), value.clone()))
                    .collect();
                headers.extend([
                    ("cache-control", json!("no-store")),
                    ("x-content-type-options", json!("nosniff")),
                    ("content-security-policy", json!(
                        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
                    )),
                ]);
                expected["headers"] = serde_json_bytes::to_value(headers)?;
            }
            bindings.compare(&expected, &response, "response")?;
            for cookie in response["cookies"]
                .as_array()
                .ok_or("Response cookies")?
                .iter()
                .filter(|_| !bearer_clients.contains(client.as_str()))
            {
                let name = str_at(cookie, "name")?;
                let value = str_at(cookie, "value")?;
                if value.is_empty() {
                    jar.retain(|(prior, _)| prior != &name);
                } else if let Some((_, prior)) = jar.iter_mut().find(|(prior, _)| prior == &name) {
                    *prior = value;
                } else {
                    jar.push((name, value));
                }
            }
            let jar_output =
                Value::Array(jar.iter().map(|(name, value)| object!("name":name, "value":value)).collect());
            if let Some(expected) = request.get("cookies") {
                bindings.compare(expected, &jar_output, "browser cookies")?;
            } else if !jar.is_empty() {
                return Err("Expected empty browser cookies".into());
            }
            let captured = std::mem::take(&mut *outbox.messages.lock().expect("outbox lock"));
            let expected: &[Value] = step["mails"].as_array().map(Vec::as_slice).unwrap_or_default();
            if captured.len() != expected.len() {
                return Err(format!("Expected {} mails, got {}", expected.len(), captured.len()).into());
            }
            for (actual, expected) in captured.into_iter().zip(expected) {
                mail_with_jwts(actual, &secret, expected, &mut bindings)?;
            }
            let calls = Value::Array(providers.take_calls());
            let mut outbound = step.get("outbound").cloned().unwrap_or_else(|| json!([]));
            let social_jwks = outbound[0]["url"].as_str().is_some_and(|url| matches!(url,
                "https://www.googleapis.com/oauth2/v3/certs"
                | "https://appleid.apple.com/auth/keys"
                | "https://login.microsoftonline.com/common/discovery/v2.0/keys"
            ));
            if social_jwks {
                if index > 0 && matches!(case["id"].as_str(), Some("google-direct" | "google-direct-refusals")) {
                    outbound = json!([]);
                } else {
                    outbound[0]["headers"]["accept"] = json!("application/json, application/jwk-set+json");
                }
            }
            if case["id"] == "microsoft-redirect-photo" && path.starts_with("/auth/v1/callback/microsoft?") {
                let mut jwks = serde_json_bytes::Map::new();
                jwks.insert("method", json!("GET"));
                jwks.insert("url", json!("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
                jwks.insert("headers", json!({"accept": "application/json, application/jwk-set+json"}));
                outbound.as_array_mut().expect("provider calls").insert(1, Value::Object(jwks));
            }
            bindings.compare(&outbound, &calls, "outbound")?;
            Ok::<(), Box<dyn Error>>(())
        }
        .await;
        check.map_err(|error| format!("step {} {path}: {error}", index + 1))?;
    }
    let mut actual = snapshot(&auth, "canopy_auth", None).await?;
    actual.extend(snapshot(&meta, "canopy", Some(&["audit_log", "revocations"])).await?);
    // The Rust server counts `/upgrade` toward the per address limit, which the TypeScript server skips.
    if let Some(limits) = actual.get_mut("canopy_auth.rate_limits") {
        limits.retain(|limit| !limit["key"].as_str().is_some_and(|key| key.ends_with("|/upgrade")));
    }
    // The Rust server keeps the time step of the last accepted TOTP code, so a code signs in once.
    if let Some(factors) = actual.get_mut("canopy_auth.two_factors") {
        for factor in factors.iter_mut() {
            let fields = factor.as_object_mut().ok_or("Two factor fields")?;
            if let Some(step) = fields.remove("lastTotpStep") {
                let step = step["$numberLong"]
                    .as_str()
                    .and_then(|step| step.parse::<i64>().ok())
                    .ok_or("lastTotpStep is a 64 bit integer time step")?;
                assert!(step > 0, "lastTotpStep {step}");
            }
        }
    }
    let mut documents = case["documents"].clone();
    if !revoked_session_ids.is_empty() {
        let audit = documents["canopy.audit_log"].as_array_mut().ok_or("Audit documents")?;
        let mut revocations = audit.iter_mut().filter(|event| event["action"] == "auth.session_revoked");
        for id in revoked_session_ids {
            let event = revocations.next().ok_or("Recorded single session revocation")?;
            let fields = event.as_object_mut().ok_or("Single session revocation fields")?;
            *fields = std::mem::take(fields)
                .into_iter()
                .flat_map(|(key, value)| {
                    let target = (key.as_str() == "actor")
                        .then(|| ("target".into(), object!("type": "session", "id": id)));
                    std::iter::once((key, value)).chain(target)
                })
                .collect();
        }
        assert!(revocations.next().is_none(), "Unexpected recorded single session revocation");
    }
    let expected = documents.as_object().ok_or("Final documents")?;
    if expected.len() != actual.len() || !expected.keys().all(|key| actual.contains_key(key.as_str())) {
        return Err(format!(
            "Expected collections {:?}, got {:?}",
            expected.keys().map(|key| key.as_str()).collect::<Vec<_>>(),
            actual.keys()
        )
        .into());
    }
    if let Some(proofs) = expected.get("canopy_auth.verifications").and_then(Value::as_array) {
        let mut challenge = None;
        for proof in proofs {
            let identifier = str_at(proof, "identifier")?;
            if identifier.starts_with("<two-factor-cookie-") {
                challenge = Some(bindings.resolve(&identifier)?);
            } else if identifier.starts_with("<verification-identifier-")
                && let Some(challenge) = challenge.take()
            {
                bindings.bind(&identifier, &format!("2fa-attempts-{challenge}"))?;
            }
        }
    }
    for (name, docs) in expected {
        if !name.as_str().starts_with("canopy.") {
            bindings.compare(docs, &Value::Array(actual[name.as_str()].clone()), name.as_str())?;
        }
    }
    for (name, docs) in expected {
        if name.as_str().starts_with("canopy.") {
            unordered(
                &mut bindings,
                docs.as_array().ok_or("Final documents array")?,
                &actual[name.as_str()],
                name.as_str(),
            )?;
        }
    }
    if expected.contains_key("canopy_auth.two_factors") {
        use canopy_authn::{secrets, totp::base32_encode};
        let encrypted = bindings.resolve("<two-factor-secret-1>")?;
        let plain = secrets::decrypt(&secret, &encrypted).ok_or("Stored TOTP secret")?;
        assert_eq!(base32_encode(plain.as_bytes()), bindings.resolve("<totp-secret-1>")?);
        let encrypted = bindings.resolve("<two-factor-backup-codes-1>")?;
        let plain = secrets::decrypt(&secret, &encrypted).ok_or("Stored backup codes")?;
        let expected = (1..=10)
            .map(|index| bindings.resolve(&format!("<backup-code-{index}>")))
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(serde_json::from_str::<Vec<String>>(&plain)?, expected);
    }
    Ok(steps.len())
}

#[tokio::test]
async fn replays_typescript_auth_oracle() -> Result<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping auth oracle because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/http/auth");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(root.join("fixture.json"))?)?;
    let mut failures = Vec::new();
    let mut steps = 0;
    let mut cases = 0;
    for group in GROUPS {
        let source: Value =
            serde_json::from_str(&fs::read_to_string(root.join("cases").join(format!("{group}.json")))?)?;
        for case in source["cases"].as_array().ok_or("Oracle cases")? {
            let id = str_at(case, "id")?;
            let name = uuid::Uuid::new_v4().simple().to_string();
            let auth = client.database(&format!("auth_oracle_{name}"));
            let meta = client.database(&format!("meta_oracle_{name}"));
            let result = replay(case, &fixture, auth.clone(), meta.clone()).await;
            auth.drop().await?;
            meta.drop().await?;
            match result {
                Ok(count) => steps += count,
                Err(error) => failures.push(format!("{group}/{id}: {error}")),
            }
            cases += 1;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(cases, 49);
    assert_eq!(steps, 375);
    Ok(())
}

#[tokio::test]
async fn consumes_only_the_latest_otp_and_removes_stale_proofs() -> Result<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await?;
    let name = uuid::Uuid::new_v4().simple().to_string();
    let auth = client.database(&format!("auth_oracle_{name}"));
    let meta = client.database(&format!("meta_oracle_{name}"));
    let result = async {
        let outbox = Arc::new(Outbox { messages: Mutex::default(), app: "Canopy".into(), from: String::new() });
        let options = AuthOptions::new(Url::parse("https://auth.canopy.test")?, "a".repeat(32));
        let router = AuthRouter::open(auth.clone(), meta.clone(), options, outbox).await?;
        let now = DateTime::parse_rfc3339_str("2031-01-01T00:00:00.000Z")?;
        let email = "duplicate@example.com";
        let verifications = auth.collection::<Document>("verifications");
        let identifier = format!("sign-in-otp-{email}");
        let expires = DateTime::from_millis(now.timestamp_millis() + 60_000);
        let earlier = DateTime::from_millis(now.timestamp_millis() - 1_000);
        verifications.insert_many([
            doc! {"identifier": &identifier, "value": "123456:0", "createdAt": earlier, "updatedAt": earlier, "expiresAt": expires},
            doc! {"identifier": &identifier, "value": "234567:0", "createdAt": now, "updatedAt": now, "expiresAt": expires},
        ]).await?;
        let request = |code: &str, ip: &str| {
            let mut request = Request::new("POST", "/auth/v1/sign-in/email-otp")
                .with_header("content-type", "application/json")
                .with_body(json!({"email":email,"otp":code}).to_string().into_bytes());
            request.client_address = Some(ip.to_owned());
            request
        };
        let first = request("234567", "203.0.113.1");
        let second = request("234567", "203.0.113.2");
        let (first, second) = tokio::join!(
            router.handle_at(&first, now.timestamp_millis()),
            router.handle_at(&second, now.timestamp_millis()),
        );
        let stale = request("123456", "203.0.113.3");
        let stale = router.handle_at(&stale, now.timestamp_millis()).await.ok_or("Missing stale response")?;
        let remaining = verifications.count_documents(doc! {"identifier": &identifier}).await?;
        let mut statuses = [first.ok_or("Missing first response")?.status, second.ok_or("Missing second response")?.status];
        statuses.sort_unstable();
        Ok::<_, Box<dyn Error>>((statuses, stale.status, remaining))
    }.await;
    auth.drop().await?;
    meta.drop().await?;
    assert_eq!(result?, ([200, 400], 400, 0));
    Ok(())
}

#[tokio::test]
async fn opens_over_the_indexes_the_typescript_server_created() -> Result<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await?;
    let name = uuid::Uuid::new_v4().simple().to_string();
    let auth = client.database(&format!("auth_indexes_{name}"));
    let meta = client.database(&format!("meta_indexes_{name}"));
    let typescript: [(&str, Document); 11] = [
        ("users", doc! {"key": {"email": 1}, "name": "email", "unique": true}),
        ("sessions", doc! {"key": {"token": 1}, "name": "token", "unique": true}),
        ("sessions", doc! {"key": {"userId": 1}, "name": "user"}),
        ("sessions", doc! {"key": {"expiresAt": 1}, "name": "ttl_expires", "expireAfterSeconds": 0}),
        (
            "accounts",
            doc! {"key": {"providerId": 1, "accountId": 1}, "name": "provider_account", "unique": true},
        ),
        ("accounts", doc! {"key": {"userId": 1}, "name": "user"}),
        ("verifications", doc! {"key": {"identifier": 1}, "name": "identifier"}),
        ("verifications", doc! {"key": {"expiresAt": 1}, "name": "ttl_expires", "expireAfterSeconds": 3600}),
        ("rate_limits", doc! {"key": {"key": 1}, "name": "key", "unique": true}),
        ("signing_keys", doc! {"key": {"createdAt": -1}, "name": "created"}),
        ("identifier_limits", doc! {"key": {"expiresAt": 1}, "name": "ttl_expires", "expireAfterSeconds": 0}),
    ];
    let result = async {
        for (collection, index) in &typescript {
            auth.run_command(doc! {"createIndexes": *collection, "indexes": [index.clone()]}).await?;
        }
        let outbox =
            Arc::new(Outbox { messages: Mutex::default(), app: "Canopy".into(), from: String::new() });
        let options = AuthOptions::new(Url::parse("https://auth.canopy.test")?, "a".repeat(32));
        AuthRouter::open(auth.clone(), meta.clone(), options, outbox).await?;
        let mut found = Vec::new();
        for collection in auth.list_collection_names().await? {
            let mut cursor = auth.collection::<Document>(&collection).list_indexes().await?;
            while let Some(index) = cursor.try_next().await? {
                let name = index.options.and_then(|options| options.name).unwrap_or_default();
                if name != "_id_" {
                    found.push(format!("{collection}.{name}"));
                }
            }
        }
        found.sort();
        Ok::<_, Box<dyn Error>>(found)
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    let mut expected: Vec<String> = typescript
        .iter()
        .map(|(collection, index)| format!("{collection}.{}", index.get_str("name").unwrap_or_default()))
        .collect();
    expected.extend(["two_factors.user".into(), "passkeys.credential".into()]);
    expected.sort();
    assert_eq!(result?, expected);
    Ok(())
}

#[tokio::test]
async fn requires_a_fresh_session_for_two_factor_enrolment() -> Result<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await?;
    let name = uuid::Uuid::new_v4().simple().to_string();
    let auth = client.database(&format!("auth_fresh_{name}"));
    let meta = client.database(&format!("meta_fresh_{name}"));
    let result = async {
        let now = DateTime::parse_rfc3339_str("2031-01-01T00:00:00Z")?;
        let secret = "a".repeat(32);
        let origin = "https://auth.canopy.test";
        let outbox =
            Arc::new(Outbox { messages: Mutex::default(), app: "Canopy".into(), from: String::new() });
        let router = AuthRouter::open(
            auth.clone(),
            meta.clone(),
            AuthOptions::new(Url::parse(origin)?, secret.clone()),
            outbox,
        )
        .await?;
        auth.collection::<Document>("users")
            .insert_one(doc! {
                "_id": "user", "name": "User", "email": "user@example.test", "emailVerified": true,
                "createdAt": now, "updatedAt": now,
            })
            .await?;
        auth.collection::<Document>("accounts")
            .insert_one(doc! {
                "accountId": "user", "providerId": "credential", "userId": "user",
                "password": canopy_authn::passwords::hash_password("correct password")?,
                "createdAt": now, "updatedAt": now,
            })
            .await?;
        auth.collection::<Document>("sessions")
            .insert_one(doc! {
                "userId": "user", "token": "session", "createdAt": now, "updatedAt": now,
                "expiresAt": DateTime::from_millis(now.timestamp_millis() + 1_800_000),
                "ipAddress": "", "userAgent": "", "aal": "aal1",
            })
            .await?;
        let cookie = canopy_authn::cookies::sign_session(&secret, "session");
        let request = Request::new("POST", "/auth/v1/two-factor/enable")
            .with_header("origin", origin)
            .with_header("cookie", format!("__Secure-canopy.session_token={cookie}"))
            .with_body(br#"{"password":"correct password"}"#.to_vec());
        let expired =
            router.handle_at(&request, now.timestamp_millis() + 900_000).await.ok_or("Auth response")?;
        assert_eq!(expired.status, 403);
        assert_eq!(
            serde_json::from_slice::<Value>(&expired.body)?,
            object!("message":"Session is not fresh", "code":"SESSION_NOT_FRESH")
        );
        assert_eq!(auth.collection::<Document>("two_factors").count_documents(doc! {}).await?, 0);
        let fresh =
            router.handle_at(&request, now.timestamp_millis() + 899_999).await.ok_or("Auth response")?;
        assert_eq!(fresh.status, 200);
        assert_eq!(
            auth.collection::<Document>("two_factors").count_documents(doc! {"verified": false}).await?,
            1
        );
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    result
}

#[tokio::test]
async fn opens_over_duplicate_authenticator_documents_the_typescript_server_allowed() -> Result<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::with_uri_str(uri).await?;
    let name = uuid::Uuid::new_v4().simple().to_string();
    let auth = client.database(&format!("auth_factors_{name}"));
    let meta = client.database(&format!("meta_factors_{name}"));
    let result = async {
        let factors = auth.collection::<Document>("two_factors");
        factors
            .insert_many([doc! {"userId": "user-1", "secret": "a"}, doc! {"userId": "user-1", "secret": "b"}])
            .await?;
        let passkeys = auth.collection::<Document>("passkeys");
        passkeys
            .insert_many([
                doc! {"credentialID": "same-credential", "userId": "user-1"},
                doc! {"credentialID": "same-credential", "userId": "user-2"},
            ])
            .await?;
        let outbox =
            Arc::new(Outbox { messages: Mutex::default(), app: "Canopy".into(), from: String::new() });
        let options = AuthOptions::new(Url::parse("https://auth.canopy.test")?, "a".repeat(32));
        AuthRouter::open(auth.clone(), meta.clone(), options, outbox).await?;
        let mut names = Vec::new();
        for collection in ["two_factors", "passkeys", "identifier_limits"] {
            let mut cursor = auth.collection::<Document>(collection).list_indexes().await?;
            while let Some(index) = cursor.try_next().await? {
                names.push(format!(
                    "{collection}.{}",
                    index.options.and_then(|options| options.name).unwrap_or_default()
                ));
            }
        }
        names.sort();
        Ok::<_, Box<dyn Error>>((
            names,
            factors.count_documents(doc! {}).await?,
            passkeys.count_documents(doc! {}).await?,
        ))
    }
    .await;
    auth.drop().await?;
    meta.drop().await?;
    assert_eq!(
        result?,
        (
            vec![
                "identifier_limits._id_".to_owned(),
                "identifier_limits.ttl_expires".to_owned(),
                "passkeys._id_".to_owned(),
                "two_factors._id_".to_owned()
            ],
            2,
            2
        )
    );
    Ok(())
}
