//! The handlers of the routes the control plane serves itself: setup, login and the own account, admins,
//! admin API tokens, API keys, the doctor, the audit and request logs, settings, the danger zone and the
//! webhook queue.

use canopy_http::Response;
use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, doc};
use canopy_protocol::ejson::js_string_to_number;
use canopy_protocol::{CanopyError, ErrorCode, Value};
use futures_util::TryStreamExt as _;

use crate::accounts::{AdminChanges, Transport};
use crate::api::{Context, Native, reasoned, respond};
use crate::api_keys::KeyKind;
use crate::core::{err, js_bson, mongo, text};
use crate::http::{CSRF_COOKIE, SESSION_COOKIE, empty, set_cookie};
use crate::rbac::{AdminRole, Permission, REPORTED, ROLE_NAMES, can};
use crate::schema::{Schema, integer, optional, string};
use crate::tokens::token_document;
use crate::{Control, Environment};

fn field<'a>(body: &'a Option<Value>, key: &str) -> Option<&'a Value> {
    match body {
        Some(Value::Document(document)) => document.get(key),
        _ => None,
    }
}

fn field_text<'a>(body: &'a Option<Value>, key: &str) -> Option<&'a str> {
    field(body, key).and_then(Value::as_str)
}

fn field_number(body: &Option<Value>, key: &str) -> Option<f64> {
    field(body, key).and_then(crate::schema::js_number)
}

fn validate(body: &Option<Value>, shape: Vec<(&'static str, Schema)>) -> Result<(), CanopyError> {
    Schema::Object(shape).check(body.as_ref(), "")
}

fn roles() -> Schema {
    Schema::OneOf(&ROLE_NAMES)
}

/// `Number(text)` with JavaScript's parsing, and a fallback for values that are not finite.
fn js_number_or(text: Option<&str>, fallback: f64) -> f64 {
    match text {
        None => fallback,
        Some(text) => js_string_to_number(text).filter(|number| number.is_finite()).unwrap_or(fallback),
    }
}

/// The `scheme://host[:port]` of a URL, as `new URL(url).origin` gives it.
fn url_origin(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return "invalid".to_owned() };
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host).to_ascii_lowercase();
    let host = match (scheme.as_str(), host.rsplit_once(':')) {
        ("https", Some((name, "443"))) | ("http", Some((name, "80")))
            if !name.ends_with(']') || name.contains('[') =>
        {
            name.to_owned()
        }
        _ => host,
    };
    if host.is_empty() { "invalid".to_owned() } else { format!("{scheme}://{host}") }
}

