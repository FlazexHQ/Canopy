use canopy_mongo::mongodb::{ClientSession, error::Result as MongoResult, options::ReturnDocument};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::password::normalize_email;
use super::{
    Bson, Call, Document, EmailKind, Recipient, Response, Result, User, Value, api_error, doc, error, header,
    id_text, internal, response, validation,
};

const SIGN_IN: &str = "sign-in";
const VERIFY_EMAIL: &str = "email-verification";
const RESET_PASSWORD: &str = "forget-password";

pub(super) fn is_route(route: &str) -> bool {
    matches!(
        route,
        "/sign-in/email-otp"
            | "/forget-password/email-otp"
            | "/email-otp/send-verification-otp"
            | "/email-otp/check-verification-otp"
            | "/email-otp/verify-email"
            | "/email-otp/request-password-reset"
            | "/email-otp/reset-password"
    )
}

fn success() -> Response {
    response(200, object!("success":true))
}

fn invalid_otp() -> Response {
    error(400, "INVALID_OTP", "Invalid OTP")
}

fn random_code() -> Result<String> {
    loop {
        let mut bytes = [0; 4];
        getrandom::fill(&mut bytes).map_err(internal)?;
        let value = u32::from_le_bytes(bytes);
        if value < 4_294_000_000 {
            return Ok(format!("{:06}", value % 1_000_000));
        }
    }
}

