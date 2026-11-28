use super::email::redirect_parameter;
use super::*;
use crate::passwords::{hash_password, verify_password};
use documents::{Account, Verification};

pub(super) const RESET_TTL_MS: i64 = 3_600_000;

impl Call<'_> {
    pub(super) async fn derive(
        &self,
        password: &str,
        stored: Option<String>,
    ) -> Result<(bool, Option<String>)> {
        let permit = Arc::clone(&self.router.password_slots).acquire_owned().await.map_err(internal)?;
        let password = password.to_owned();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            match stored {
                Some(stored) => {
                    let verified = verify_password(&password, &stored);
                    let replacement = if verified.is_some_and(|value| value.needs_rehash) {
                        Some(hash_password(&password).map_err(internal)?)
                    } else {
                        None
                    };
                    Ok((verified.is_some(), replacement))
                }
                None => Ok((false, Some(hash_password(&password).map_err(internal)?))),
            }
        })
        .await
        .map_err(internal)?
    }

    pub(super) fn check_password(&self, password: &str) -> Option<Response> {
        let length = password.encode_utf16().count();
        if length < self.router.options.min_password_length {
            Some(error(400, "PASSWORD_TOO_SHORT", "Password too short"))
        } else if length > 128 {
            Some(error(400, "PASSWORD_TOO_LONG", "Password too long"))
        } else {
            None
        }
    }

    pub(super) async fn account(&self, user: &User) -> Result<Option<Account>> {
        self.router
            .auth
            .collection::<Account>("accounts")
            .find_one(doc! {"userId": &user.id, "providerId": "credential"})
            .await
            .map_err(internal)
    }

    pub(super) async fn sign_up(&self, body: &Value) -> Result<Response> {
        let pending =
            || response(200, object!("token":Value::Null, "user":Value::Null, "verification":"sent"));
        let Some(name) = body.get("name").and_then(Value::as_str) else {
            return Ok(validation(body, "name"));
        };
        let Some(email) = body.get("email").and_then(Value::as_str) else {
            return Ok(validation(body, "email"));
        };
        let Some(password) = body.get("password").and_then(Value::as_str) else {
            return Ok(validation(body, "password"));
        };
        if let Some(reply) = self.check_password(password) {
            return Ok(reply);
        }
        let Some(email) = normalize_email(email) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        for field in ["roles", "appMetadata"] {
            if body.get(field).is_some() {
                return Ok(error(400, "FIELD_NOT_ALLOWED", &format!("{field} is not allowed to be set")));
            }
        }
        let (_, hash) = self.derive(password, None).await?;
        if self.user(doc! {"email": &email}).await?.is_some() {
            return Ok(pending());
        }
        let mut extra =
            doc! {"isAnonymous":false, "role":"user", "banned":false, "twoFactorEnabled":false, "roles":[]};
        if let Some(image) = body.get("image").and_then(Value::as_str) {
            extra.insert("image", image);
        }
        if let Some(metadata) = body.get("userMetadata").filter(|value| value.is_object()) {
            extra.insert("userMetadata", metadata.to_string());
        }
        let user = User {
            id: Bson::ObjectId(object_id(self.now)),
            name: name.into(),
            email,
            email_verified: false,
            created_at: self.now,
            updated_at: self.now,
            extra,
        };
        let account = Account {
            id: Bson::ObjectId(object_id(self.now)),
            account_id: id_text(&user.id),
            provider_id: "credential".into(),
            user_id: user.id.clone(),
            password: hash,
            created_at: self.now,
            updated_at: self.now,
            extra: Document::new(),
        };
        let mut mongo_session = self.router.auth.client().start_session().await.map_err(internal)?;
        let created = mongo_session
            .start_transaction()
            .and_run((&self.router.auth, &user, &account), |session, (auth, user, account)| {
                Box::pin(async move {
                    auth.collection::<User>("users").insert_one(*user).session(&mut *session).await?;
                    auth.collection::<Account>("accounts").insert_one(*account).session(session).await?;
                    Ok(())
                })
            })
            .await;
        if let Err(cause) = created {
            if self.user(doc! {"email": &user.email}).await?.is_some() {
                return Ok(pending());
            }
            return Err(internal(cause));
        }
        let uid = id_text(&user.id);
        self.audit(
            "auth.sign_up",
            doc! {"type": "user", "id": &uid},
            Some(doc! {"type": "user", "id": &uid}),
            Some(doc! {"method": "password"}),
            false,
        )
        .await?;
        self.send_verification(&user, body.get("callbackURL").and_then(Value::as_str).unwrap_or("/"), None)
            .await;
        if self.router.options.require_email_verification {
            return Ok(pending());
        }
        let remember = body.get("rememberMe").and_then(Value::as_bool).unwrap_or(true);
        let session = self.create_session(&user, remember, "password").await?;
        let mut reply = response(200, object!("token":session.token, "user":user.public()));
        self.sign_in_cookie(&mut reply, &session.token, remember);
        Ok(reply)
    }

    fn sign_in_cookie(&self, reply: &mut Response, token: &str, remember: bool) {
        self.set_session(reply, token, remember);
        if !remember {
            let signed = sign_value(&self.router.options.secret, "true");
            self.set_cookie(reply, AuthCookie::DontRemember, &signed, Expiration::Session);
        } else if !self.remember_session() {
            self.set_cookie(reply, AuthCookie::DontRemember, "", Expiration::MaxAge(0));
        }
    }

    pub(super) async fn sign_in(&self, body: &Value) -> Result<Response> {
        let Some(email) = body.get("email").and_then(Value::as_str) else {
            return Ok(validation(body, "email"));
        };
        let Some(email) = normalize_email(email) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        let fail_key = format!("fail|{email}");
        let limits = self.router.collection("identifier_limits");
        if body.get("password").and_then(Value::as_str).is_none() {
            return self.sign_in_failure(&email, "password", validation(body, "password")).await;
        }
        let password = body.get("password").and_then(Value::as_str).unwrap_or_default();
        let user = self.user(doc! {"email": &email}).await?;
        let account = match &user {
            Some(user) => self.account(user).await?,
            None => None,
        };
        let stored = account.as_ref().and_then(|account| account.password.clone());
        let (verified, replacement) = self.derive(password, stored.clone()).await?;
        let Some(user) = user.filter(|_| verified) else {
            return self
                .sign_in_failure(
                    &email,
                    "password",
                    error(401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password"),
                )
                .await;
        };
        if self.banned(&user) {
            return self
                .sign_in_failure(
                    &email,
                    "password",
                    error(403, "FORBIDDEN", "Password sign in is unavailable for this user"),
                )
                .await;
        }
        if self.router.options.require_email_verification && !user.email_verified {
            return self
                .sign_in_failure(&email, "password", error(403, "EMAIL_NOT_VERIFIED", "Email not verified"))
                .await;
        }
        if let (Some(account), Some(previous), Some(replacement)) = (account, stored, replacement) {
            self.router
                .collection("accounts")
                .update_one(
                    doc! {"_id": account.id, "password": previous},
                    doc! {"$set": {"password": replacement, "updatedAt": self.now}},
                )
                .await
                .map_err(internal)?;
        }
        let remember = body.get("rememberMe").and_then(Value::as_bool).unwrap_or(true);
        if user.extra.get_bool("twoFactorEnabled").unwrap_or(false) {
            if !self.feature("two_factor") {
                return Ok(error(403, "FORBIDDEN", "Password sign in is unavailable for this user"));
            }
            let reply = self.begin_two_factor(&user, remember).await?;
            limits.delete_one(doc! {"_id": fail_key}).await.map_err(internal)?;
            return Ok(reply);
        }
        let session = self.create_session(&user, remember, "password").await?;
        limits.delete_one(doc! {"_id": fail_key}).await.map_err(internal)?;
        let callback = body.get("callbackURL").and_then(Value::as_str);
        let payload = if let Some(callback) = callback {
            object!("redirect":true, "token":session.token, "url":callback, "user":user.public())
        } else {
            object!("redirect":false, "token":session.token, "user":user.public())
        };
        let mut reply = response(200, payload);
        if let Some(callback) = callback {
            header(&mut reply, "location", callback);
        }
        self.sign_in_cookie(&mut reply, &session.token, remember);
        Ok(reply)
    }

    pub(super) async fn sign_in_failure(
        &self,
        email: &str,
        method: &str,
        reply: Response,
    ) -> Result<Response> {
        self.count_failure(email).await?;
        self.audit(
            "auth.sign_in_failed",
            doc! {"type":"anonymous"},
            None,
            Some(doc! {"method":method, "email":email, "status":i32::from(reply.status)}),
            true,
        )
        .await?;
        Ok(reply)
    }

    /// Counts a failed proof of an address (a password or a code) and locks the address with a growing
    /// delay once failures pile up, whatever the route that saw them.
    pub(super) async fn count_failure(&self, email: &str) -> Result<()> {
        let key = format!("fail|{email}");
        self.router.collection("identifier_limits").update_one(doc! {"_id": key}, vec![
            doc! {"$set": {
                "failures": {"$add": [{"$ifNull":["$failures", 0]}, 1]},
            }},
            doc! {"$set": {
                "lockedUntil": {"$cond": [{"$gte": ["$failures", 5]},
                    {"$add": [self.now, {"$min": [900000, {"$multiply": [1000, {"$pow": [2, {"$subtract": ["$failures", 5]}]}]}]}]}, Bson::Null]},
                "expiresAt": self.date_after(3_600_000)
            }}
        ]).upsert(true).await.map_err(internal)?;
        Ok(())
    }

    /// The seconds until a locked address may try again, or none when it is not locked.
    pub(super) async fn failure_lock(&self, email: &str) -> Result<Option<i64>> {
        let locked = self
            .router
            .collection("identifier_limits")
            .find_one(doc! {"_id":format!("fail|{email}"), "lockedUntil":{"$gt":self.now}})
            .await
            .map_err(internal)?;
        Ok(locked
            .and_then(|limit| limit.get_datetime("lockedUntil").ok().copied())
            .map(|until| retry_seconds(until.timestamp_millis(), self.now.timestamp_millis())))
    }

    pub(super) async fn request_reset(&self, body: &Value) -> Result<Response> {
        let Some(email) = body.get("email").and_then(Value::as_str) else {
            return Ok(validation(body, "email"));
        };
        let Some(email) = normalize_email(email) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        if let Some(user) = self.user(doc! {"email": email}).await? {
            let token = random_token(24)?;
            let verification = Verification {
                identifier: format!("reset-password:{token}"),
                value: id_text(&user.id),
                expires_at: self.date_after(RESET_TTL_MS),
                created_at: self.now,
                updated_at: self.now,
                extra: doc! {"_id": object_id(self.now)},
            };
            self.router
                .auth
                .collection::<Verification>("verifications")
                .insert_one(verification)
                .await
                .map_err(internal)?;
            let callback = body.get("redirectTo").and_then(Value::as_str).unwrap_or("/");
            let url = format!(
                "{}/auth/v1/reset-password/{token}?callbackURL={}",
                self.router.public_url(),
                crate::cookies::encode(callback)
            );
            self.router
                .mail
                .clone()
                .send(
                    EmailKind::ResetPassword,
                    Recipient { email: &user.email, url: Some(&url), ..Recipient::default() },
                )
                .await;
        }
        Ok(response(
            200,
            object!("status":true, "message":"If this email exists in our system, check your email for the reset link"),
        ))
    }

    pub(super) async fn reset_link(&self, query: &BTreeMap<String, String>) -> Result<Response> {
        let token = self.route.strip_prefix("/reset-password/").unwrap_or_default();
        let found = self
            .router
            .collection("verifications")
            .find_one(self.reset_filter(token))
            .await
            .map_err(internal)?;
        let callback = query.get("callbackURL").map(String::as_str).unwrap_or("/");
        Ok(if found.is_some() {
            redirect_parameter(callback, "token", token)
        } else {
            redirect_parameter(callback, "error", "INVALID_TOKEN")
        })
    }

    fn reset_filter(&self, token: &str) -> Document {
        doc! {"identifier": format!("reset-password:{token}"), "expiresAt":{"$gt":self.now}}
    }

    pub(super) async fn reset_password(&self, body: &Value) -> Result<Response> {
        let Some(token) = body.get("token").and_then(Value::as_str) else {
            return Ok(validation(body, "token"));
        };
        let Some(password) = body.get("newPassword").and_then(Value::as_str) else {
            return Ok(validation(body, "newPassword"));
        };
        if let Some(reply) = self.check_password(password) {
            return Ok(reply);
        }
        let filter = self.reset_filter(token);
        let verifications = self.router.auth.collection::<Verification>("verifications");
        let invalid = || error(400, "INVALID_TOKEN", "Invalid token");
        let Some(verification) = verifications.find_one(filter.clone()).await.map_err(internal)? else {
            return Ok(invalid());
        };
        let uid = &verification.value;
        let oid = bson::oid::ObjectId::parse_str(uid).ok().map(Bson::ObjectId);
        let mut ids = vec![Bson::String(uid.clone())];
        ids.extend(oid);
        let Some(user) = self.user(doc! {"_id":{"$in":ids}}).await? else {
            return Ok(invalid());
        };
        let (_, replacement) = self.derive(password, None).await?;
        let mut session = self.router.auth.client().start_session().await.map_err(internal)?;
        let changed = session
            .start_transaction()
            .and_run((self, filter, &user, replacement), |session, (call, filter, user, replacement)| {
                Box::pin(async move {
                    let auth = &call.router.auth;
                    if auth
                        .collection::<Verification>("verifications")
                        .find_one_and_delete(filter.clone())
                        .session(&mut *session)
                        .await?
                        .is_none()
                    {
                        return Ok(false);
                    }
                    let account = doc! {"userId": &user.id, "providerId": "credential"};
                    auth.collection::<Document>("accounts")
                        .update_one(
                            account,
                            doc! {
                                "$set": {"password": replacement.clone(), "updatedAt": call.now},
                                "$setOnInsert": {"accountId": id_text(&user.id), "createdAt": call.now},
                            },
                        )
                        .upsert(true)
                        .session(&mut *session)
                        .await?;
                    call.end_sessions_in(session, doc! {"userId": &user.id}).await?;
                    Ok(true)
                })
            })
            .await
            .map_err(internal)?;
        if !changed {
            return Ok(invalid());
        }
        self.audit("auth.password_reset", doc! {"type":"user"}, None, None, true).await?;
        Ok(status())
    }

    pub(super) async fn change_password(&self, body: &Value) -> Result<Response> {
        let Some((session, user)) = self.authenticated().await? else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        if session.created_at.timestamp_millis().saturating_add(900_000) <= self.now.timestamp_millis() {
            return Ok(error(403, "SESSION_NOT_FRESH", "Session is not fresh"));
        }
        let Some(current) = body.get("currentPassword").and_then(Value::as_str) else {
            return Ok(validation(body, "currentPassword"));
        };
        let Some(password) = body.get("newPassword").and_then(Value::as_str) else {
            return Ok(validation(body, "newPassword"));
        };
        if let Some(reply) = self.check_password(password) {
            return Ok(reply);
        }
        let invalid = || error(400, "INVALID_PASSWORD", "Invalid password");
        let Some(account) = self.account(&user).await? else {
            return Ok(invalid());
        };
        let Some(stored) = account.password else {
            return Ok(invalid());
        };
        if !self.derive(current, Some(stored.clone())).await?.0 {
            return Ok(invalid());
        }
        let (_, replacement) = self.derive(password, None).await?;
        let revoke = body.get("revokeOtherSessions").and_then(Value::as_bool).unwrap_or(false);
        let mut mongo_session = self.router.auth.client().start_session().await.map_err(internal)?;
        let changed = mongo_session
            .start_transaction()
            .and_run(
                (self, &user, account.id, stored, replacement, revoke),
                |session, (call, user, id, previous, replacement, revoke)| {
                    Box::pin(async move {
                        let write = call
                            .router
                            .collection("accounts")
                            .update_one(
                                doc! {"_id": id.clone(), "password": previous.clone()},
                                doc! {"$set": {"password": replacement.clone(), "updatedAt": call.now}},
                            )
                            .session(&mut *session)
                            .await?;
                        if write.matched_count == 0 {
                            return Ok(false);
                        }
                        if *revoke {
                            call.end_sessions_in(session, doc! {"userId": &user.id}).await?;
                        }
                        Ok(true)
                    })
                },
            )
            .await
            .map_err(internal)?;
        if !changed {
            return Ok(invalid());
        }
        let next =
            if revoke { Some(self.create_session(&user, true, "change-password").await?) } else { None };
        let mut reply =
            response(200, object!("token":next.as_ref().map(|session| &session.token), "user":user.public()));
        if let Some(next) = next {
            self.set_session(&mut reply, &next.token, true);
        }
        self.audit("auth.password_changed", doc! {"type":"user"}, None, None, true).await?;
        Ok(reply)
    }
}

pub(super) fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim();
    let (local, domain) = email.rsplit_once('@')?;
    if email.len() > 320
        || local.is_empty()
        || local.contains('@')
        || !domain.contains('.')
        || domain.split('.').any(str::is_empty)
        || email.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return None;
    }
    Some(email.to_lowercase())
}