pub(crate) async fn serve(
    control: &Control,
    context: &Context<'_>,
    native: Native,
) -> Result<Response, CanopyError> {
    match native {
        Native::SetupStatus => respond(doc! { "claimed": control.accounts.has_owner().await? }, 200),
        Native::SetupClaim => setup_claim(control, context).await,
        Native::Login => login(control, context).await,
        Native::Logout => logout(control, context).await,
        Native::Me => me(control, context),
        Native::MePassword => {
            let body = context.body()?;
            validate(&body, vec![("current", string(1, 1024)), ("next", string(1, 1024))])?;
            let (current, next) = (
                field_text(&body, "current").unwrap_or_default(),
                field_text(&body, "next").unwrap_or_default(),
            );
            control.accounts.change_password(context.session()?, current, next, &context.origin).await?;
            Ok(empty(204))
        }
        Native::MeTotp => {
            respond(control.accounts.enroll_totp(context.session()?, &context.origin).await?, 201)
        }
        Native::MeTotpConfirm => {
            let body = context.body()?;
            validate(&body, vec![("code", string(1, 12))])?;
            control
                .accounts
                .confirm_totp(
                    context.session()?,
                    field_text(&body, "code").unwrap_or_default(),
                    &context.origin,
                )
                .await?;
            Ok(empty(204))
        }
        Native::Admins => {
            let data: Vec<Bson> = control
                .accounts
                .list()
                .await?
                .iter()
                .map(|user| Bson::Document(user.to_document()))
                .collect();
            respond(doc! { "data": data }, 200)
        }
        Native::AdminCreate => {
            let body = context.body()?;
            validate(
                &body,
                vec![("email", string(3, 320)), ("role", roles()), ("name", optional(string(0, 200)))],
            )?;
            let role = field_text(&body, "role").and_then(AdminRole::parse).unwrap_or(AdminRole::Viewer);
            let created = control
                .accounts
                .create(
                    context.session()?,
                    field_text(&body, "email").unwrap_or_default(),
                    role,
                    field_text(&body, "name"),
                    &context.origin,
                )
                .await?;
            respond(created, 201)
        }
        Native::AdminUpdate => {
            let body = context.body()?;
            validate(
                &body,
                vec![
                    ("role", optional(roles())),
                    ("disabled", optional(Schema::Boolean)),
                    ("name", optional(string(0, 200))),
                ],
            )?;
            let changes = AdminChanges {
                role: field_text(&body, "role").and_then(AdminRole::parse),
                disabled: match field(&body, "disabled") {
                    Some(Value::Bool(flag)) => Some(*flag),
                    _ => None,
                },
                name: field_text(&body, "name").map(str::to_owned),
            };
            let user = control
                .accounts
                .update(context.session()?, context.param("id"), &changes, &context.origin)
                .await?;
            respond(doc! { "user": user.to_document() }, 200)
        }
        Native::AdminResetTotp => {
            let user = control
                .accounts
                .reset_totp(context.param("id"), &context.actor, Some(context.session()?), &context.origin)
                .await?;
            respond(doc! { "user": user.to_document() }, 200)
        }
        Native::AdminRemove => {
            control.accounts.remove(context.session()?, context.param("id"), &context.origin).await?;
            Ok(empty(204))
        }
        Native::Tokens => {
            let all = context.query("all") == Some("true");
            if all {
                context.require(control, Permission::AdminsRead)?;
            }
            let session = context.session()?;
            let data = control.tokens.list(if all { None } else { Some(session.user.id.as_str()) }).await?;
            respond(doc! { "data": data }, 200)
        }
        Native::TokenCreate => token_create(control, context).await,
        Native::TokenRevoke => {
            let session = context.session()?;
            let role = session.user.role;
            let revoked = control
                .tokens
                .revoke(
                    session,
                    context.param("id"),
                    can(role, Permission::AdminsManage, control.production()),
                    can(role, Permission::AdminsManageOwners, control.production()),
                    &context.origin,
                )
                .await?;
            respond(revoked, 200)
        }
        Native::ApiKeys => respond(doc! { "data": control.keys.list().await? }, 200),
        Native::ApiKeyCreate => {
            let body = context.body()?;
            validate(
                &body,
                vec![("kind", Schema::OneOf(&["publishable", "secret"])), ("name", string(1, 200))],
            )?;
            let kind = field_text(&body, "kind").and_then(KeyKind::parse).unwrap_or(KeyKind::Publishable);
            if kind == KeyKind::Secret {
                context.require(control, Permission::KeysSecret)?;
            }
            let name = field_text(&body, "name").unwrap_or_default();
            let created = control.keys.create(kind, name, &context.actor.id).await?;
            let info =
                created.get_document("info").map_err(|_| err(ErrorCode::Internal, "Missing key info"))?;
            let entry = doc! {
                "action": "key.create",
                "target": { "keyId": text(info, "id"), "kind": kind.as_str(), "name": name, "prefix": text(info, "prefix") },
            };
            control.audit.record(context.entry(entry)).await?;
            context.mark_audited();
            respond(created, 201)
        }
        Native::ApiKeyRevoke => {
            let id = context.param("id");
            let existing =
                control.keys.get(id).await?.ok_or_else(|| err(ErrorCode::NotFound, "No such API key"))?;
            if text(&existing, "kind") == Some("secret") {
                context.require(control, Permission::KeysSecret)?;
            }
            let revoked = control.keys.revoke(id, &context.actor.id).await?;
            let entry = doc! {
                "action": "key.revoke",
                "target": {
                    "keyId": id, "kind": text(&existing, "kind"), "name": text(&existing, "name"), "prefix": text(&existing, "prefix"),
                },
            };
            control.audit.record(context.entry(entry)).await?;
            context.mark_audited();
            respond(revoked, 200)
        }
        Native::AuthProviders => respond(control.auth_providers.clone(), 200),
        Native::Doctor => doctor(control).await,
        Native::Audit => {
            let limit = js_number_or(context.query("limit"), 100.0);
            let entries = control
                .audit
                .list(context.query("action"), context.query("actor"), context.query("before"), limit)
                .await?;
            let next = entries
                .last()
                .and_then(|entry| entry.get_object_id("_id").ok())
                .map_or(Bson::Null, |id| Bson::String(id.to_hex()));
            respond(doc! { "data": entries, "next": next }, 200)
        }
        Native::Logs => logs(control, context).await,
        Native::Settings => respond(control.settings.get().await?, 200),
        Native::SettingsUpdate => settings_update(control, context).await,
        Native::RevokeAll => {
            confirm(context, "revoke all sessions")?;
            let users = control.status.revoke_all_user_sessions().await?;
            let admins = control.accounts.end_all_sessions().await?;
            #[allow(clippy::cast_precision_loss)]
            let entry = doc! {
                "action": "danger.revoke_all_sessions",
                "details": { "userSessions": js_bson(users as f64), "adminSessions": js_bson(admins as f64) },
            };
            control.audit.record(context.entry(entry)).await?;
            context.mark_audited();
            Ok(empty(204))
        }
        Native::RotateMasterKey => {
            confirm(context, "rotate master key")?;
            if !control.accounts.secrets().encrypting() {
                return Err(err(
                    ErrorCode::ValidationFailed,
                    "There is no master key: set CANOPY_MASTER_KEY first",
                ));
            }
            let resealed = control.accounts.reseal_secrets().await?;
            #[allow(clippy::cast_precision_loss)]
            let entry = doc! { "action": "danger.rotate_master_key", "details": { "resealed": js_bson(resealed as f64) } };
            control.audit.record(context.entry(entry)).await?;
            context.mark_audited();
            Ok(empty(204))
        }
        Native::Webhooks => webhooks(control).await,
        Native::DeadLetters => {
            let hooks = hooks(control)?;
            let limit = context.query("limit");
            if let Some(limit) = limit
                && (!(1..=3).contains(&limit.len()) || !limit.bytes().all(|byte| byte.is_ascii_digit()))
            {
                return Err(err(ErrorCode::ValidationFailed, "limit must be a number from 1 to 500"));
            }
            let limit = limit.and_then(|limit| limit.parse::<i64>().ok()).unwrap_or(50);
            let data = hooks.webhooks.dead_letters(context.query("hook"), limit).await?;
            respond(doc! { "data": data }, 200)
        }
        Native::DeadLetterRetry => {
            let id = context.param("id");
            if !hooks(control)?.webhooks.retry(id).await? {
                return Err(err(ErrorCode::NotFound, "No such dead letter"));
            }
            control
                .audit
                .record(context.entry(doc! { "action": "webhooks.retry", "target": { "delivery": id } }))
                .await?;
            context.mark_audited();
            respond(doc! { "id": id, "requeued": true }, 200)
        }
        Native::DeadLetterDiscard => {
            let id = context.param("id");
            if !hooks(control)?.webhooks.discard(id).await? {
                return Err(err(ErrorCode::NotFound, "No such dead letter"));
            }
            control
                .audit
                .record(context.entry(doc! { "action": "webhooks.discard", "target": { "delivery": id } }))
                .await?;
            context.mark_audited();
            respond(doc! { "id": id, "deleted": true }, 200)
        }
        Native::WebhookRun => {
            let name = context.param("name");
            let Some(id) = hooks(control)?.webhooks.run(name).await? else {
                return Err(err(ErrorCode::NotFound, format!("No schedule is named {name}")));
            };
            let entry =
                doc! { "action": "webhooks.run", "target": { "schedule": name }, "details": { "id": &id } };
            control.audit.record(context.entry(entry)).await?;
            context.mark_audited();
            respond(doc! { "id": id }, 202)
        }
    }
}

