use std::sync::Arc;

use canopy_authn::{
    passwords::hash_password,
    server::AuthMail,
    users::{id_filter, id_text, metadata},
};
use canopy_mail::{EmailKind, Recipient};
use canopy_mongo::mongodb::{
    ClientSession, Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    options::ReturnDocument,
};
use canopy_protocol::{CanopyError, ErrorCode, Value};

use crate::core::{Abort, collect, err, is_duplicate, mongo, random_url, text, to_value, transaction};
use crate::schema::{Schema, js_length, optional, string};
use crate::{BoxFuture, Call, Clock, Delegate, Reply};

mod imports;

/// Built in app user administration backed by the auth database.
#[derive(Clone)]
pub struct UserRoutes {
    auth: Database,
    meta: Database,
    now: Clock,
    options: Arc<UserOptions>,
    mail: Arc<dyn AuthMail>,
}

/// Settings shared by the app user routes and built in authentication.
pub struct UserOptions {
    /// Base URL of the authentication service.
    pub public_url: url::Url,
    /// Allowed invite redirect origins.
    pub redirect_origins: Vec<String>,
    /// Minimum password length in UTF-16 units.
    pub min_password_length: usize,
    /// Access token lifetime in seconds.
    pub access_token_ttl_seconds: i64,
}

fn invalid(message: impl Into<String>) -> CanopyError {
    err(ErrorCode::ValidationFailed, message)
}

fn missing_user() -> CanopyError {
    err(ErrorCode::NotFound, "No such user")
}

fn conflict() -> CanopyError {
    err(ErrorCode::Conflict, "A user with this email exists")
}

fn email(value: &str) -> Result<String, CanopyError> {
    let value = value.trim().to_lowercase();
    if !value.chars().any(char::is_whitespace)
        && let Some((local, host)) = value.split_once('@')
        && !local.is_empty()
        && !host.contains('@')
        && host.char_indices().any(|(at, ch)| ch == '.' && at > 0 && at + 1 < host.len())
    {
        return Ok(value);
    }
    Err(invalid("Invalid email address"))
}

fn fields() -> Vec<(&'static str, Schema)> {
    vec![
        ("name", optional(string(0, 200))),
        ("emailVerified", optional(Schema::Boolean)),
        ("roles", optional(Schema::Array(Box::new(string(1, 200)), 64))),
        ("appMetadata", optional(Schema::Document)),
        ("userMetadata", optional(Schema::Document)),
    ]
}

