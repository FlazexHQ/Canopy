//! Replays the TypeScript password, session and token flows against MongoDB.

#![allow(clippy::expect_used, clippy::print_stderr)]

use std::{
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
    server::{AuthMail, AuthOptions, AuthRouter},
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

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const GROUPS: [&str; 5] = ["email-password", "email-verification", "password-reset", "sessions", "tokens"];

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
                    | "verification-id" | "rate-limit-id" | "target-id" => "[a-f0-9]{24}",
                    "session-token" => "[A-Za-z0-9]{32}",
                    "mail-token" => "[A-Za-z0-9]{16,64}",
                    "mail-jwt-claims" => "[A-Za-z0-9_-]+",
                    "mail-jwt-signature" | "tampered-signature" => "[A-Za-z0-9_-]{43}",
                    "cookie-signature" => "[A-Za-z0-9+/]{43}",
                    "dont-remember-cookie" => "true",
                    "argon2id-salt" => "[A-Za-z0-9+/]{22}",
                    "argon2id-tag" => "[A-Za-z0-9+/]{43}",
                    "text" => r"test/auth/v1/reset-password/[A-Za-z0-9]{16,64}",
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
        for (_, jwt) in url.query_pairs().filter(|(name, _)| name == "token") {
            let (signed, header, claims, tag) = split_jwt(&jwt)?;
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
    let mut body: Value =
        if response.body.is_empty() { Value::Null } else { serde_json::from_slice(&response.body)? };
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
        options.external.insert(key, json!(fixture["options"][option].as_bool().ok_or("feature setting")?));
    }
    for key in fixture["options"]["socialProviders"].as_object().ok_or("Social providers")?.keys() {
        options.external.insert(key.clone(), json!(true));
    }
    for provider in fixture["options"]["oidcProviders"].as_array().ok_or("OIDC providers")? {
        options.external.insert(str_at(provider, "id")?, json!(true));
    }
    let outbox = Arc::new(Outbox {
        messages: Mutex::default(),
        app: str_at(&fixture["options"], "appName")?,
        from: "Canopy Oracle <auth@canopy.test>".into(),
    });
    let router = AuthRouter::open(auth.clone(), meta.clone(), options, outbox.clone()).await?;
    let mut bindings = Bindings::default();
    let mut jars: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let steps = case["steps"].as_array().ok_or("Steps")?;
    for (index, step) in steps.iter().enumerate() {
        let request = &step["request"];
        let original = str_at(request, "path")?;
        if original.contains("<tampered-signature-1>") {
            let signature = bindings.resolve("<mail-jwt-signature-1>")?;
            let replacement = if signature.starts_with('A') { "B" } else { "A" };
            let tail = signature.get(1..).ok_or("Mail signature")?;
            bindings.bind("<tampered-signature-1>", &format!("{replacement}{tail}"))?;
        }
        let path = bindings.resolve(&original)?;
        let check = async {
            let mut http = Request::new(str_at(request, "method")?, path.clone());
            http.client_address = Some(str_at(request, "ip")?);
            for (key, value) in request["headers"].as_object().ok_or("Request headers")? {
                http = http.with_header(
                    key.as_str(),
                    bindings.resolve(value.as_str().ok_or("Request header value")?)?,
                );
            }
            let jar = jars.entry(str_at(step, "client")?).or_default();
            if !jar.is_empty() {
                let pairs: Vec<_> =
                    jar.iter().map(|(name, value)| format!("{name}={}", percent_encode(value))).collect();
                http = http.with_header("cookie", pairs.join("; "));
            }
            if let Some(body) = request.get("body") {
                let text = match body {
                    Value::String(text) => text.as_str().to_owned(),
                    _ => body.to_string(),
                };
                http = http.with_body(bindings.resolve(&text)?.into_bytes());
            }
            let now = DateTime::parse_rfc3339_str(str_at(step, "clock")?)?.timestamp_millis();
            let started = Instant::now();
            let response = router.handle_at(&http, now).await.ok_or("Unserved auth route")?;
            if let Some(held) = step["heldForTheFloor"].as_bool() {
                assert_eq!(started.elapsed() >= Duration::from_millis(75), held, "{path} floor");
            }
            let response = response_value(response, &secret, jwks)?;
            bindings.compare(&step["response"], &response, "response")?;
            for cookie in response["cookies"].as_array().ok_or("Response cookies")? {
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
            Ok::<(), Box<dyn Error>>(())
        }
        .await;
        check.map_err(|error| format!("step {} {path}: {error}", index + 1))?;
    }
    let mut actual = snapshot(&auth, "canopy_auth", None).await?;
    actual.extend(snapshot(&meta, "canopy", Some(&["audit_log", "revocations"])).await?);
    let expected = case["documents"].as_object().ok_or("Final documents")?;
    if expected.len() != actual.len() || !expected.keys().all(|key| actual.contains_key(key.as_str())) {
        return Err(format!(
            "Expected collections {:?}, got {:?}",
            expected.keys().map(|key| key.as_str()).collect::<Vec<_>>(),
            actual.keys()
        )
        .into());
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
    assert_eq!(cases, 13);
    assert_eq!(steps, 86);
    Ok(())
}