impl Call<'_> {
    pub(super) async fn otp_route(&self, body: &Value) -> Result<Response> {
        let Some(email) = body.get("email").and_then(Value::as_str) else {
            return Ok(validation(body, "email"));
        };
        let Some(email) = normalize_email(email) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        let kind = match self.route {
            "/sign-in/email-otp" => SIGN_IN,
            "/email-otp/verify-email" => VERIFY_EMAIL,
            "/email-otp/request-password-reset"
            | "/forget-password/email-otp"
            | "/email-otp/reset-password" => RESET_PASSWORD,
            _ => match body.get("type").and_then(Value::as_str) {
                Some(kind @ (SIGN_IN | VERIFY_EMAIL | RESET_PASSWORD)) => kind,
                _ => return Ok(error(400, "BAD_REQUEST", "Invalid OTP type")),
            },
        };
        let identifier = format!("{kind}-otp-{email}");
        if matches!(
            self.route,
            "/email-otp/send-verification-otp"
                | "/email-otp/request-password-reset"
                | "/forget-password/email-otp"
        ) {
            return self.send_otp(&email, &identifier, kind).await;
        }

        let sign_in = self.route == "/sign-in/email-otp";
        let failure_key = format!("fail|{email}");
        let limits = self.router.collection("identifier_limits");
        let Some(code) = body.get("otp").and_then(Value::as_str) else {
            let reply = validation(body, "otp");
            return if sign_in { self.sign_in_failure(&email, "email_otp", reply).await } else { Ok(reply) };
        };
        if !sign_in && let Some(retry) = self.failure_lock(&email).await? {
            let mut reply = api_error(429, "CANOPY_RATE_LIMITED", "Too many attempts; try again later");
            header(&mut reply, "retry-after", retry.to_string());
            return Ok(reply);
        }

        if self.route == "/email-otp/reset-password" {
            let Some(password) = body.get("password").and_then(Value::as_str) else {
                return Ok(validation(body, "password"));
            };
            if let Some(reply) = self.check_password(password) {
                return Ok(reply);
            }
            return self.reset_with_otp(&email, &identifier, code, password).await;
        }
        let check_only = self.route == "/email-otp/check-verification-otp";
        let filter = match self.otp_proof(&identifier, code).await? {
            Ok(filter) => filter,
            Err(reply) if sign_in => return self.sign_in_failure(&email, "email_otp", reply).await,
            Err(reply) => return self.otp_failure(&email, kind, reply).await,
        };
        if check_only {
            return Ok(if self.user(doc! {"email": &email}).await?.is_some() {
                success()
            } else {
                error(400, "USER_NOT_FOUND", "User not found")
            });
        }
        if !self.consume_otp(&identifier, filter).await? {
            return if sign_in {
                self.sign_in_failure(&email, "email_otp", invalid_otp()).await
            } else {
                Ok(invalid_otp())
            };
        }
        if sign_in {
            let (user, _) = self
                .passwordless_user(
                    &email,
                    body.get("name").and_then(Value::as_str),
                    body.get("image").and_then(Value::as_str),
                    "email_otp",
                )
                .await?;
            if self.banned(&user) || (Self::has_two_factor(&user) && !self.feature("two_factor")) {
                return self
                    .sign_in_failure(
                        &email,
                        "email_otp",
                        error(403, "FORBIDDEN", "Email OTP sign in is unavailable for this user"),
                    )
                    .await;
            }
            if Self::has_two_factor(&user) {
                let reply = self.begin_two_factor(&user, true, "email_otp").await?;
                limits.delete_one(doc! {"_id": failure_key}).await.map_err(internal)?;
                return Ok(reply);
            }
            let session = self.create_session(&user, true, "email_otp").await?;
            limits.delete_one(doc! {"_id": failure_key}).await.map_err(internal)?;
            let mut reply = response(200, object!("token":session.token, "user":user.public()));
            self.set_session(&mut reply, &session.token, true);
            return Ok(reply);
        }
        self.verify_with_otp(&email).await
    }

    /// Counts a refused code towards the address lock that password sign in shares, so codes issued one
    /// after another cannot be guessed three attempts at a time without end, and audits the refusal.
    async fn otp_failure(&self, email: &str, kind: &str, reply: Response) -> Result<Response> {
        self.count_failure(email).await?;
        self.audit(
            "auth.otp_failed",
            doc! {"type":"anonymous"},
            None,
            Some(doc! {"type":kind, "email":email, "status":i32::from(reply.status)}),
            true,
        )
        .await?;
        Ok(reply)
    }

    async fn send_otp(&self, email: &str, identifier: &str, kind: &str) -> Result<Response> {
        if kind != SIGN_IN && self.user(doc! {"email": email}).await?.is_none() {
            return Ok(success());
        }
        let verifications = self.router.collection("verifications");
        let prior = verifications
            .find_one(doc! {"identifier": identifier})
            .sort(doc! {"createdAt": -1, "_id": -1})
            .await
            .map_err(internal)?;
        let digest = Sha256::digest(identifier.as_bytes());
        let mut bytes = [0; 12];
        for (byte, source) in bytes.iter_mut().zip(digest) {
            *byte = source;
        }
        let id = prior
            .and_then(|proof| proof.get("_id").cloned())
            .unwrap_or_else(|| Bson::ObjectId(bson::oid::ObjectId::from_bytes(bytes)));
        let code = random_code()?;
        verifications.update_one(doc! {"_id": id}, doc! {
            "$set": {"identifier": identifier, "value": format!("{code}:0"), "expiresAt": self.date_after(300_000),
                "createdAt": self.now, "updatedAt": self.now}
        }).upsert(true).await.map_err(internal)?;
        self.router
            .mail
            .clone()
            .send(EmailKind::Otp, Recipient { email, url: None, otp: Some(&code), new_email: None })
            .await;
        Ok(success())
    }

    async fn otp_proof(
        &self,
        identifier: &str,
        code: &str,
    ) -> Result<std::result::Result<Document, Response>> {
        let verifications = self.router.collection("verifications");
        loop {
            let Some(proof) = verifications
                .find_one(doc! {"identifier": identifier})
                .sort(doc! {"createdAt": -1, "_id": -1})
                .await
                .map_err(internal)?
            else {
                return Ok(Err(invalid_otp()));
            };
            let id = proof.get("_id").ok_or_else(|| internal("Missing verification id"))?;
            let value = proof.get_str("value").map_err(internal)?;
            let expires = *proof.get_datetime("expiresAt").map_err(internal)?;
            let filter = doc! {"_id": id, "identifier": identifier, "value": value, "expiresAt": expires};
            let (stored, attempts) = value.rsplit_once(':').unwrap_or((value, "0"));
            let attempts = attempts.parse::<u8>().map_err(internal)?;
            let rejected = if expires <= self.now {
                Some(error(400, "OTP_EXPIRED", "OTP expired"))
            } else if attempts >= 3 {
                Some(error(403, "TOO_MANY_ATTEMPTS", "Too many attempts"))
            } else {
                None
            };
            if let Some(reply) = rejected {
                if self.consume_otp(identifier, filter).await? {
                    return Ok(Err(reply));
                }
            } else if bool::from(code.as_bytes().ct_eq(stored.as_bytes())) {
                return Ok(Ok(filter));
            } else if verifications
                .update_one(
                    filter,
                    doc! {
                        "$set": {"value": format!("{stored}:{}", attempts + 1), "updatedAt": self.now}
                    },
                )
                .await
                .map_err(internal)?
                .matched_count
                != 0
            {
                return Ok(Err(invalid_otp()));
            }
        }
    }

    async fn consume_otp(&self, identifier: &str, filter: Document) -> Result<bool> {
        let mut session = self.router.auth.client().start_session().await.map_err(internal)?;
        session
            .start_transaction()
            .and_run((self, identifier, filter), |session, (call, identifier, filter)| {
                Box::pin(async move { call.consume_otp_in(session, identifier, filter.clone()).await })
            })
            .await
            .map_err(internal)
    }

    async fn consume_otp_in(
        &self,
        session: &mut ClientSession,
        identifier: &str,
        filter: Document,
    ) -> MongoResult<bool> {
        let verifications = self.router.collection("verifications");
        let latest = verifications
            .find_one(doc! {"identifier": identifier})
            .sort(doc! {"createdAt": -1, "_id": -1})
            .session(&mut *session)
            .await?;
        if latest.as_ref().and_then(|proof| proof.get("_id")) != filter.get("_id")
            || verifications.delete_one(filter).session(&mut *session).await?.deleted_count == 0
        {
            return Ok(false);
        }
        verifications.delete_many(doc! {"identifier": identifier}).session(session).await?;
        Ok(true)
    }

    async fn verify_with_otp(&self, email: &str) -> Result<Response> {
        let Some(user) = self
            .router
            .auth
            .collection::<User>("users")
            .find_one_and_update(
                doc! {"email": email},
                doc! {"$set": {"emailVerified": true, "updatedAt": self.now}},
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(internal)?
        else {
            return Ok(error(400, "USER_NOT_FOUND", "User not found"));
        };
        if self.passwordless_blocked(&user) {
            return Ok(error(403, "FORBIDDEN", "Email OTP sign in is unavailable for this user"));
        }
        let session = self.create_session(&user, true, "email-otp/verify-email").await?;
        let mut reply = response(200, object!("status":true, "token":session.token, "user":user.public()));
        self.set_session(&mut reply, &session.token, true);
        Ok(reply)
    }

    async fn reset_with_otp(
        &self,
        email: &str,
        identifier: &str,
        code: &str,
        password: &str,
    ) -> Result<Response> {
        if let Err(reply) = self.otp_proof(identifier, code).await? {
            return self.otp_failure(email, RESET_PASSWORD, reply).await;
        }
        let Some(user) = self.user(doc! {"email": email}).await? else {
            return Ok(error(400, "USER_NOT_FOUND", "User not found"));
        };
        let (_, replacement) = self.derive(password, None).await?;
        let filter = match self.otp_proof(identifier, code).await? {
            Ok(filter) => filter,
            Err(reply) => return Ok(reply),
        };
        let mut session = self.router.auth.client().start_session().await.map_err(internal)?;
        let changed = session
            .start_transaction()
            .and_run(
                (self, &user, identifier, filter, replacement),
                |session, (call, user, identifier, filter, replacement)| {
                    Box::pin(async move {
                        let users = call.router.collection("users");
                        if users
                            .find_one(doc! {"_id": &user.id, "email": &user.email})
                            .session(&mut *session)
                            .await?
                            .is_none()
                            || !call.consume_otp_in(session, identifier, filter.clone()).await?
                        {
                            return Ok(false);
                        }
                        call.router
                            .collection("accounts")
                            .update_one(
                                doc! {"userId": &user.id, "providerId": "credential"},
                                doc! {"$set": {"password": replacement.clone(), "updatedAt": call.now},
                                "$setOnInsert": {"accountId": id_text(&user.id), "createdAt": call.now}},
                            )
                            .upsert(true)
                            .session(&mut *session)
                            .await?;
                        users
                            .update_one(
                                doc! {"_id": &user.id, "emailVerified": false},
                                doc! {"$set": {"emailVerified": true, "updatedAt": call.now}},
                            )
                            .session(&mut *session)
                            .await?;
                        call.end_sessions_in(session, doc! {"userId": &user.id}).await?;
                        Ok(true)
                    })
                },
            )
            .await
            .map_err(internal)?;
        if !changed {
            return Ok(invalid_otp());
        }
        self.router
            .collection("identifier_limits")
            .delete_one(doc! {"_id": format!("fail|{email}")})
            .await
            .map_err(internal)?;
        Ok(success())
    }
}