fn body(call: &Call, fields: Vec<(&'static str, Schema)>) -> Result<Document, CanopyError> {
    let empty = Value::Document(canopy_protocol::Document::new());
    let value = call.body.as_ref().unwrap_or(&empty);
    Schema::Object(fields).check(Some(value), "")?;
    let Value::Document(value) = value else {
        return Err(invalid("The body must be an object"));
    };
    let bytes = canopy_protocol::bson::encode_document(value)?;
    Document::from_reader(bytes.as_slice()).map_err(|error| err(ErrorCode::Internal, error.to_string()))
}

fn check_roles(input: &Document) -> Result<(), CanopyError> {
    for role in input.get_array("roles").into_iter().flatten().filter_map(Bson::as_str) {
        if ["anon", "authenticated", "service", "public"].contains(&role) {
            return Err(invalid(format!(
                "The role \"{role}\" cannot be assigned; anon, authenticated, service and public are reserved"
            )));
        }
    }
    Ok(())
}

fn public_user(user: &Document) -> Document {
    let anonymous = user.get_bool("isAnonymous").unwrap_or(false);
    let mut view = doc! { "id": user.get("_id").map_or_else(String::new, id_text) };
    if !anonymous && let Some(email) = user.get("email") {
        view.insert("email", email.clone());
    }
    view.insert("emailVerified", user.get_bool("emailVerified").unwrap_or(false));
    if let Some(name) = text(user, "name").filter(|name| !name.is_empty()) {
        view.insert("name", name);
    }
    view.insert("isAnonymous", anonymous);
    let roles = match user.get("roles") {
        Some(Bson::Array(roles)) => roles.clone(),
        Some(Bson::String(roles)) => canopy_protocol::json::parse_json(roles)
            .ok()
            .and_then(|value| match value {
                canopy_protocol::json::Json::Array(items) => Some(
                    items
                        .into_iter()
                        .filter_map(|item| match item {
                            canopy_protocol::json::Json::String(role) => Some(Bson::String(role)),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    view.insert("roles", roles.into_iter().filter(|role| role.as_str().is_some()).collect::<Vec<_>>());
    view.insert("appMetadata", metadata(user, "appMetadata"));
    view.insert("userMetadata", metadata(user, "userMetadata"));
    view.insert("banned", user.get_bool("banned").unwrap_or(false));
    for field in ["banReason", "banExpires", "createdAt", "updatedAt"] {
        if let Some(value) = user.get(field).filter(|value| **value != Bson::Null) {
            view.insert(field, value.clone());
        }
    }
    view
}

fn public_session(session: &Document) -> Document {
    let mut view = doc! {
        "id": session.get("_id").map_or_else(String::new, id_text),
        "userId": session.get("userId").map_or_else(String::new, id_text),
    };
    for field in ["createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent"] {
        if let Some(value) = session.get(field).filter(|value| **value != Bson::Null) {
            view.insert(field, value.clone());
        }
    }
    view
}

fn user_diff(view: &Document) -> Document {
    ["roles", "appMetadata", "email"]
        .into_iter()
        .filter_map(|key| view.get(key).cloned().map(|value| (key.to_owned(), value)))
        .collect()
}

fn date(value: &str) -> Option<DateTime> {
    DateTime::parse_rfc3339_str(value).ok().or_else(|| {
        (value.len() == 10).then(|| DateTime::parse_rfc3339_str(format!("{value}T00:00:00Z")).ok()).flatten()
    })
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn page(value: Option<&str>, default: u32, min: u32, max: u32) -> u32 {
    let number = value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| !value.is_nan() && *value != 0.0)
        .unwrap_or(f64::from(default));
    number.clamp(f64::from(min), f64::from(max)) as u32
}

fn reply(status: u16, document: &Document) -> Result<Reply, CanopyError> {
    Ok(Reply::json(status, to_value(document)?))
}

fn audit(action: &str, id: &str) -> Document {
    doc! { "action": action, "target": { "userId": id } }
}

fn db_failure(error: canopy_mongo::mongodb::error::Error) -> Abort {
    if is_duplicate(&error) { conflict().into() } else { error.into() }
}

fn metadata_fields(input: &mut Document) -> Result<(), CanopyError> {
    for key in ["appMetadata", "userMetadata"] {
        if let Some(Bson::Document(value)) = input.remove(key) {
            let json = canopy_protocol::ejson::stringify(&to_value(&value)?)
                .map_err(|error| err(ErrorCode::Internal, error.to_string()))?;
            input.insert(key, json);
        }
    }
    Ok(())
}

impl UserRoutes {
    /// Creates the app user delegate on the shared auth and metadata databases.
    pub fn new(
        auth: Database,
        meta: Database,
        options: UserOptions,
        mail: Arc<dyn AuthMail>,
        now: Clock,
    ) -> Self {
        Self { auth, meta, now, options: Arc::new(options), mail }
    }

    async fn password(&self, input: &mut Document) -> Result<Option<String>, CanopyError> {
        let Some(Bson::String(password)) = input.remove("password") else { return Ok(None) };
        let min = self.options.min_password_length;
        if !(min..=128).contains(&js_length(&password)) {
            return Err(invalid(format!("Passwords need {min} to 128 characters")));
        }
        tokio::task::spawn_blocking(move || hash_password(&password))
            .await
            .map_err(|error| err(ErrorCode::Internal, error.to_string()))?
            .map(Some)
            .map_err(|error| err(ErrorCode::Internal, error.to_string()))
    }

    async fn get(&self, id: &str) -> Result<Document, CanopyError> {
        self.auth
            .collection("users")
            .find_one(doc! { "_id": id_filter(id) })
            .await
            .map_err(mongo)?
            .ok_or_else(missing_user)
    }

    async fn list(&self, call: &Call) -> Result<Reply, CanopyError> {
        let mut filter = doc! {};
        if let Some(prefix) = call.query("email").filter(|value| !value.is_empty()) {
            filter.insert("email", doc! { "$regex": format!("^{}", regex::escape(&prefix.to_lowercase())) });
        }
        let users = self.auth.collection("users");
        let limit = page(call.query("limit"), 50, 1, 1000);
        let offset = page(call.query("offset"), 0, 0, u32::MAX);
        let found = collect(
            users
                .find(filter.clone())
                .sort(doc! { "createdAt": -1 })
                .skip(u64::from(offset))
                .limit(i64::from(limit))
                .await
                .map_err(mongo)?,
        )
        .await?;
        let total = users.count_documents(filter).await.map_err(mongo)?;
        let total = i64::try_from(total).map_err(|error| err(ErrorCode::Internal, error.to_string()))?;
        reply(200, &doc! { "data": found.iter().map(public_user).collect::<Vec<_>>(), "total": total })
    }

    async fn create(
        &self,
        mut input: Document,
        password: Option<String>,
        mut identities: Vec<Document>,
        now: DateTime,
    ) -> Result<Document, CanopyError> {
        let email = email(input.get_str("email").unwrap_or_default())?;
        check_roles(&input)?;
        metadata_fields(&mut input)?;
        let oid = ObjectId::new();
        let id = oid.to_hex();
        let mut user = doc! {
            "_id": oid, "email": email, "name": "", "emailVerified": false, "createdAt": now, "updatedAt": now,
            "isAnonymous": false, "role": "user", "banned": false, "twoFactorEnabled": false,
            "roles": [], "appMetadata": "{}", "userMetadata": "{}",
        };
        input.remove("email");
        user.extend(input);
        if let Some(password) = password {
            identities.push(doc! { "providerId": "credential", "accountId": &id, "password": password });
        }
        for account in &mut identities {
            account.extend(doc! { "userId": oid, "createdAt": now, "updatedAt": now });
        }
        transaction(self.auth.client(), |session| {
            let (routes, user, accounts, id) = (self.clone(), user.clone(), identities.clone(), id.clone());
            Box::pin(async move {
                routes
                    .auth
                    .collection::<Document>("users")
                    .insert_one(&user)
                    .session(&mut *session)
                    .await
                    .map_err(db_failure)?;
                if !accounts.is_empty() {
                    routes
                        .auth
                        .collection::<Document>("accounts")
                        .insert_many(accounts)
                        .session(&mut *session)
                        .await
                        .map_err(db_failure)?;
                }
                routes.meta.collection::<Document>("audit_log").insert_one(doc! {
                    "action": "auth.sign_up", "actor": { "type": "user", "id": &id },
                    "target": { "type": "user", "id": &id }, "details": { "method": "unknown" }, "at": now,
                }).session(session).await?;
                Ok(user)
            })
        })
        .await
    }

    async fn revoke(
        &self,
        session: &mut ClientSession,
        sub: &str,
        sid: Option<&str>,
        now: DateTime,
    ) -> Result<(), Abort> {
        let mut event = doc! { "kind": if sid.is_some() { "session" } else { "user" }, "sub": sub };
        if let Some(sid) = sid {
            event.insert("sid", sid);
        }
        event.insert("at", now);
        event.insert(
            "expiresAt",
            DateTime::from_millis(now.timestamp_millis().saturating_add(
                self.options.access_token_ttl_seconds.saturating_add(120).saturating_mul(1000),
            )),
        );
        self.meta.collection::<Document>("revocations").insert_one(event).session(session).await?;
        Ok(())
    }

    async fn end_sessions(
        &self,
        session: &mut ClientSession,
        id: &str,
        sid: Option<&str>,
        now: DateTime,
    ) -> Result<i32, Abort> {
        let mut filter = doc! { "userId": id_filter(id) };
        if let Some(sid) = sid {
            filter.insert("_id", id_filter(sid));
        }
        let sessions = self.auth.collection::<Document>("sessions");
        let mut cursor = sessions.find(filter.clone()).session(&mut *session).await?;
        let mut ended = Vec::new();
        while let Some(found) = cursor.next(&mut *session).await {
            ended.push(found?);
        }
        drop(cursor);
        if sid.is_some() && ended.is_empty() {
            return Err(err(ErrorCode::NotFound, "No such session").into());
        }
        sessions.delete_many(filter).session(&mut *session).await?;
        for ended in &ended {
            let sid = ended.get("_id").map_or_else(String::new, id_text);
            self.meta
                .collection::<Document>("audit_log")
                .insert_one(doc! {
                    "action": "auth.session_ended", "actor": { "type": "user", "id": id },
                    "target": { "type": "session", "id": &sid }, "at": now,
                })
                .session(&mut *session)
                .await?;
            self.revoke(&mut *session, id, Some(&sid), now).await?;
        }
        Ok(i32::try_from(ended.len()).map_err(|error| err(ErrorCode::Internal, error.to_string()))?)
    }

    async fn change(
        &self,
        id: &str,
        mut update: Document,
        password: Option<String>,
        revoke: bool,
        now: DateTime,
    ) -> Result<Document, CanopyError> {
        metadata_fields(&mut update)?;
        if !update.is_empty() {
            update.insert("updatedAt", now);
        }
        transaction(self.auth.client(), |session| {
            let (routes, id, update, password) =
                (self.clone(), id.to_owned(), update.clone(), password.clone());
            Box::pin(async move {
                let users = routes.auth.collection::<Document>("users");
                let filter = doc! { "_id": id_filter(&id) };
                let user = if update.is_empty() {
                    users.find_one(filter).session(&mut *session).await?
                } else {
                    users
                        .find_one_and_update(filter, doc! { "$set": update })
                        .return_document(ReturnDocument::After)
                        .session(&mut *session)
                        .await
                        .map_err(db_failure)?
                }
                .ok_or_else(missing_user)?;
                if let Some(password) = password {
                    let uid = user.get("_id").cloned().ok_or_else(missing_user)?;
                    routes
                        .auth
                        .collection::<Document>("accounts")
                        .update_one(
                            doc! { "providerId": "credential", "userId": id_filter(&id) },
                            doc! { "$set": { "password": password }, "$setOnInsert": {
                                "userId": uid, "accountId": &id, "providerId": "credential",
                                "createdAt": now, "updatedAt": now,
                            } },
                        )
                        .upsert(true)
                        .session(&mut *session)
                        .await?;
                }
                if revoke {
                    routes.end_sessions(&mut *session, &id, None, now).await?;
                    routes.revoke(session, &id, None, now).await?;
                }
                Ok(user)
            })
        })
        .await
    }

    async fn invite(&self, input: Document, now: DateTime) -> Result<Document, CanopyError> {
        let address = email(input.get_str("email").unwrap_or_default())?;
        check_roles(&input)?;
        let callback = text(&input, "redirectTo").unwrap_or("/");
        let mut changes = input.clone();
        changes.remove("redirectTo");
        let users = self.auth.collection::<Document>("users");
        let user = if let Some(user) = users.find_one(doc! { "email": &address }).await.map_err(mongo)? {
            changes.remove("email");
            let revoke = changes.contains_key("roles");
            let id = user.get("_id").map_or_else(String::new, id_text);
            self.change(&id, changes, None, revoke, now).await?
        } else {
            self.create(changes, None, Vec::new(), now).await?
        };
        let public = &self.options.public_url;
        let allowed = if callback.starts_with('/') {
            !callback.starts_with("//") && !callback.contains('\\')
        } else {
            url::Url::parse(callback).is_ok_and(|url| {
                let origin = url.origin().ascii_serialization();
                matches!(url.scheme(), "http" | "https")
                    && (url.origin() == public.origin() || self.options.redirect_origins.contains(&origin))
            })
        };
        if !allowed {
            return Err(err(ErrorCode::Unauthorized, "The invite redirect is not in the allowlist"));
        }
        let token = random_url(24)?;
        let mut link = public
            .join("/auth/v1/magic-link/verify")
            .map_err(|error| err(ErrorCode::Internal, error.to_string()))?;
        link.query_pairs_mut().append_pair("token", &token).append_pair("callbackURL", callback);
        let proof =
            canopy_protocol::ejson::stringify(&to_value(&doc! { "type": "magic-link", "email": &address })?)
                .map_err(|error| err(ErrorCode::Internal, error.to_string()))?;
        self.auth
            .collection::<Document>("verifications")
            .insert_one(doc! {
                "identifier": format!("magic-link:{token}"), "value": proof,
                "createdAt": now, "updatedAt": now,
                "expiresAt": DateTime::from_millis(now.timestamp_millis().saturating_add(900_000)),
            })
            .await
            .map_err(mongo)?;
        self.mail
            .clone()
            .send(
                EmailKind::Invite,
                Recipient { email: &address, url: Some(link.as_str()), otp: None, new_email: None },
            )
            .await;
        Ok(user)
    }
}

impl Delegate for UserRoutes {
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>> {
        Box::pin(async move {
            let now = DateTime::from_millis((self.now)());
            let id = call.param("id");
            match call.route.as_str() {
                "GET users" => self.list(call).await,
                "POST users/import" => self.import(call, now).await,
                "POST users" | "POST users/invite" => {
                    let invite = call.route == "POST users/invite";
                    let schema = if invite {
                        vec![
                            ("email", string(3, 320)),
                            ("redirectTo", optional(string(1, 2000))),
                            ("roles", optional(Schema::Array(Box::new(string(1, 200)), 64))),
                            ("appMetadata", optional(Schema::Document)),
                        ]
                    } else {
                        let mut schema =
                            vec![("email", string(3, 320)), ("password", optional(string(1, 1024)))];
                        schema.extend(fields());
                        schema
                    };
                    let mut input = body(call, schema)?;
                    let user = if invite {
                        self.invite(input, now).await?
                    } else {
                        email(input.get_str("email").unwrap_or_default())?;
                        check_roles(&input)?;
                        let password = self.password(&mut input).await?;
                        self.create(input, password, Vec::new(), now).await?
                    };
                    let id = user.get("_id").map_or_else(String::new, id_text);
                    Ok(reply(201, &public_user(&user))?
                        .audited(audit(if invite { "user.invite" } else { "user.create" }, &id)))
                }
                _ => self.handle_user(call, id, now).await,
            }
        })
    }
}

impl UserRoutes {
    async fn handle_user(&self, call: &Call, id: &str, now: DateTime) -> Result<Reply, CanopyError> {
        let before = self.get(id).await?;
        match call.route.as_str() {
            "GET users/:id" => reply(200, &public_user(&before)),
            "PATCH users/:id" => {
                let mut schema =
                    vec![("email", optional(string(3, 320))), ("password", optional(string(1, 1024)))];
                schema.extend(fields());
                let mut update = body(call, schema.clone())?;
                check_roles(&update)?;
                let fields: Vec<_> =
                    schema.iter().map(|(key, _)| *key).filter(|key| update.contains_key(*key)).collect();
                let password = self.password(&mut update).await?;
                let mut revoke = password.is_some() || update.contains_key("roles");
                if let Some(address) = text(&update, "email") {
                    let address = email(address)?;
                    revoke |= text(&before, "email") != Some(address.as_str());
                    update.insert("email", address);
                }
                let after = public_user(&self.change(id, update, password, revoke, now).await?);
                let mut entry = audit("user.update", id);
                entry.insert(
                    "diff",
                    doc! { "before": user_diff(&public_user(&before)), "after": user_diff(&after) },
                );
                entry.insert("details", doc! { "fields": fields });
                Ok(reply(200, &after)?.audited(entry))
            }
            "POST users/:id/ban" | "POST users/:id/unban" => {
                let ban = call.route == "POST users/:id/ban";
                let mut details = doc! {};
                let mut update = doc! { "banned": ban, "banReason": Bson::Null, "banExpires": Bson::Null };
                if ban {
                    let input = body(
                        call,
                        vec![("reason", optional(string(0, 500))), ("until", optional(string(1, 40)))],
                    )?;
                    if let Some(reason) = text(&input, "reason") {
                        update.insert("banReason", reason);
                        details.insert("reason", reason);
                    }
                    if let Some(until) = text(&input, "until") {
                        update.insert(
                            "banExpires",
                            date(until).ok_or_else(|| invalid("until must be an ISO date"))?,
                        );
                    }
                }
                let after = self.change(id, update, None, ban, now).await?;
                let mut entry = audit(if ban { "user.ban" } else { "user.unban" }, id);
                if ban {
                    entry.insert("details", details);
                }
                Ok(reply(200, &public_user(&after))?.audited(entry))
            }
            "DELETE users/:id" => {
                transaction(self.auth.client(), |session| {
                    let (routes, id) = (self.clone(), id.to_owned());
                    Box::pin(async move {
                        routes.end_sessions(&mut *session, &id, None, now).await?;
                        routes
                            .auth
                            .collection::<Document>("accounts")
                            .delete_many(doc! { "userId": id_filter(&id) })
                            .session(&mut *session)
                            .await?;
                        routes
                            .auth
                            .collection::<Document>("users")
                            .delete_one(doc! { "_id": id_filter(&id) })
                            .session(&mut *session)
                            .await?;
                        routes.revoke(session, &id, None, now).await
                    })
                })
                .await?;
                let mut response = Reply::json(204, Value::Null);
                response.body = None;
                Ok(response.audited(doc! { "action": "user.delete", "target": {
                    "userId": id, "email": before.get_str("email").unwrap_or_default(),
                } }))
            }
            "GET users/:id/sessions" => {
                let found = collect(
                    self.auth
                        .collection("sessions")
                        .find(doc! { "userId": id_filter(id), "expiresAt": { "$gt": now } })
                        .sort(doc! { "_id": 1 })
                        .await
                        .map_err(mongo)?,
                )
                .await?;
                reply(200, &doc! { "data": found.iter().map(public_session).collect::<Vec<_>>() })
            }
            "DELETE users/:id/sessions" | "DELETE users/:id/sessions/:sid" => {
                let sid = (call.route == "DELETE users/:id/sessions/:sid").then(|| call.param("sid"));
                let count = transaction(self.auth.client(), |session| {
                    let (routes, id, sid) = (self.clone(), id.to_owned(), sid.map(str::to_owned));
                    Box::pin(async move { routes.end_sessions(session, &id, sid.as_deref(), now).await })
                })
                .await?;
                let entry = if let Some(sid) = sid {
                    doc! { "action": "user.sessions.revoke", "target": { "userId": id, "sessionId": sid } }
                } else {
                    doc! { "action": "user.sessions.revoke", "target": { "userId": id }, "details": { "count": count } }
                };
                Ok(reply(200, &doc! { "revoked": count })?.audited(entry))
            }
            _ => Err(err(ErrorCode::NotFound, "No such route")),
        }
    }
}