fn confirm(context: &Context<'_>, phrase: &str) -> Result<(), CanopyError> {
    if context.request.header("x-canopy-confirm").as_deref() == Some(phrase) {
        return Ok(());
    }
    Err(err(ErrorCode::ValidationFailed, format!("Confirm with the phrase \"{phrase}\" in x-canopy-confirm"))
        .with_details(reasoned(None, "confirmation")))
}

async fn setup_claim(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    let body = context.body()?;
    validate(
        &body,
        vec![
            ("token", string(1, 200)),
            ("email", string(3, 320)),
            ("password", string(1, 1024)),
            ("name", optional(string(0, 200))),
        ],
    )?;
    let claimed = control
        .accounts
        .claim(
            field_text(&body, "token").unwrap_or_default(),
            field_text(&body, "email").unwrap_or_default(),
            field_text(&body, "password").unwrap_or_default(),
            field_text(&body, "name"),
            &context.origin,
        )
        .await?;
    respond(claimed, 201)
}

async fn login(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    let body = context.body()?;
    validate(
        &body,
        vec![
            ("email", string(1, 320)),
            ("password", string(1, 1024)),
            ("totp", optional(string(1, 12))),
            ("transport", optional(Schema::OneOf(&["cookie", "bearer"]))),
        ],
    )?;
    let transport =
        if field_text(&body, "transport") == Some("bearer") { Transport::Bearer } else { Transport::Cookie };
    let result = control
        .accounts
        .login(
            field_text(&body, "email").unwrap_or_default(),
            field_text(&body, "password").unwrap_or_default(),
            field_text(&body, "totp"),
            &context.origin,
            transport,
        )
        .await?;
    let mut payload = doc! {
        "user": result.user.to_document(),
        "csrfToken": &result.csrf_token,
        "expiresAt": DateTime::from_millis(result.expires_at),
    };
    if transport == Transport::Bearer {
        payload.insert("token", &result.token);
    }
    let mut response = respond(payload, 200)?;
    if transport == Transport::Cookie {
        #[allow(clippy::cast_precision_loss)]
        let max_age = (result.expires_at - control.now()) as f64 / 1000.0;
        response
            .headers
            .push(("set-cookie".to_owned(), set_cookie(SESSION_COOKIE, &result.token, max_age, true)));
        response
            .headers
            .push(("set-cookie".to_owned(), set_cookie(CSRF_COOKIE, &result.csrf_token, max_age, false)));
    }
    Ok(response)
}

