use super::*;
use documents::Session;

const DAY_MS: i64 = 86_400_000;

impl Call<'_> {
    pub(super) async fn authenticated(&self) -> Result<Option<(Session, User)>> {
        let Some(token) = self.session_token() else { return Ok(None) };
        let Some(session) = self
            .router
            .auth
            .collection::<Session>("sessions")
            .find_one(doc! {"token": token})
            .await
            .map_err(internal)?
        else {
            return Ok(None);
        };
        if session.expires_at <= self.now {
            self.end_sessions(doc! {"_id": &session.id, "expiresAt": {"$lte": self.now}}).await?;
            return Ok(None);
        }
        let Some(user) = self.user(doc! {"_id": &session.user_id}).await? else { return Ok(None) };
        if self.banned(&user) {
            return Ok(None);
        }
        Ok(Some((session, user)))
    }

    pub(super) fn fresh(&self, session: &Session) -> bool {
        self.now.timestamp_millis().saturating_sub(session.created_at.timestamp_millis()) < 900_000
    }

    pub(super) fn banned(&self, user: &User) -> bool {
        user.extra.get_bool("banned").unwrap_or(false)
            && user.extra.get_datetime("banExpires").map_or(true, |until| *until > self.now)
    }

    pub(super) async fn create_session(&self, user: &User, remember: bool, method: &str) -> Result<Session> {
        let session = self.new_session(user, remember, "aal1")?;
        self.router.auth.collection::<Session>("sessions").insert_one(&session).await.map_err(internal)?;
        self.router
            .meta
            .collection::<Document>("audit_log")
            .insert_one(self.session_audit(&session, method))
            .await
            .map_err(internal)?;
        Ok(session)
    }

    pub(super) fn new_session(&self, user: &User, remember: bool, aal: &str) -> Result<Session> {
        Ok(Session {
            id: Bson::ObjectId(object_id(self.now)),
            expires_at: self.date_after(if remember { self.session_ttl_ms() } else { DAY_MS }),
            token: random_token(32)?,
            created_at: self.now,
            updated_at: self.now,
            ip_address: self.ip().into(),
            user_agent: self.request.header("user-agent").unwrap_or_default(),
            user_id: user.id.clone(),
            extra: doc! {"aal": aal},
        })
    }

    pub(super) fn session_audit(&self, session: &Session, method: &str) -> Document {
        doc! {
            "_id": object_id(self.now), "action": "auth.sign_in",
            "actor": {"type":"user", "id": id_text(&session.user_id)},
            "target": {"type": "session", "id": id_text(&session.id)},
            "details": {"method": method}, "at": self.now,
        }
    }

    pub(super) async fn insert_session_in(
        &self,
        tx: &mut canopy_mongo::mongodb::ClientSession,
        session: &Session,
        method: &str,
    ) -> canopy_mongo::mongodb::error::Result<()> {
        self.router.auth.collection::<Session>("sessions").insert_one(session).session(&mut *tx).await?;
        self.router
            .meta
            .collection::<Document>("audit_log")
            .insert_one(self.session_audit(session, method))
            .session(tx)
            .await?;
        Ok(())
    }

    async fn end_session(&self, filter: Document) -> Result<()> {
        let mut mongo_session = self.router.auth.client().start_session().await.map_err(internal)?;
        mongo_session
            .start_transaction()
            .and_run((self, filter), |session, (call, filter)| {
                Box::pin(async move { call.end_sessions_in(session, filter.clone()).await })
            })
            .await
            .map_err(internal)
    }

    pub(super) async fn end_sessions(&self, filter: Document) -> Result<()> {
        self.end_session(filter).await
    }

    pub(super) async fn end_sessions_in(
        &self,
        session: &mut canopy_mongo::mongodb::ClientSession,
        filter: Document,
    ) -> canopy_mongo::mongodb::error::Result<()> {
        let sessions = self.router.auth.collection::<Session>("sessions");
        let mut cursor = sessions.find(filter.clone()).sort(doc! {"_id":1}).session(&mut *session).await?;
        let found: Vec<Session> = cursor.stream(&mut *session).try_collect().await?;
        drop(cursor);
        if found.is_empty() {
            return Ok(());
        }
        sessions.delete_many(filter).session(&mut *session).await?;
        for ended in found {
            self.revoke_session_in(session, &ended).await?;
        }
        Ok(())
    }

    pub(super) async fn revoke_session_in(
        &self,
        session: &mut canopy_mongo::mongodb::ClientSession,
        ended: &Session,
    ) -> canopy_mongo::mongodb::error::Result<()> {
        let sub = id_text(&ended.user_id);
        let sid = id_text(&ended.id);
        self.router
            .meta
            .collection::<Document>("revocations")
            .insert_one(doc! {
                "_id": object_id(self.now), "kind": "session", "sub": &sub, "sid": &sid, "at": self.now,
                "expiresAt": self.date_after((self.router.options.access_token_ttl_seconds + 120) * 1000)
            })
            .session(&mut *session)
            .await?;
        self.router.meta.collection::<Document>("audit_log").insert_one(doc! {
                "_id": object_id(self.now), "action": "auth.session_ended", "actor": {"type":"user", "id": sub},
                "target": {"type":"session", "id": sid}, "at": self.now
            }).session(&mut *session).await?;
        Ok(())
    }
    pub(super) fn remember_session(&self) -> bool {
        !self
            .cookie(AuthCookie::DontRemember)
            .is_some_and(|signed| verify_session(&self.router.options.secret, &signed).is_some())
    }

    fn clear_session(&self, response: &mut Response) {
        for cookie in [AuthCookie::SessionToken, AuthCookie::SessionData, AuthCookie::DontRemember] {
            self.set_cookie(response, cookie, "", Expiration::MaxAge(0));
        }
    }

    fn session_ttl_ms(&self) -> i64 {
        i64::from(self.router.options.session_ttl_seconds) * 1000
    }

    pub(super) async fn refresh_session(&self, session: &mut Session) -> Result<bool> {
        let update_age_ms = i64::from(self.router.options.session_update_age_seconds) * 1000;
        let refresh_at = session
            .expires_at
            .timestamp_millis()
            .saturating_sub(self.session_ttl_ms())
            .saturating_add(update_age_ms);
        if !self.remember_session() || refresh_at > self.now.timestamp_millis() {
            return Ok(false);
        }
        let expiry = self.date_after(self.session_ttl_ms());
        let updated = self
            .router
            .collection("sessions")
            .update_one(
                doc! {"_id": &session.id, "updatedAt": session.updated_at, "expiresAt": {"$gt": self.now}},
                doc! {"$set": {"updatedAt": self.now, "expiresAt": expiry}},
            )
            .await
            .map_err(internal)?;
        if updated.matched_count == 0 {
            return Ok(false);
        }
        session.updated_at = self.now;
        session.expires_at = expiry;
        Ok(true)
    }

    async fn get_session(&self) -> Result<Response> {
        let mut reply = match self.authenticated().await? {
            Some((mut session, user)) => {
                let refreshed = self.refresh_session(&mut session).await?;
                let mut reply = response(200, object!("session":session.public(), "user":user.public()));
                if refreshed {
                    self.set_session(&mut reply, &session.token, true);
                }
                reply
            }
            None => {
                let mut reply = response(200, Value::Null);
                if self.session_token().is_some() {
                    self.clear_session(&mut reply);
                }
                reply
            }
        };
        header(&mut reply, "cache-control", "no-store");
        header(&mut reply, "pragma", "no-cache");
        Ok(reply)
    }

    pub(super) async fn session_route(&self, body: &Value) -> Result<Response> {
        if self.route == "/get-session" {
            return self.get_session().await;
        }
        if self.route == "/sign-out" {
            if let Some(token) = self.session_token() {
                self.end_sessions(doc! {"token": token}).await?;
            }
            let mut reply = response(200, json!({"success":true}));
            self.clear_session(&mut reply);
            self.audit("auth.sign_out", doc! {"type":"user"}, None, None, true).await?;
            return Ok(reply);
        }
        let Some((session, user)) = self.authenticated().await? else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        let mut filter = doc! {"userId": &user.id};
        let action = match self.route {
            "/list-sessions" => {
                filter.insert("expiresAt", doc! {"$gt": self.now});
                let sessions: Vec<Session> = self
                    .router
                    .auth
                    .collection("sessions")
                    .find(filter)
                    .sort(doc! {"_id":1})
                    .await
                    .map_err(internal)?
                    .try_collect()
                    .await
                    .map_err(internal)?;
                return Ok(response(200, sessions.iter().map(Session::public).collect::<Vec<_>>()));
            }
            "/revoke-session" => {
                let Some(token) = body.get("token").and_then(Value::as_str) else {
                    return Ok(validation(body, "token"));
                };
                filter.insert("token", token);
                "auth.session_revoked"
            }
            "/revoke-other-sessions" => {
                filter.insert("_id", doc! {"$ne": &session.id});
                "auth.sessions_revoked"
            }
            "/revoke-sessions" => "auth.sessions_revoked",
            "/update-user" => return self.update_user(body, &session, &user).await,
            "/change-email" => return self.change_email(body, &user).await,
            _ => return Ok(empty(404)),
        };
        self.end_sessions(filter).await?;
        self.audit(action, doc! {"type": "user"}, None, None, true).await?;
        Ok(status())
    }

    async fn update_user(&self, body: &Value, session: &Session, user: &User) -> Result<Response> {
        for field in ["roles", "appMetadata"] {
            if body.get(field).is_some() {
                return Ok(error(400, "FIELD_NOT_ALLOWED", &format!("{field} is not allowed to be set")));
            }
        }
        let mut update = doc! {"updatedAt": self.now};
        for field in ["name", "image"] {
            if let Some(value) = body.get(field) {
                if let Some(value) = value.as_str() {
                    update.insert(field, value);
                } else if field == "image" && value.is_null() {
                    update.insert(field, Bson::Null);
                } else {
                    return Ok(validation(body, field));
                }
            }
        }
        if let Some(value) = body.get("userMetadata") {
            if !value.is_object() {
                return Ok(error(400, "VALIDATION_ERROR", "userMetadata must be an object"));
            }
            update.insert("userMetadata", value.to_string());
        }
        self.router
            .collection("users")
            .update_one(doc! {"_id": &user.id}, doc! {"$set": update})
            .await
            .map_err(internal)?;
        self.audit("auth.user_updated", doc! {"type":"user"}, None, None, true).await?;
        let mut reply = status();
        self.set_session(&mut reply, &session.token, self.remember_session());
        Ok(reply)
    }
}
