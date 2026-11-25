use super::*;
use documents::{Account, Session};
use password::normalize_email;

impl Call<'_> {
    pub(super) async fn sign_in_anonymous(&self) -> Result<Response> {
        if self.authenticated().await?.is_some_and(|(_, user)| is_anonymous(&user)) {
            return Ok(error(
                400,
                "ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY",
                "Anonymous users cannot sign in again anonymously",
            ));
        }
        let user = User {
            id: Bson::ObjectId(object_id(self.now)),
            name: "Anonymous".into(),
            email: format!("temp-{}@anonymous.canopy.invalid", random_token(32)?.to_ascii_lowercase()),
            email_verified: false,
            created_at: self.now,
            updated_at: self.now,
            extra: doc! {"isAnonymous":true, "role":"user", "banned":false, "twoFactorEnabled":false, "roles":[]},
        };
        let session = self.new_session(&user, true, "aal1")?;
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        tx.start_transaction()
            .and_run((self, &user, &session), |tx, (call, user, session)| {
                Box::pin(async move {
                    let id = id_text(&user.id);
                    call.router.auth.collection::<User>("users").insert_one(*user).session(&mut *tx).await?;
                    call.router.meta.collection::<Document>("audit_log").insert_one(doc! {
                    "_id":object_id(call.now), "action":"auth.sign_up", "actor":{"type":"user","id":&id},
                    "target":{"type":"user","id":&id}, "details":{"method":"anonymous"}, "at":call.now,
                }).session(&mut *tx).await?;
                    call.insert_session_in(tx, session, "anonymous").await
                })
            })
            .await
            .map_err(internal)?;
        let mut reply = response(200, object!("token":session.token, "user":user.public()));
        self.set_session(&mut reply, &session.token, true);
        Ok(reply)
    }

    pub(super) async fn upgrade(&self, input: Option<&Value>) -> Result<Response> {
        if self.request.header("origin").is_some_and(|origin| !self.router.trusts_origin(&origin))
            || (self.request.header("origin").is_none() && self.request.header("cookie").is_some())
        {
            return Ok(api_error(403, "INVALID_ORIGIN", "Invalid origin"));
        }
        let Some((_, user)) = self.authenticated().await? else {
            return Ok(api_error(401, "CANOPY_UNAUTHORIZED", "No valid session"));
        };
        if !is_anonymous(&user) {
            return Ok(api_error(400, "USER_IS_NOT_ANONYMOUS", "Only anonymous users can be upgraded"));
        }
        let Some(input) = input else {
            return Ok(api_error(400, "CANOPY_VALIDATION_FAILED", "The body must be JSON"));
        };
        let Some(email) = input.get("email").and_then(Value::as_str).and_then(normalize_email) else {
            return Ok(api_error(400, "INVALID_EMAIL", "Invalid email address"));
        };
        let password = input.get("password");
        let minimum = self.router.options.min_password_length;
        if password.is_some_and(|password| {
            !password.as_str().is_some_and(|value| (minimum..=128).contains(&value.encode_utf16().count()))
        }) {
            return Ok(api_error(
                400,
                "PASSWORD_TOO_SHORT",
                &format!("Passwords need {minimum} to 128 characters"),
            ));
        }
        let callback = input.get("callbackURL").and_then(Value::as_str).unwrap_or("/");
        if !self.router.trusts_callback(callback) {
            return Ok(api_error(403, "INVALID_CALLBACK_URL", "The callback URL is not in the allowlist"));
        }
        let mut pending = response(200, object!("verification":"sent"));
        header(&mut pending, "cache-control", "no-store");
        if self.user(doc! {"email": &email}).await?.is_some() {
            return Ok(pending);
        }
        let account = if let Some(password) = password.and_then(Value::as_str) {
            let (_, hash) = self.derive(password, None).await?;
            Some(Account {
                id: Bson::ObjectId(object_id(self.now)),
                user_id: user.id.clone(),
                account_id: id_text(&user.id),
                provider_id: "credential".into(),
                password: hash,
                created_at: self.now,
                updated_at: self.now,
                extra: Document::new(),
            })
        } else {
            None
        };
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        let updated = tx.start_transaction()
            .and_run((self, &user, &email, &account), |tx, (call, user, email, account)| Box::pin(async move {
                let result = call.router.collection("users").update_one(
                    doc! {"_id": &user.id, "isAnonymous":true},
                    doc! {"$set":{"email":*email, "emailVerified":false, "isAnonymous":false, "updatedAt":call.now}},
                ).session(&mut *tx).await?;
                if result.modified_count == 0 {
                    return Ok(false);
                }
                if let Some(account) = account {
                    call.router.auth.collection::<Account>("accounts").insert_one(account).session(&mut *tx).await?;
                }
                call.router.meta.collection::<Document>("audit_log").insert_one(doc! {
                    "_id":object_id(call.now), "action":"auth.anonymous_upgraded", "actor":{"type":"user","id":id_text(&user.id)},
                    "ip":call.ip(), "at":call.now,
                }).session(tx).await?;
                Ok(true)
            })).await;
        match updated {
            Ok(true) => {
                let user = User { email, ..user };
                self.send_verification(&user, callback, None).await;
            }
            Ok(false) => {}
            Err(error) if duplicate_key(&error) => {}
            Err(error) => return Err(internal(error)),
        }
        Ok(pending)
    }

    pub(super) async fn delete_anonymous_user(&self) -> Result<Response> {
        let Some((session, user)) = self.authenticated().await? else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        if !self.fresh(&session) {
            return Ok(error(403, "SESSION_NOT_FRESH", "Session is not fresh"));
        }
        if !is_anonymous(&user) {
            return Ok(error(403, "USER_IS_NOT_ANONYMOUS", "User is not anonymous"));
        }
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        tx.start_transaction()
            .and_run((self, &user.id), |tx, (call, id)| {
                Box::pin(async move { call.remove_anonymous_in(tx, id).await })
            })
            .await
            .map_err(internal)?;
        let mut reply = response(200, object!("success":true));
        self.clear_session(&mut reply);
        Ok(reply)
    }

    pub(super) async fn insert_linked_session(
        &self,
        session: &Session,
        method: &str,
        prior: &User,
    ) -> Result<()> {
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        tx.start_transaction()
            .and_run((self, session, method, &prior.id), |tx, (call, session, method, id)| {
                Box::pin(async move {
                    call.insert_session_in(tx, session, method).await?;
                    call.remove_anonymous_in(tx, id).await
                })
            })
            .await
            .map_err(internal)
    }

    async fn remove_anonymous_in(
        &self,
        tx: &mut canopy_mongo::mongodb::ClientSession,
        id: &Bson,
    ) -> canopy_mongo::mongodb::error::Result<()> {
        let deleted = self
            .router
            .collection("users")
            .delete_one(doc! {"_id":id, "isAnonymous":true})
            .session(&mut *tx)
            .await?;
        if deleted.deleted_count == 1 {
            self.end_sessions_in(tx, doc! {"userId":id}).await?;
            self.router.collection("accounts").delete_many(doc! {"userId":id}).session(tx).await?;
        }
        Ok(())
    }
}

pub(super) fn is_anonymous(user: &User) -> bool {
    user.extra.get_bool("isAnonymous").unwrap_or(false)
}