async fn logout(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    control.accounts.logout(context.session()?, &context.origin).await?;
    let mut response = empty(204);
    response.headers.push(("set-cookie".to_owned(), set_cookie(SESSION_COOKIE, "", 0.0, true)));
    response.headers.push(("set-cookie".to_owned(), set_cookie(CSRF_COOKIE, "", 0.0, false)));
    Ok(response)
}

fn me(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    let session = context.session()?;
    let mut out = doc! {
        "user": session.user.to_document(),
        "environment": control.environment.as_str(),
        "expiresAt": session.expires_at.map_or(Bson::Null, |at| Bson::DateTime(DateTime::from_millis(at))),
    };
    if let Some(token) = &session.token {
        out.insert("token", token_document(token));
    }
    let permissions: Vec<&str> = REPORTED
        .iter()
        .filter(|(permission, _)| can(session.user.role, *permission, control.production()))
        .map(|(_, name)| *name)
        .collect();
    out.insert("permissions", permissions);
    respond(out, 200)
}

async fn token_create(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    let body = context.body()?;
    validate(
        &body,
        vec![
            ("name", string(1, 200)),
            ("role", optional(roles())),
            ("expiresInDays", optional(integer(1, 3650))),
        ],
    )?;
    let session = context.session()?;
    let name = field_text(&body, "name").unwrap_or_default();
    let role = field_text(&body, "role").and_then(AdminRole::parse).unwrap_or(session.user.role);
    if !role.at_most(session.user.role) {
        let entry = doc! { "action": "admin_token.create", "outcome": "denied", "target": { "name": name, "role": role.as_str() } };
        control.audit.record(context.entry(entry)).await?;
        context.mark_audited();
        return Err(err(
            ErrorCode::Forbidden,
            format!(
                "Your role ({}) may not create a token for the {} role",
                session.user.role.as_str(),
                role.as_str()
            ),
        ));
    }
    #[allow(clippy::cast_possible_truncation)]
    let days = field_number(&body, "expiresInDays").map(|days| days as i64);
    let created = control.tokens.create(session, name, Some(role), days, &context.origin).await?;
    respond(created, 201)
}

