use super::{
    BTreeMap, Bson, Call, EmailKind, Recipient, Response, Result, Url, User, Value, doc, error, internal,
    object_id, random_token, response, status, validation,
};
use super::{email::redirect, password::normalize_email};

#[derive(serde::Serialize, serde::Deserialize)]
struct MagicLink {
    #[serde(rename = "type")]
    kind: String,
    email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl Call<'_> {
    pub(super) async fn send_magic_link(&self, body: &Value) -> Result<Response> {
        let Some(email) = body.get("email").and_then(Value::as_str) else {
            return Ok(validation(body, "email"));
        };
        let Some(email) = normalize_email(email) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        let token = random_token(32)?;
        let proof = MagicLink {
            kind: "magic-link".into(),
            email,
            name: body.get("name").and_then(Value::as_str).map(str::to_owned),
        };
        let mut url = Url::parse(&format!("{}/auth/v1/magic-link/verify", self.router.public_url()))
            .map_err(internal)?;
        url.query_pairs_mut()
            .append_pair("token", &token)
            .append_pair("callbackURL", body.get("callbackURL").and_then(Value::as_str).unwrap_or("/"));
        for field in ["newUserCallbackURL", "errorCallbackURL"] {
            if let Some(callback) = body.get(field).and_then(Value::as_str) {
                url.query_pairs_mut().append_pair(field, callback);
            }
        }
        self.router
            .collection("verifications")
            .insert_one(doc! {
                "_id": object_id(self.now), "identifier": format!("magic-link:{token}"),
                "value": serde_json::to_string(&proof).map_err(internal)?,
                "createdAt": self.now, "updatedAt": self.now, "expiresAt": self.date_after(900_000)
            })
            .await
            .map_err(internal)?;
        self.router
            .mail
            .clone()
            .send(
                EmailKind::MagicLink,
                Recipient { email: &proof.email, url: Some(url.as_str()), otp: None, new_email: None },
            )
            .await;
        Ok(status())
    }

    pub(super) async fn verify_magic_link(&self, query: &BTreeMap<String, String>) -> Result<Response> {
        let Some(token) = query.get("token") else {
            return Ok(error(
                400,
                "VALIDATION_ERROR",
                "[query.token] Invalid input: expected string, received undefined",
            ));
        };
        let public = &self.router.options.public_url;
        let callback = public.join(query.get("callbackURL").map_or("/", String::as_str)).map_err(internal)?;
        let new_callback = public
            .join(query.get("newUserCallbackURL").map_or(callback.as_str(), String::as_str))
            .map_err(internal)?;
        let mut failure = public
            .join(query.get("errorCallbackURL").map_or(callback.as_str(), String::as_str))
            .map_err(internal)?;
        let verifications = self.router.collection("verifications");
        let identifier = format!("magic-link:{token}");
        let proof = verifications
            .find_one_and_delete(doc! {"identifier": identifier})
            .await
            .map_err(internal)?
            .filter(|proof| proof.get_datetime("expiresAt").is_ok_and(|date| *date > self.now))
            .and_then(|proof| serde_json::from_str::<MagicLink>(proof.get_str("value").ok()?).ok())
            .filter(|proof| proof.kind == "magic-link");
        let Some(proof) = proof else {
            failure.query_pairs_mut().append_pair("error", "INVALID_TOKEN");
            return Ok(redirect(failure.as_str()));
        };
        let (user, created) =
            self.passwordless_user(&proof.email, proof.name.as_deref(), None, "magic_link").await?;
        if self.passwordless_blocked(&user) {
            failure.query_pairs_mut().append_pair("error", "FORBIDDEN");
            return Ok(redirect(failure.as_str()));
        }
        let session = self.create_session(&user, true, "magic_link").await?;
        let mut reply = if query.contains_key("callbackURL") {
            redirect(if created { new_callback.as_str() } else { callback.as_str() })
        } else {
            response(200, object!("token":session.token, "user":user.public(), "session":session.public()))
        };
        self.set_session(&mut reply, &session.token, true);
        Ok(reply)
    }

    pub(super) fn passwordless_blocked(&self, user: &User) -> bool {
        self.banned(user) || user.extra.get_bool("twoFactorEnabled").unwrap_or(false)
    }

    pub(super) async fn passwordless_user(
        &self,
        email: &str,
        name: Option<&str>,
        image: Option<&str>,
        method: &str,
    ) -> Result<(User, bool)> {
        if let Some(user) = self.user(doc! {"email": email}).await? {
            return Ok((self.promote_passwordless(user).await?, false));
        }
        let mut extra =
            doc! {"isAnonymous":false, "role":"user", "banned":false, "twoFactorEnabled":false, "roles":[]};
        if let Some(image) = image {
            extra.insert("image", image);
        }
        let user = User {
            id: Bson::ObjectId(object_id(self.now)),
            name: name.unwrap_or_default().into(),
            email: email.into(),
            email_verified: true,
            created_at: self.now,
            updated_at: self.now,
            extra,
        };
        if let Err(cause) = self.router.auth.collection::<User>("users").insert_one(&user).await {
            if let Some(user) = self.user(doc! {"email": email}).await? {
                return Ok((self.promote_passwordless(user).await?, false));
            }
            return Err(internal(cause));
        }
        let uid = super::id_text(&user.id);
        self.audit(
            "auth.sign_up",
            doc! {"type":"user", "id": &uid},
            Some(doc! {"type":"user", "id":uid}),
            Some(doc! {"method": method}),
            false,
        )
        .await?;
        Ok((user, true))
    }

    async fn promote_passwordless(&self, user: User) -> Result<User> {
        if user.email_verified || self.passwordless_blocked(&user) {
            return Ok(user);
        }
        let mut session = self.router.auth.client().start_session().await.map_err(internal)?;
        session
            .start_transaction()
            .and_run((self, user), |session, (call, user)| {
                Box::pin(async move {
                    let users = call.router.auth.collection::<User>("users");
                    let filter = doc! {"_id": &user.id, "email": &user.email};
                    let promoted = users
                        .find_one_and_update(
                            doc! {"_id": &user.id, "email": &user.email, "emailVerified": false},
                            doc! {"$set": {"emailVerified": true, "updatedAt": call.now}},
                        )
                        .return_document(canopy_mongo::mongodb::options::ReturnDocument::After)
                        .session(&mut *session)
                        .await?;
                    if let Some(promoted) = promoted {
                        call.router
                            .collection("accounts")
                            .delete_many(doc! {"userId": &user.id})
                            .session(&mut *session)
                            .await?;
                        call.end_sessions_in(session, doc! {"userId": &user.id}).await?;
                        Ok(Some(promoted))
                    } else {
                        users.find_one(filter).session(session).await
                    }
                })
            })
            .await
            .map_err(internal)?
            .ok_or_else(|| internal("User changed during sign in"))
    }
}
