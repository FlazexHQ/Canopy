//! Replays the TypeScript admin HTTP oracle (`conformance/http/admin/<role>.json`) against the Rust admin API
//! on a MongoDB replica set given by `CANOPY_TEST_MONGODB_URI`.
//!
//! Each recorded request is rebuilt from the values the Rust server returned earlier, sent to `Control`, and
//! its status, headers, cookies, body and the documents it wrote or removed are compared with the recording
//! after the recorder's substitutions. Timestamps, the setup token, database names, TOTP steps, cluster times
//! and server versions are substituted exactly as the recorder does. Generated ids, credentials and stored
//! secrets are numbered by the recorder in order of appearance; the replay instead binds each numbered
//! placeholder to the first value found at its place and requires every later use to repeat it (and no two
//! placeholders to share a value), which is the same relation without depending on numbering order.
//!
//! Policy, data, realtime and email template routes are served through their delegates.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::print_stderr, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use canopy_control::totp::{TotpOptions, base32_decode, totp};
use canopy_control::{
    AdminRole, BoxFuture, BuiltinMethods, Call, Control, ControlOptions, DataRoutes, Delegate, Environment,
    InspectionQuery, Inspector, MetaStatus, PolicyRoutes, PolicyStatus, ROLE_NAMES, RealtimeRoutes,
    RealtimeStatus, SigningAlgorithm, SigningKeyOptions, SigningKeyRoutes, Status, TemplateRoutes,
    ViewSigner, WebhookAdmin, builtin_providers,
};
use canopy_http::Request;
use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, RawDocumentBuf, doc, oid::ObjectId};
use canopy_mongo::mongodb::{Client, Database};
use canopy_protocol::json::{Json, js_number_string, parse_json, write_json_string};
use canopy_protocol::{CanopyError, Value};
use futures_util::{StreamExt as _, TryStreamExt as _};
use regex::Regex;

const ORIGIN: &str = "https://admin.example.test";
const HOST: &str = "admin.example.test";
const PEER: &str = "127.0.0.1";
const FIXTURE_SECRET: &str = "fixture private field";

const COLLECTIONS: [&str; 12] = [
    "admin_sessions",
    "admin_tokens",
    "admin_users",
    "api_keys",
    "audit_log",
    "policies",
    "policy_history",
    "settings",
    "revocations",
    "webhook_dead_letters",
    "webhook_deliveries",
    "webhook_schedules",
];

/// Route groups served by delegates this test does not provide, by their method and path.
fn delegated(path: &str) -> Option<&'static str> {
    let route = path.trim_start_matches("/admin/v1/");
    let route = route.split('?').next().unwrap_or_default();
    let first = route.split('/').next().unwrap_or_default();
    match first {
        "users" => Some("users"),
        _ => None,
    }
}

fn get<'a>(json: &'a Json, key: &str) -> &'a Json {
    json.get(key).unwrap_or(&Json::Null)
}

fn string(json: &Json) -> String {
    match json {
        Json::String(text) => text.clone(),
        _ => String::new(),
    }
}

fn entries(json: &Json) -> Vec<(String, Json)> {
    match json {
        Json::Object(entries) => entries.clone(),
        _ => Vec::new(),
    }
}