async fn settings_update(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    let body = context.body()?;
    validate(
        &body,
        vec![
            ("auditRetentionDays", optional(Schema::Nullable(Box::new(integer(1, 36_500))))),
            ("requestLogSampleRate", optional(Schema::Number { min: Some(0.0), max: Some(1.0) })),
            ("requestLogRetentionDays", optional(integer(1, 90))),
            ("adminAllowlist", optional(Schema::Array(Box::new(string(1, 64)), 256))),
        ],
    )?;
    let mut patch = Document::new();
    if let Some(Value::Document(fields)) = &body {
        for (key, value) in fields.iter() {
            let converted = match value {
                Value::Null => Bson::Null,
                Value::Array(items) => Bson::Array(
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|item| Bson::String(item.to_owned()))
                        .collect(),
                ),
                other => crate::schema::js_number(other).map_or(Bson::Null, js_bson),
            };
            patch.insert(key, converted);
        }
    }
    if let Ok(rules) = patch.get_array("adminAllowlist") {
        let rules: Vec<String> = rules.iter().filter_map(Bson::as_str).map(str::to_owned).collect();
        if !rules.is_empty() && !crate::settings::address_allowed(context.origin.ip.as_deref(), &rules) {
            return Err(err(
                ErrorCode::ValidationFailed,
                format!(
                    "The allowlist does not include your address ({}), so saving it would lock you out",
                    context.origin.ip.as_deref().unwrap_or("unknown")
                ),
            )
            .with_details(reasoned(Some("adminAllowlist"), "lockout")));
        }
    }
    respond(control.settings.update(patch, context.actor.to_document(), &context.origin).await?, 200)
}

async fn logs(control: &Control, context: &Context<'_>) -> Result<Response, CanopyError> {
    const SURFACES: [&str; 5] = ["rest", "graphql", "auth", "admin", "realtime"];
    let surface = context.query("surface");
    if surface.is_some_and(|surface| !SURFACES.contains(&surface)) {
        return Err(err(
            ErrorCode::ValidationFailed,
            format!("surface must be one of {}", SURFACES.join(", ")),
        ));
    }
    let status = match context.query("status") {
        None => None,
        Some(text) => {
            let bytes = text.as_bytes();
            let class = bytes.len() == 3 && matches!(bytes.first(), Some(b'1'..=b'5'));
            if class && text.ends_with("xx") {
                let base = i32::from(bytes.first().copied().unwrap_or(b'0') - b'0') * 100;
                Some(Bson::Document(doc! { "$gte": base, "$lt": base + 100 }))
            } else if class && text.bytes().all(|byte| byte.is_ascii_digit()) {
                Some(Bson::Int32(text.parse().unwrap_or(0)))
            } else {
                return Err(err(
                    ErrorCode::ValidationFailed,
                    "status must be a code such as 404 or a class such as 5xx",
                ));
            }
        }
    };
    let limit = js_number_or(context.query("limit"), 100.0);
    let entries = control.settings.request_log(surface, status, context.query("before"), limit).await?;
    let next = entries
        .last()
        .and_then(|entry| entry.get_object_id("_id").ok())
        .map_or(Bson::Null, |id| Bson::String(id.to_hex()));
    let current = control.settings.get().await?;
    respond(
        doc! {
            "data": entries,
            "next": next,
            "sampleRate": current.get("requestLogSampleRate").cloned().unwrap_or(Bson::Null),
            "retentionDays": current.get("requestLogRetentionDays").cloned().unwrap_or(Bson::Null),
        },
        200,
    )
}

fn hooks(control: &Control) -> Result<&crate::WebhookAdmin, CanopyError> {
    control.webhooks.as_ref().ok_or_else(|| err(ErrorCode::NotFound, "No trigger or schedule is configured"))
}

async fn counts(
    control: &Control,
    collection: &str,
    filter: Document,
) -> Result<Vec<(String, Bson)>, CanopyError> {
    let mut pipeline = Vec::new();
    if !filter.is_empty() {
        pipeline.push(doc! { "$match": filter });
    }
    pipeline.push(doc! { "$group": { "_id": "$hook", "n": { "$sum": 1 } } });
    let cursor = control.meta.collection::<Document>(collection).aggregate(pipeline).await.map_err(mongo)?;
    let groups: Vec<Document> = cursor.try_collect().await.map_err(mongo)?;
    Ok(groups
        .iter()
        .filter_map(|group| {
            Some((text(group, "_id")?.to_owned(), group.get("n").cloned().unwrap_or(Bson::Int32(0))))
        })
        .collect())
}

async fn webhooks(control: &Control) -> Result<Response, CanopyError> {
    let hooks = hooks(control)?;
    let pending =
        counts(control, "webhook_deliveries", doc! { "status": { "$in": ["pending", "delivering"] } })
            .await?;
    let dead = counts(control, "webhook_dead_letters", Document::new()).await?;
    let count = |list: &[(String, Bson)], name: &str| {
        list.iter().find(|(hook, _)| hook == name).map_or(Bson::Int32(0), |(_, n)| n.clone())
    };
    let mut data = Vec::new();
    for kind in ["trigger", "schedule"] {
        for definition in hooks.definitions.iter().filter(|definition| text(definition, "kind") == Some(kind))
        {
            let name = text(definition, "_id").unwrap_or_default();
            let mut item = doc! {
                "name": name, "kind": kind, "endpoint": url_origin(text(definition, "url").unwrap_or_default()),
            };
            if kind == "trigger" {
                item.insert("collection", definition.get("collection").cloned().unwrap_or(Bson::Null));
                item.insert(
                    "operations",
                    definition.get("operations").cloned().unwrap_or(Bson::Array(Vec::new())),
                );
            } else {
                item.insert("cron", definition.get("cron").cloned().unwrap_or(Bson::Null));
                if let Some(next) = hooks.webhooks.next_fire(name) {
                    item.insert("nextFire", next);
                }
            }
            item.insert("pending", count(&pending, name));
            item.insert("deadLetters", count(&dead, name));
            data.push(item);
        }
    }
    respond(doc! { "data": data }, 200)
}

async fn doctor(control: &Control) -> Result<Response, CanopyError> {
    let mut checks: Vec<Document> = Vec::new();
    let mut add = |name: &str, status: &str, message: String| {
        checks.push(doc! { "name": name, "status": status, "message": message })
    };
    let production = control.production();
    let app = control.client.database(&control.database);
    match (app.run_command(doc! { "hello": 1 }).await, app.run_command(doc! { "buildInfo": 1 }).await) {
        (Ok(hello), Ok(build)) => {
            let version = match build.get("version") {
                Some(Bson::String(version)) => version.clone(),
                Some(other) => other.to_string(),
                None => "undefined".to_owned(),
            };
            add("mongodb", "ok", format!("MongoDB {version}"));
            if let Some(name) = text(&hello, "setName") {
                add("replica-set", "ok", format!("Replica set {name}"));
            } else if text(&hello, "msg") == Some("isdbgrid") {
                add("replica-set", "ok", "Sharded cluster (mongos)".to_owned());
            } else {
                add(
                    "replica-set",
                    "fail",
                    "Change streams and transactions need a replica set or a sharded cluster".to_owned(),
                );
            }
        }
        (Err(error), _) | (_, Err(error)) => add("mongodb", "fail", error.to_string()),
    }
    let pending = canopy_migrations::pending_migrations(&control.meta).await?;
    if pending == 0 {
        add("meta-migrations", "ok", "The meta database is up to date".to_owned());
    } else {
        add("meta-migrations", "fail", format!("{pending} migration(s) pending"));
    }
    if control.accounts.secrets().encrypting() {
        add("master-key", "ok", "Stored secrets are encrypted".to_owned());
    } else {
        add(
            "master-key",
            if production { "fail" } else { "warn" },
            "No master key: stored secrets are not encrypted".to_owned(),
        );
    }
    match &control.admin_listen {
        None => add(
            "admin-listener",
            if production { "warn" } else { "ok" },
            "/admin is served on the public listener; set CANOPY_ADMIN_LISTEN to keep it private".to_owned(),
        ),
        Some(listen) => add("admin-listener", "ok", format!("/admin is served only on {listen}")),
    }
    if let Some(policies) = control.status.policies().await {
        add("policies", "ok", format!("Bundle {}, {} collection(s)", policies.bundle, policies.collections));
    }
    if let Some(realtime) = control.status.realtime() {
        add(
            "realtime",
            "ok",
            format!("{} connection(s), stream at {}", realtime.connections, realtime.stream_position),
        );
    }
    if let Some(following) = control.status.revocations_following() {
        if following {
            add("revocations", "ok", "Sign outs and bans on other nodes apply here at once".to_owned());
        } else {
            add(
                "revocations",
                "fail",
                "Not following other nodes' revocations: their sign outs and bans apply here only once following resumes"
                    .to_owned(),
            );
        }
    }
    for (index, (status, message)) in search(control, &app).await.into_iter().enumerate() {
        add(if index == 0 { "search" } else { "search-index" }, status, message);
    }
    let status = if checks.iter().any(|check| text(check, "status") == Some("fail")) {
        "fail"
    } else if checks.iter().any(|check| text(check, "status") == Some("warn")) {
        "warn"
    } else {
        "ok"
    };
    respond(doc! { "status": status, "environment": control.environment.as_str(), "checks": checks }, 200)
}