fn items(json: &Json) -> Vec<Json> {
    match json {
        Json::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

/// Canonical Extended JSON as the JavaScript BSON library writes it with `relaxed: false`.
fn canonical(value: &Bson, out: &mut String) {
    match value {
        Bson::Document(document) => {
            out.push('{');
            for (index, (key, item)) in document.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(out, key);
                out.push(':');
                canonical(item, out);
            }
            out.push('}');
        }
        Bson::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Bson::String(text) => write_json_string(out, text),
        Bson::Boolean(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Bson::Null => out.push_str("null"),
        Bson::Int32(number) => out.push_str(&format!("{{\"$numberInt\":\"{number}\"}}")),
        Bson::Int64(number) => out.push_str(&format!("{{\"$numberLong\":\"{number}\"}}")),
        Bson::Double(number) => {
            let text = if number.is_nan() {
                "NaN".to_owned()
            } else if number.is_infinite() {
                if *number > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() }
            } else if *number == 0.0 && number.is_sign_negative() {
                "-0.0".to_owned()
            } else if number.fract() == 0.0 && number.abs() < 1e21 {
                format!("{number:.1}")
            } else {
                js_number_string(*number)
            };
            out.push_str(&format!("{{\"$numberDouble\":\"{text}\"}}"));
        }
        Bson::DateTime(at) => {
            out.push_str(&format!("{{\"$date\":{{\"$numberLong\":\"{}\"}}}}", at.timestamp_millis()))
        }
        Bson::ObjectId(id) => out.push_str(&format!("{{\"$oid\":\"{}\"}}", id.to_hex())),
        other => out.push_str(&format!("{other:?}")),
    }
}

/// The substitutions of the recorder that do not number values.
struct Normalizer {
    epoch: i64,
    aliases: Vec<(String, String)>,
    rules: Vec<(Regex, &'static str)>,
    iso: Regex,
    time: Regex,
    long: Regex,
    step: Regex,
}

impl Normalizer {
    fn new(epoch: i64, aliases: Vec<(String, String)>) -> Normalizer {
        let mut aliases = aliases;
        aliases.sort_by_key(|(actual, _)| std::cmp::Reverse(actual.len()));
        let rule = |pattern: &str| Regex::new(pattern).unwrap();
        Normalizer {
            epoch,
            aliases,
            rules: vec![
                (rule(r#"("wallTime":)(?:"[^"]+"|\d+|\{"\$date":"[^"]+"\})"#), r#"$1"<mongo-wall-time>""#),
                (rule(r#"("lagMs":)[1-9]\d*"#), r#"$1"<positive-lag-ms>""#),
                (rule(r#"("(?:ct|streamPosition)":")[1-9]\d*""#), r#"$1<ct>""#),
                (rule(r"MongoDB \d+\.\d+\.\d+"), "MongoDB <version>"),
                (rule(r#"("(?:storageSize|totalIndexSize)":)\d+"#), r#"$1"<storage-bytes>""#),
            ],
            time: rule(r#"("t":)(\d{13})"#),
            iso: rule(r"\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b"),
            long: rule(r#"("\$numberLong":")(\d{13})""#),
            step: rule(r#"("lastStep":(?:\{"\$numberInt":")?)(\d+)"#),
        }
    }

    fn apply(&self, input: &str) -> String {
        let mut value = input.to_owned();
        for (actual, alias) in &self.aliases {
            value = value.replace(actual.as_str(), alias);
        }
        let (wall, rest) = self.rules.split_at(1);
        for (pattern, replacement) in wall {
            value = pattern.replace_all(&value, *replacement).into_owned();
        }
        let epoch = self.epoch;
        value = self
            .time
            .replace_all(&value, |caps: &regex::Captures<'_>| {
                format!("{}\"<time+{}>\"", &caps[1], caps[2].parse::<i64>().unwrap() - epoch)
            })
            .into_owned();
        for (pattern, replacement) in rest.iter().take(1) {
            value = pattern.replace_all(&value, *replacement).into_owned();
        }
        value = self
            .iso
            .replace_all(&value, |caps: &regex::Captures<'_>| {
                let at = canopy_protocol::ejson::parse_iso_date(&caps[0]).unwrap();
                format!("<time+{}>", at - epoch)
            })
            .into_owned();
        value = self
            .long
            .replace_all(&value, |caps: &regex::Captures<'_>| {
                format!("{}<time+{}>\"", &caps[1], caps[2].parse::<i64>().unwrap() - epoch)
            })
            .into_owned();
        value = self
            .step
            .replace_all(&value, |caps: &regex::Captures<'_>| {
                format!("{}<totp-step+{}>", &caps[1], caps[2].parse::<i64>().unwrap() - epoch / 30_000)
            })
            .into_owned();
        for (pattern, replacement) in rest.iter().skip(1) {
            value = pattern.replace_all(&value, *replacement).into_owned();
        }
        value
    }
}

/// Placeholders bound to the values the Rust server produced, in both directions.
#[derive(Default, Clone)]
struct Bindings {
    values: HashMap<String, String>,
    names: HashMap<String, String>,
}

fn class(kind: &str) -> &'static str {
    match kind {
        "object-id" => "[0-9a-f]{24}",
        "id" => r"(?:adm|tok|key)_[\w-]{16}",
        "uuid" => "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",
        "digest-id" => "[a-f0-9]{64}",
        "stored-secret" => r#"[^"<>]+"#,
        "prefix" | "kid" | "x" | "y" => "[A-Za-z0-9_-]+",
        _ => "[A-Za-z0-9_.~+/=-]+",
    }
}

impl Bindings {
    fn bind(&mut self, name: &str, value: &str) {
        self.values.insert(name.to_owned(), value.to_owned());
        self.names.insert(value.to_owned(), name.to_owned());
    }

    /// The bindings under which `actual` is `expected`, or why it is not.
    fn unify(&self, expected: &str, actual: &str) -> Result<Bindings, String> {
        let placeholder = Regex::new(
            r"<(object-id|id|uuid|digest-id|stored-secret|prefix|kid|x|y|token|csrfToken|password|secret|key|cookie-session|totp-code):[^<>]+>",
        )
        .unwrap();
        let mut pattern = String::from("^");
        let mut groups = Vec::new();
        let mut last = 0;
        for found in placeholder.captures_iter(expected) {
            let whole = found.get(0).unwrap();
            pattern.push_str(&regex::escape(&expected[last..whole.start()]));
            match self.values.get(whole.as_str()) {
                Some(value) => pattern.push_str(&regex::escape(value)),
                None => {
                    pattern.push('(');
                    pattern.push_str(class(&found[1]));
                    pattern.push(')');
                    groups.push(whole.as_str().to_owned());
                }
            }
            last = whole.end();
        }
        pattern.push_str(&regex::escape(&expected[last..]));
        pattern.push('$');
        let compiled = Regex::new(&pattern).map_err(|error| error.to_string())?;
        let caps =
            compiled.captures(actual).ok_or_else(|| format!("expected\n  {expected}\nactual\n  {actual}"))?;
        let mut next = self.clone();
        for (index, name) in groups.iter().enumerate() {
            let value = caps.get(index + 1).map(|found| found.as_str()).unwrap_or_default();
            match (next.values.get(name), next.names.get(value)) {
                (Some(bound), _) if bound != value => {
                    return Err(format!("{name} is both {bound} and {value}"));
                }
                (None, Some(other)) if other != name => {
                    return Err(format!("{value} is both {other} and {name}"));
                }
                _ => next.bind(name, value),
            }
        }
        Ok(next)
    }

    /// Unifies two lists of texts in any order.
    fn unify_all(&self, expected: &[String], actual: &[String]) -> Result<Bindings, String> {
        if expected.len() != actual.len() {
            return Err(format!(
                "expected {} documents\n  {}\nactual\n  {}",
                expected.len(),
                expected.join("\n  "),
                actual.join("\n  ")
            ));
        }
        let Some((first, rest)) = expected.split_first() else { return Ok(self.clone()) };
        let mut failure = String::new();
        for (index, candidate) in actual.iter().enumerate() {
            match self.unify(first, candidate) {
                Ok(bound) => {
                    let remaining: Vec<String> = actual
                        .iter()
                        .enumerate()
                        .filter(|(other, _)| *other != index)
                        .map(|(_, text)| text.clone())
                        .collect();
                    match bound.unify_all(rest, &remaining) {
                        Ok(done) => return Ok(done),
                        Err(error) => failure = error,
                    }
                }
                Err(error) => failure = error,
            }
        }
        Err(failure)
    }

    /// The text of a recorded request with every placeholder replaced by its bound value.
    fn resolve(&self, text: &str, epoch: i64) -> Option<String> {
        let placeholder = Regex::new(r"<[A-Za-z-]+(?::[^<>]+)?>|<time\+-?\d+>").unwrap();
        let mut out = String::new();
        let mut last = 0;
        for found in placeholder.find_iter(text) {
            out.push_str(&text[last..found.start()]);
            let token = found.as_str();
            if let Some(offset) = token.strip_prefix("<time+").and_then(|rest| rest.strip_suffix('>')) {
                out.push_str(&canopy_protocol::ejson::iso_string(epoch + offset.parse::<i64>().ok()?));
            } else {
                out.push_str(self.values.get(token)?);
            }
            last = found.end();
        }
        out.push_str(&text[last..]);
        Some(out)
    }
}

async fn snapshot(meta: &Database, normalizer: &Normalizer) -> BTreeMap<String, Vec<String>> {
    let mut state = BTreeMap::new();
    for name in COLLECTIONS {
        let found: Vec<Document> = meta
            .collection::<Document>(name)
            .find(Document::new())
            .sort(doc! { "_id": 1 })
            .await
            .unwrap()
            .try_collect()
            .await
            .unwrap();
        let mut texts: Vec<String> = found
            .into_iter()
            .map(|document| {
                let mut out = String::new();
                canonical(&Bson::Document(document), &mut out);
                normalizer.apply(&out)
            })
            .collect();
        texts.sort();
        state.insert(name.to_owned(), texts);
    }
    state
}

struct OracleInspector(std::sync::Mutex<canopy_engine::Engine>);

impl Inspector for OracleInspector {
    fn read(&self, query: InspectionQuery) -> BoxFuture<'_, Result<Option<Value>, CanopyError>> {
        Box::pin(async move {
            let engine = self.0.lock().unwrap();
            Ok(match query {
                InspectionQuery::Stats => Some(Value::Document(engine.inspection_stats())),
                InspectionQuery::Connections => Some(Value::Array(engine.inspection_connections())),
                InspectionQuery::Observers => Some(Value::Array(engine.inspection_observers())),
                InspectionQuery::Events => Some(Value::Array(engine.inspection_events())),
                InspectionQuery::Trace { id, viewer } => {
                    engine.inspection_trace(&id, viewer).map(Value::Document)
                }
                InspectionQuery::Tail => None,
            })
        })
    }
}

struct OracleStatus(MetaStatus, Arc<OracleInspector>);

impl Status for OracleStatus {
    fn policies(&self) -> BoxFuture<'_, Option<PolicyStatus>> {
        self.0.policies()
    }

    fn realtime(&self) -> BoxFuture<'_, Option<RealtimeStatus>> {
        Box::pin(async {
            let engine = self.1.0.lock().unwrap();
            Some(RealtimeStatus {
                connections: engine.inspection_connection_count(),
                stream_position: engine.position().to_string(),
            })
        })
    }

    fn revocations_following(&self) -> Option<bool> {
        Some(true)
    }

    fn revoke_all_user_sessions(&self) -> BoxFuture<'_, Result<u64, CanopyError>> {
        self.0.revoke_all_user_sessions()
    }
}

struct Outcome {
    matched: usize,
    pending: Vec<String>,
}

async fn replay(client: &Client, role: &str, users: bool) -> Result<Outcome, String> {
    let fixture = if users { "users" } else { role };
    let file = format!("{}/../../conformance/http/admin/{fixture}.json", env!("CARGO_MANIFEST_DIR"));
    let recorded = parse_json(&std::fs::read_to_string(&file).map_err(|error| format!("{file}: {error}"))?)
        .map_err(|error| error.message().to_owned())?;
    let recorded = if users {
        items(get(&recorded, "captures"))
            .into_iter()
            .find(|capture| string(get(capture, "role")) == role)
            .ok_or("Missing user capture")?
    } else {
        recorded
    };
    let database = format!("canopy_admin_replay_{}", &ObjectId::new().to_hex()[16..]);
    let meta_name = format!("{database}_meta");
    let meta = client.database(&meta_name);
    let auth_name = format!("{database}_auth");
    let epoch = (DateTime::now().timestamp_millis() / 60_000 + 2) * 60_000;
    let now = Arc::new(AtomicI64::new(epoch));
    let clock = {
        let now = Arc::clone(&now);
        Arc::new(move || now.load(Ordering::SeqCst)) as canopy_control::Clock
    };
    let advance = |ms: i64| now.fetch_add(ms, Ordering::SeqCst);

    client
        .database(&database)
        .collection::<Document>("notes")
        .insert_one(doc! { "_id": "seed", "title": "Seed note", "secret": FIXTURE_SECRET })
        .await
        .map_err(|error| error.to_string())?;
    canopy_migrations::migrate(&meta, canopy_migrations::MigrationOptions::default())
        .await
        .map_err(|error| error.message().to_owned())?;
    let definitions = vec![
        doc! { "_id": "notes", "kind": "trigger", "url": format!("{ORIGIN}/unused"), "collection": "hook_notes", "operations": ["insert"] },
        doc! { "_id": "nightly", "kind": "schedule", "url": format!("{ORIGIN}/unused"), "cron": "* * * * *" },
    ];
    let mut hook_options = canopy_webhooks::Options::new(
        "whsec_Zml4dHVyZSB3ZWJob29rIHNlY3JldA==".to_owned(),
        "oracle".to_owned(),
    );
    hook_options.now = Arc::clone(&clock);
    let webhooks = Arc::new(
        canopy_webhooks::Webhooks::new(meta.clone(), hook_options, definitions.clone())
            .map_err(|error| error.message().to_owned())?,
    );
    let mut options = ControlOptions::new(client.clone(), &database, &meta_name, Environment::Development);
    options.public_url = Some(ORIGIN.to_owned());
    options.master_key = Some("m".repeat(48));
    options.now = Arc::clone(&clock);
    options.auth_providers = builtin_providers(&BuiltinMethods {
        email_password: true,
        magic_link: true,
        email_otp: true,
        anonymous: false,
        social: Vec::new(),
        oidc: Vec::new(),
    });
    options.webhooks = Some(WebhookAdmin { webhooks: Arc::clone(&webhooks), definitions });
    options.services.templates =
        Some(Arc::new(TemplateRoutes::new(&meta, "Fixture app".into(), Arc::clone(&clock))));
    options.services.policies =
        Some(Arc::new(PolicyRoutes::new(&meta, &client.database(&database), Arc::clone(&clock))));
    let http_client = reqwest::Client::builder().build().map_err(|error| error.to_string())?;
    let auth = canopy_auth::Authenticator::new(None, None, Vec::new(), http_client)?;
    let data =
        Arc::new(DataRoutes::new(client.clone(), &database, &meta_name, Arc::clone(&clock)).with_graphql(
            auth,
            canopy_graphql::endpoint::GraphqlOptions::default(),
            canopy_data::ReadLimits::default(),
        ));
    options.services.data = Some(data.clone());
    let set = canopy_mongo::load_policies(&meta).await.map_err(|error| error.message().to_owned())?;
    let mut engine = canopy_engine::Engine::new(
        canopy_engine::Config { node_id: "oracle".into(), ..Default::default() },
        set,
    );
    engine.enable_inspection(epoch as u64, None);
    let inspector = Arc::new(OracleInspector(std::sync::Mutex::new(engine)));
    let revocations = canopy_auth::Revocations::new(&meta);
    let _revocation_stream = revocations.start().await.map_err(|error| error.to_string())?;
    options.status = Arc::new(OracleStatus(MetaStatus::new(&meta), inspector.clone()));
    options.services.realtime = Some(Arc::new(RealtimeRoutes::new(
        inspector.clone(),
        Some(Arc::new(
            ViewSigner::new(options.master_key.as_deref()).map_err(|error| error.message().to_owned())?,
        )),
        Some("pk_fixture".into()),
        meta.clone(),
        Arc::clone(&clock),
    )));
    let mut stream = client
        .database(&database)
        .watch()
        .pipeline([doc! {
            "$match": { "operationType": "insert", "ns.coll": "notes", "documentKey._id": "write" }
        }])
        .await
        .map_err(|error| error.to_string())?
        .with_type::<RawDocumentBuf>();
    let keys = SigningKeyRoutes::new(
        client.database(&auth_name),
        SigningKeyOptions {
            algorithm: SigningAlgorithm::EdDSA,
            interval_ms: 2_592_000_000,
            secret: Some("fixture signing key secret".into()),
        },
        Arc::clone(&clock),
    )
    .map_err(|error| error.message().to_owned())?;
    assert!(keys.tick("oracle", 30_000).await.map_err(|error| error.message().to_owned())?);
    assert!(!keys.tick("other node", 30_000).await.map_err(|error| error.message().to_owned())?);
    options.services.auth_keys = Some(Arc::new(keys));
    let outbox = Arc::new(UserOutbox::default());
    let auth_router = if users {
        let auth = client.database(&auth_name);
        let public_url = url::Url::parse(ORIGIN).map_err(|error| error.to_string())?;
        let auth_options = canopy_authn::server::AuthOptions::new(public_url.clone(), "m".repeat(48));
        let router =
            canopy_authn::server::AuthRouter::open(auth.clone(), meta.clone(), auth_options, outbox.clone())
                .await
                .map_err(|error| error.message().to_owned())?;
        options.services.users = Some(Arc::new(canopy_control::UserRoutes::new(
            auth,
            meta.clone(),
            canopy_control::UserOptions {
                public_url,
                redirect_origins: Vec::new(),
                min_password_length: 10,
                access_token_ttl_seconds: 600,
            },
            outbox.clone(),
            Arc::clone(&clock),
        )));
        Some(router)
    } else {
        None
    };
    let control = Control::new(options);
    let setup = control
        .create_setup_token()
        .await
        .map_err(|error| error.message().to_owned())?
        .ok_or("No setup token")?;
    webhooks.catch_up().await.map_err(|error| error.message().to_owned())?;
    let fixture = |id: &str| {
        doc! {
            "_id": id, "hook": "notes", "kind": "trigger", "body": "{}", "attempts": 3,
            "createdAt": DateTime::from_millis(epoch), "failedAt": DateTime::from_millis(epoch), "lastError": "fixture failure",
        }
    };
    meta.collection::<Document>("webhook_dead_letters")
        .insert_many([fixture("fixture-retry"), fixture("fixture-discard")])
        .await
        .map_err(|error| error.to_string())?;

    let setup_hash = {
        let digest = ring::digest::digest(&ring::digest::SHA256, setup.as_bytes());
        canopy_protocol::hex(digest.as_ref())
    };
    let normalizer = Normalizer::new(
        epoch,
        vec![
            (meta_name.clone(), "<meta>".to_owned()),
            (database.clone(), "<database>".to_owned()),
            (setup.clone(), "<setup-token>".to_owned()),
            (setup_hash.clone(), "<setup-token-hash>".to_owned()),
        ],
    );
    let mut bindings = Bindings::default();
    bindings.bind("<setup-token>", &setup);
    bindings.bind("<setup-token-hash>", &setup_hash);
    bindings.bind("<meta>", &meta_name);
    bindings.bind("<database>", &database);
    bindings.bind("<secret:documents>", FIXTURE_SECRET);

    if users {
        let invalid_hash = if role == "owner" { "<stored-secret:5>" } else { "<stored-secret:10>" };
        bindings.bind(invalid_hash, "nope");
    }
    let mut previous: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut matched = 0;
    let mut pending = Vec::new();
    let mut failures = Vec::new();
    for step in items(get(&recorded, "steps")) {
        let id = string(get(&step, "id"));
        if id == "users-list"
            && let Some(router) = &auth_router
        {
            let mut first_session = None;
            for _ in 0..2 {
                advance(100);
                let mut sign_in = Request::new("POST", "/auth/v1/sign-in/email")
                    .with_header("content-type", "application/json")
                    .with_header("origin", ORIGIN)
                    .with_body(
                        br#"{"email":"Fixture.User@Example.test","password":"app user fixture password 1"}"#,
                    );
                sign_in.client_address = Some(PEER.into());
                let response = router.handle_endpoint_at(&sign_in, now.load(Ordering::SeqCst)).await;
                if response.status != 200 {
                    return Err(format!(
                        "Fixture sign in: {} {}",
                        response.status,
                        String::from_utf8_lossy(&response.body)
                    ));
                }
                if first_session.is_none() {
                    let database = client.database(&auth_name);
                    let session = database
                        .collection::<Document>("sessions")
                        .find_one(doc! {})
                        .await
                        .map_err(|error| error.to_string())?
                        .ok_or("Missing fixture session")?;
                    first_session =
                        Some(session.get_object_id("_id").map_err(|error| error.to_string())?.to_hex());
                }
            }
            let revoke = items(get(&recorded, "steps"))
                .into_iter()
                .find(|step| string(get(step, "id")) == "user-session-revoke")
                .ok_or("Missing session revoke step")?;
            let path = string(get(get(&revoke, "request"), "target"));
            let sid = path.rsplit('/').next().ok_or("Missing session placeholder")?;
            bindings.bind(sid, &first_session.ok_or("Missing fixture session id")?);
            previous = snapshot(&meta, &normalizer).await;
        }
        if id == "login-cookie" {
            advance(30_000);
            let secret = base32_decode(bindings.values.get("<secret:setup-claim>").ok_or("No setup secret")?)
                .ok_or("Bad secret")?;
            bindings.bind("<totp-code:cookie>", &totp(&secret, epoch + 30_000, TotpOptions::default()));
        }
        if id == "realtime-lag-after-insert" {
            inspector.0.lock().unwrap().sample_inspection(now.load(Ordering::SeqCst) as u64);
        }
        advance(100);
        if id == "realtime-stats" || id == "doctor" {
            let set = canopy_mongo::load_policies(&meta).await.map_err(|error| error.message().to_owned())?;
            inspector.0.lock().unwrap().set_policies(set, now.load(Ordering::SeqCst) as u64);
        }
        if id == "realtime-events-after-insert" {
            let raw = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
                .await
                .map_err(|error| error.to_string())?
                .ok_or("Fixture change stream ended")?
                .map_err(|error| error.to_string())?;
            let Some(canopy_engine::Normalized::Data(event)) = canopy_engine::normalize(raw.as_bytes())
            else {
                return Err("Could not normalize the fixture insert".into());
            };
            inspector.0.lock().unwrap().events(vec![event], now.load(Ordering::SeqCst) as u64);
        }
        let request = get(&step, "request");
        let target = string(get(request, "target"));
        let group = if users { None } else { delegated(&target) };
        let resolved_target = bindings.resolve(&target, epoch);
        let mut headers = Vec::new();
        let mut unresolved = resolved_target.is_none();
        for (name, value) in entries(get(request, "headers")) {
            match bindings.resolve(&string(&value), epoch) {
                Some(value) => headers.push((name, value)),
                None => unresolved = true,
            }
        }
        let body = match get(request, "body") {
            Json::String(text) => {
                let resolved = bindings.resolve(text, epoch);
                unresolved |= resolved.is_none();
                resolved
            }
            _ => None,
        };
        if unresolved {
            match group {
                Some(group) => {
                    pending.push(format!("{role} {id} ({group}: depends on an earlier pending step)"));
                    continue;
                }
                None => {
                    return Err(format!("{role} {id}: the request uses a value no earlier step produced"));
                }
            }
        }
        let mut http = Request::new(string(get(request, "method")), resolved_target.unwrap_or_default());
        http.headers = headers;
        http.headers.push(("host".to_owned(), HOST.to_owned()));
        if let Some(body) = body {
            http = http.with_body(body.into_bytes());
        }
        let response = control.fetch(&http, Some(PEER)).await;

        let expected = get(&step, "response");
        let mut problems = Vec::new();
        let mut next = bindings.clone();
        #[allow(clippy::cast_possible_truncation)]
        let status = match get(expected, "status") {
            Json::Number(status) => *status as u16,
            _ => 0,
        };
        if status != response.status {
            problems.push(format!("status {} instead of {status}", response.status));
        }
        let mut actual_headers: BTreeMap<String, String> = BTreeMap::new();
        let mut cookies = Vec::new();
        for (name, value) in &response.headers {
            let name = name.to_ascii_lowercase();
            if name == "set-cookie" {
                cookies.push(normalizer.apply(value));
            } else {
                actual_headers.insert(name, normalizer.apply(value));
            }
        }
        let expected_headers: BTreeMap<String, String> = entries(get(expected, "headers"))
            .into_iter()
            .map(|(name, value)| (name, string(&value)))
            .collect();
        if expected_headers.keys().collect::<Vec<_>>() != actual_headers.keys().collect::<Vec<_>>() {
            problems.push(format!(
                "headers {:?} instead of {:?}",
                actual_headers.keys(),
                expected_headers.keys()
            ));
        } else {
            for (name, value) in &expected_headers {
                match next.unify(value, &actual_headers[name]) {
                    Ok(bound) => next = bound,
                    Err(error) => problems.push(format!("header {name}: {error}")),
                }
            }
        }
        let expected_cookies: Vec<String> = items(get(expected, "cookies")).iter().map(string).collect();
        for (index, cookie) in expected_cookies.iter().enumerate() {
            match cookies.get(index).map(|actual| next.unify(cookie, actual)) {
                Some(Ok(bound)) => next = bound,
                Some(Err(error)) => problems.push(format!("cookie {index}: {error}")),
                None => problems.push(format!("cookie {index} missing")),
            }
        }
        if cookies.len() > expected_cookies.len() {
            problems.push(format!("extra cookies {cookies:?}"));
        }
        let actual_body = normalizer.apply(&String::from_utf8_lossy(&response.body));
        let expected_body = string(get(expected, "body"));
        match next.unify(&expected_body, &actual_body) {
            Ok(bound) => next = bound,
            Err(error) => problems.push(format!("body: {error}")),
        }

        let state = snapshot(&meta, &normalizer).await;
        let expected_state = entries(get(&step, "state"));
        for name in COLLECTIONS {
            let before = previous.get(name).cloned().unwrap_or_default();
            let after = state.get(name).cloned().unwrap_or_default();
            let removed: Vec<String> = before.iter().filter(|doc| !after.contains(doc)).cloned().collect();
            let written: Vec<String> = after.iter().filter(|doc| !before.contains(doc)).cloned().collect();
            let change = expected_state.iter().find(|(key, _)| key == name).map(|(_, change)| change.clone());
            let wanted_removed: Vec<String> = change
                .as_ref()
                .map(|c| items(get(c, "removed")).iter().map(string).collect())
                .unwrap_or_default();
            let wanted_written: Vec<String> = change
                .as_ref()
                .map(|c| items(get(c, "written")).iter().map(string).collect())
                .unwrap_or_default();
            for (kind, wanted, actual) in
                [("removed", wanted_removed, removed), ("written", wanted_written, written)]
            {
                match next.unify_all(&wanted, &actual) {
                    Ok(bound) => next = bound,
                    Err(error) => problems.push(format!("{name} {kind}: {error}")),
                }
            }
        }
        previous = state;

        if problems.is_empty() {
            matched += 1;
            bindings = next;
        } else if let Some(group) = group {
            pending.push(format!("{role} {id} ({group})"));
        } else {
            failures.push(format!("{role} {id}:\n    {}", problems.join("\n    ")));
            bindings = next;
        }
        if problems.is_empty() || group.is_none() {
            if id == "setup-claim" {
                let secret =
                    base32_decode(bindings.values.get("<secret:setup-claim>").ok_or("No setup secret")?)
                        .ok_or("Bad secret")?;
                bindings.bind("<totp-code:setup>", &totp(&secret, epoch, TotpOptions::default()));
            }
            if id == "totp-enroll"
                && let Some(secret) =
                    bindings.values.get("<secret:totp-enroll>").and_then(|text| base32_decode(text))
            {
                bindings.bind(
                    "<totp-code:enrollment>",
                    &totp(&secret, now.load(Ordering::SeqCst), TotpOptions::default()),
                );
            }
        }
    }
    if !users
        && role == "owner"
        && let Err(error) = check_view_as(&data, &client.database(&database), &meta).await
    {
        failures.push(error);
    }
    for name in [&database, &meta_name, &auth_name] {
        let _ = client.database(name).drop().await;
    }
    if failures.is_empty() { Ok(Outcome { matched, pending }) } else { Err(failures.join("\n")) }
}

async fn check_view_as(data: &DataRoutes, app: &Database, meta: &Database) -> Result<(), String> {
    use canopy_protocol::ejson::stringify;
    use canopy_protocol::{ErrorCode, Value};
    meta.collection::<Document>("policies")
        .insert_one(doc! {
            "_id": "restricted", "exposed": true, "realtime": false,
            "policies": [{
                "name": "read own", "kind": "permissive", "ops": ["read"], "roles": ["authenticated"],
                "using": r#"{"owner":{"$auth":"sub"}}"#,
            }],
            "fields": { "read": { "default": { "omit": ["private"] } } },
        })
        .await
        .map_err(|error| error.to_string())?;
    app.collection::<Document>("restricted")
        .insert_many([
            doc! { "_id": "mine", "owner": "alice", "private": "visible document private field" },
            doc! { "_id": "theirs", "owner": "bob", "private": "other document private field" },
        ])
        .await
        .map_err(|error| error.to_string())?;
    let mut call = Call {
        route: "GET collections/:collection/documents".to_owned(),
        params: vec![("collection".to_owned(), "restricted".to_owned())],
        query: vec![("as".to_owned(), r#"{"user":"alice"}"#.to_owned())],
        headers: Vec::new(),
        body: None,
        role: AdminRole::Owner,
        production: false,
        actor: Document::new(),
        origin: Document::new(),
    };
    let reply = data.serve(&call).await.map_err(|error| error.message().to_owned())?;
    let Some(Value::Document(body)) = reply.body else {
        return Err("Expected a view as response".to_owned());
    };
    let actual = stringify(body.get("data").ok_or("Missing view as documents")?)
        .map_err(|error| error.message().to_owned())?;
    assert_eq!(actual, r#"[{"_id":"mine","owner":"alice"}]"#);
    call.route = "GET collections/:collection/documents/:id".to_owned();
    call.params.push(("id".to_owned(), "theirs".to_owned()));
    assert_eq!(
        data.serve(&call).await.expect_err("The other document must be hidden").code(),
        ErrorCode::NotFound
    );

    call.route = "POST graphql".to_owned();
    call.body = Some(
        canopy_protocol::ejson::parse(
            r#"{"query":"{ restricted { nodes { _id owner } } }","as":{"user":"alice"}}"#,
            canopy_protocol::ejson::DecodeOptions::default(),
        )
        .map_err(|error| error.message().to_owned())?,
    );
    let reply = data.serve(&call).await.map_err(|error| error.message().to_owned())?;
    let actual =
        stringify(&reply.body.ok_or("Missing GraphQL body")?).map_err(|error| error.message().to_owned())?;
    assert_eq!(actual, r#"{"data":{"restricted":{"nodes":[{"_id":"mine","owner":"alice"}]}}}"#);

    call.route = "GET openapi".to_owned();
    call.query.clear();
    let reply = data.serve(&call).await.map_err(|error| error.message().to_owned())?;
    let body = reply.body.ok_or("Missing OpenAPI body")?;
    let spec = stringify(&body).map_err(|error| error.message().to_owned())?;
    assert!(spec.contains("/rest/v1/restricted"));
    assert!(spec.contains("read own"));
    assert!(!spec.contains("$auth"));
    assert!(!spec.contains("\"private\""));
    assert!(!spec.contains("restricted.Insert"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replays_the_typescript_admin_oracle() -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the admin oracle replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await.map_err(|error| error.to_string())?;
    let mut failures = Vec::new();
    for role in ROLE_NAMES {
        match replay(&client, role, false).await {
            Ok(outcome) => {
                eprintln!("{role}: {} steps matched, {} pending", outcome.matched, outcome.pending.len());
                for step in outcome.pending {
                    eprintln!("  pending {step}");
                }
            }
            Err(error) => failures.push(error),
        }
    }
    if failures.is_empty() { Ok(()) } else { Err(failures.join("\n")) }
}

#[derive(Default)]
struct UserOutbox(std::sync::Mutex<Vec<(canopy_mail::EmailKind, String, String)>>);

impl canopy_authn::server::AuthMail for UserOutbox {
    fn send<'a>(
        self: Arc<Self>,
        kind: canopy_mail::EmailKind,
        recipient: canopy_mail::Recipient<'a>,
    ) -> BoxFuture<'a, ()> {
        self.0.lock().unwrap().push((kind, recipient.email.into(), recipient.url.unwrap_or_default().into()));
        Box::pin(std::future::ready(()))
    }
}

#[tokio::test]
async fn replays_the_typescript_admin_users_oracle() -> Result<(), String> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the admin users oracle replay because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await.map_err(|error| error.to_string())?;
    let mut matched = 0;
    let mut failures = Vec::new();
    for role in ROLE_NAMES {
        match replay(&client, role, true).await {
            Ok(outcome) => {
                assert!(outcome.pending.is_empty());
                matched += outcome.matched;
            }
            Err(error) => failures.push(error),
        }
    }
    if !failures.is_empty() {
        return Err(failures.join("\n"));
    }
    assert_eq!(matched, 204);
    Ok(())
}