/// The search checks of the doctor: whether the deployment runs MongoDB Search, and the state of the search
/// indexes of the collections whose config turns search on.
async fn search(control: &Control, app: &canopy_mongo::mongodb::Database) -> Vec<(&'static str, String)> {
    const SEARCH_NOT_ENABLED: [i32; 2] = [31082, 6047401];
    let unavailable = "Search is not available on this MongoDB deployment; it needs Atlas, an Atlas local deployment or MongoDB Search";
    let names: Vec<String> = if control.search_collections.is_empty() {
        vec!["canopy_search_probe".to_owned()]
    } else {
        control.search_collections.clone()
    };
    let mut ready = 0;
    let mut warnings = Vec::new();
    for name in &names {
        let found = app.collection::<Document>(name).aggregate(vec![doc! { "$listSearchIndexes": {} }]).await;
        let indexes: Result<Vec<Document>, _> = match found {
            Ok(cursor) => cursor.try_collect().await,
            Err(error) => Err(error),
        };
        match indexes {
            Ok(indexes) => {
                if control.search_collections.is_empty() {
                    continue;
                }
                for index in indexes {
                    if index.get_bool("queryable").is_ok_and(|flag| flag) {
                        ready += 1;
                    } else {
                        let status = text(&index, "status").unwrap_or("unknown");
                        warnings.push((
                            "warn",
                            format!(
                                "search index {name}.{} is {status}",
                                text(&index, "name").unwrap_or_default()
                            ),
                        ));
                    }
                }
            }
            Err(error) => {
                let code = match error.kind.as_ref() {
                    canopy_mongo::mongodb::error::ErrorKind::Command(command) => Some(command.code),
                    _ => None,
                };
                let configured = !control.search_collections.is_empty();
                return if code.is_some_and(|code| SEARCH_NOT_ENABLED.contains(&code)) {
                    vec![(if configured { "warn" } else { "ok" }, format!("search: {unavailable}"))]
                } else {
                    vec![(
                        "warn",
                        format!("search: could not be checked: {}", crate::core::mongo(error).message()),
                    )]
                };
            }
        }
    }
    let mut out = vec![(
        "ok",
        format!("search: {} collections, {ready} indexes ready", control.search_collections.len()),
    )];
    out.extend(warnings);
    out
}

impl Environment {
    /// The environment's name.
    pub fn as_str(&self) -> &'static str {
        match self {
            Environment::Development => "development",
            Environment::Production => "production",
            Environment::Test => "test",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_follow_the_url_standard() {
        assert_eq!(url_origin("https://admin.example.test/unused"), "https://admin.example.test");
        assert_eq!(url_origin("HTTPS://Hooks.Example.test:443/x?y"), "https://hooks.example.test");
        assert_eq!(url_origin("http://localhost:8080/x"), "http://localhost:8080");
        assert_eq!(url_origin("http://user:pw@host:80"), "http://host");
        assert_eq!(url_origin("not a url"), "invalid");
    }

    #[test]
    fn numbers_parse_like_javascript_number() {
        assert_eq!(js_number_or(None, 100.0), 100.0);
        assert_eq!(js_number_or(Some("2"), 100.0), 2.0);
        assert_eq!(js_number_or(Some("abc"), 100.0), 100.0);
        assert_eq!(js_number_or(Some(""), 100.0), 0.0);
    }
}
