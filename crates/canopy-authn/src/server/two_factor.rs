use super::*;
use crate::{
    secrets,
    totp::{self, TotpOptions},
};
use canopy_mongo::mongodb::{
    ClientSession,
    error::{Error as MongoError, Result as MongoResult},
};
use documents::{Session, TwoFactor, Verification};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

const CEREMONY_TTL: u64 = 600;
const FRESH_MS: i64 = 900_000;

pub(super) fn is_route(route: &str) -> bool {
    matches!(
        route,
        "/two-factor/enable"
            | "/two-factor/disable"
            | "/two-factor/get-totp-uri"
            | "/two-factor/generate-backup-codes"
            | "/two-factor/verify-totp"
            | "/two-factor/verify-backup-code"
    )
}

fn invalid_cookie() -> Response {
    error(401, "INVALID_TWO_FACTOR_COOKIE", "Invalid two factor cookie")
}

fn invalid_code(backup: bool) -> Response {
    if backup {
        error(401, "INVALID_BACKUP_CODE", "Invalid backup code")
    } else {
        error(401, "INVALID_CODE", "Invalid code")
    }
}

fn ceremony_location(target: &str, methods: &[&str]) -> String {
    let (base, fragment) = target.split_once('#').map_or((target, None), |(base, rest)| (base, Some(rest)));
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("twoFactorRedirect", "true")
        .append_pair("twoFactorMethods", &methods.join(","))
        .finish();
    let separator = if base.contains('?') { '&' } else { '?' };
    match fragment {
        Some(fragment) => format!("{base}{separator}{query}#{fragment}"),
        None => format!("{base}{separator}{query}"),
    }
}

fn new_backup_codes() -> Result<Vec<String>> {
    (0..10).map(|_| Ok(format!("{}-{}", random_token(5)?, random_token(5)?))).collect()
}

struct Challenge {
    id: String,
    proof: Verification,
}

impl Call<'_> {
    fn factor_uri(&self, secret: &str, email: &str, issuer: &str) -> String {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("secret", &totp::base32_encode(secret.as_bytes()))
            .append_pair("issuer", issuer)
            .append_pair("digits", "6")
            .append_pair("period", "30")
            .finish();
        format!(
            "otpauth://totp/{}:{}?{query}",
            totp::encode_uri_component(issuer),
            totp::encode_uri_component(email)
        )
    }

    fn encrypt_factor(&self, plain: &str) -> Result<String> {
        secrets::encrypt(&self.router.options.secret, plain)
            .ok_or_else(|| internal("Could not encrypt factor"))
    }

    fn decrypt_factor(&self, stored: &str) -> Result<Zeroizing<String>> {
        secrets::decrypt(&self.router.options.secret, stored)
            .map(Zeroizing::new)
            .ok_or_else(|| internal("Could not decrypt factor"))
    }

    fn proof(&self, identifier: &str, value: &str, expires_at: DateTime) -> Document {
        doc! {"_id": object_id(self.now), "identifier": identifier, "value": value,
        "expiresAt": expires_at, "createdAt": self.now, "updatedAt": self.now}
    }

    /// Answers a first factor of a user with a second factor: no session is created, and the signed
    /// ceremony cookie (also sent in `set-auth-ceremony`) carries the sign in to `/two-factor/verify-totp`
    /// or `/two-factor/verify-backup-code`, which create the `aal2` session.
    pub(super) async fn begin_two_factor(
        &self,
        user: &User,
        remember: bool,
        method: &str,
    ) -> Result<Response> {
        let (signed, methods) = self.open_ceremony(user, remember, method).await?;
        let mut reply = response(200, object!("twoFactorRedirect":true, "twoFactorMethods":methods));
        self.ceremony_cookies(&mut reply, &signed, remember);
        Ok(reply)
    }

    /// The same handoff for a sign in that reaches the application by a browser redirect (a provider
    /// callback or a magic link): `reply` becomes a redirect to `target` with `twoFactorRedirect=true` and
    /// the comma separated `twoFactorMethods` in its query, and the ceremony cookie set.
    pub(super) async fn redirect_to_two_factor(
        &self,
        mut reply: Response,
        user: &User,
        method: &str,
        target: &str,
    ) -> Result<Response> {
        let (signed, methods) = self.open_ceremony(user, true, method).await?;
        self.ceremony_cookies(&mut reply, &signed, true);
        reply.status = 302;
        reply.body.clear();
        header(&mut reply, "location", ceremony_location(target, &methods));
        Ok(reply)
    }

    /// Whether every first factor of this user must hand off to the second factor.
    pub(super) fn has_two_factor(user: &User) -> bool {
        user.extra.get_bool("twoFactorEnabled").unwrap_or(false)
    }

    async fn open_ceremony(
        &self,
        user: &User,
        remember: bool,
        method: &str,
    ) -> Result<(String, Vec<&'static str>)> {
        let id = format!("2fa-{}", random_token(20)?);
        let expires = self.date_after(CEREMONY_TTL as i64 * 1000);
        let provisional = self.new_session(user, remember, "aal1")?;
        let proofs = [
            self.proof(&id, &id_text(&user.id), expires),
            self.proof(&format!("2fa-attempts-{id}"), "0", expires),
        ];
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        let methods = tx
            .start_transaction()
            .and_run(
                (self, user, &provisional, &proofs, method),
                |tx, (call, user, provisional, proofs, method)| {
                    Box::pin(async move {
                        let factor = call
                            .router
                            .auth
                            .collection::<TwoFactor>("two_factors")
                            .find_one(doc! {"userId": &user.id, "verified": {"$ne": false}})
                            .session(&mut *tx)
                            .await?;
                        call.router
                            .collection("verifications")
                            .insert_many(proofs.iter())
                            .session(&mut *tx)
                            .await?;
                        call.router
                            .meta
                            .collection::<Document>("audit_log")
                            .insert_one(call.session_audit(provisional, method))
                            .session(&mut *tx)
                            .await?;
                        call.revoke_session_in(tx, provisional).await?;
                        Ok(if factor.is_some() { vec!["totp"] } else { Vec::new() })
                    })
                },
            )
            .await
            .map_err(internal)?;
        Ok((sign_value(&self.router.options.secret, &id), methods))
    }

    fn ceremony_cookies(&self, reply: &mut Response, signed: &str, remember: bool) {
        for kind in [AuthCookie::SessionToken, AuthCookie::SessionData] {
            self.set_cookie(reply, kind, "", Expiration::MaxAge(0));
        }
        if !remember {
            let signed = sign_value(&self.router.options.secret, "true");
            self.set_cookie(reply, AuthCookie::DontRemember, &signed, Expiration::Session);
        } else if !self.remember_session() {
            self.set_cookie(reply, AuthCookie::DontRemember, "", Expiration::MaxAge(0));
        }
        self.set_cookie(reply, AuthCookie::TwoFactor, signed, Expiration::MaxAge(CEREMONY_TTL));
        header(
            reply,
            "set-auth-ceremony",
            format!("{}={signed}", AuthCookie::TwoFactor.name(self.router.secure())),
        );
        header(reply, "access-control-expose-headers", "set-auth-token");
    }

    pub(super) async fn two_factor_route(&self, body: &Value) -> Result<Response> {
        if matches!(self.route, "/two-factor/verify-totp" | "/two-factor/verify-backup-code") {
            let Some(code) = body.get("code").and_then(Value::as_str) else {
                return Ok(validation(body, "code"));
            };
            return self
                .verify_factor(
                    code,
                    self.route == "/two-factor/verify-backup-code",
                    body.get("disableSession").and_then(Value::as_bool) == Some(true),
                )
                .await;
        }
        let Some(password) = body.get("password").and_then(Value::as_str) else {
            return Ok(validation(body, "password"));
        };
        let Some((session, user)) = self.authenticated().await? else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        if !self.fresh(&session) {
            return Ok(error(403, "SESSION_NOT_FRESH", "Session is not fresh"));
        }
        let stored = self.account(&user).await?.and_then(|account| account.password);
        if password.is_empty() || !self.derive(password, stored).await?.0 {
            return Ok(error(400, "INVALID_PASSWORD", "Invalid password"));
        }
        let issuer = &self.router.options.app_name;
        let factors = self.router.auth.collection::<TwoFactor>("two_factors");
        match self.route {
            "/two-factor/enable" => {
                let secret = Zeroizing::new(random_token(32)?);
                let backup_codes = new_backup_codes()?;
                let backup_json = Zeroizing::new(serde_json::to_string(&backup_codes).map_err(internal)?);
                let pending = TwoFactor {
                    id: Bson::ObjectId(object_id(self.now)),
                    secret: self.encrypt_factor(&secret)?,
                    backup_codes: self.encrypt_factor(&backup_json)?,
                    user_id: user.id.clone(),
                    extra: doc! {"verified": false, "failedVerificationCount": 0},
                };
                if let Some(reply) = self.enrol_factor(&session, &pending).await? {
                    return Ok(reply);
                }
                let issuer = body.get("issuer").and_then(Value::as_str).unwrap_or(issuer);
                Ok(response(
                    200,
                    object!("method":"totp", "totpURI":self.factor_uri(&secret, &user.email, issuer), "backupCodes":backup_codes),
                ))
            }
            "/two-factor/get-totp-uri" => {
                let Some(factor) = factors.find_one(doc! {"userId": &user.id}).await.map_err(internal)?
                else {
                    return Ok(error(400, "TOTP_NOT_ENABLED", "TOTP not enabled"));
                };
                let secret = self.decrypt_factor(&factor.secret)?;
                Ok(response(200, object!("totpURI":self.factor_uri(&secret, &user.email, issuer))))
            }
            "/two-factor/generate-backup-codes" => {
                let codes = new_backup_codes()?;
                let encrypted = self.encrypt_factor(&serde_json::to_string(&codes).map_err(internal)?)?;
                let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
                let failure = tx
                    .start_transaction()
                    .and_run((self, &session, &user, &encrypted), |tx, (call, session, user, encrypted)| {
                        Box::pin(async move {
                            if !call.active_session_in(tx, session).await? {
                                return Ok(Some(error(401, "UNAUTHORIZED", "Unauthorized")));
                            }
                            let updated = call
                                .router
                                .collection("two_factors")
                                .update_one(
                                    doc! {"userId": &user.id, "verified": {"$ne": false}},
                                    doc! {"$set": {"backupCodes": encrypted}},
                                )
                                .session(&mut *tx)
                                .await?;
                            if updated.matched_count == 0 {
                                return Ok(Some(error(
                                    400,
                                    "TWO_FACTOR_NOT_ENABLED",
                                    "Two factor isn't enabled",
                                )));
                            }
                            call.factor_audit_in(tx, "auth.mfa_backup_codes_generated").await?;
                            Ok(None)
                        })
                    })
                    .await
                    .map_err(internal)?;
                if let Some(reply) = failure {
                    return Ok(reply);
                }
                Ok(response(200, object!("status":true, "backupCodes":codes)))
            }
            "/two-factor/disable" => {
                let mut replacement = self.new_session(&user, true, "aal1")?;
                replacement.ip_address.clone_from(&session.ip_address);
                replacement.user_agent.clone_from(&session.user_agent);
                let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
                let changed = tx
                    .start_transaction()
                    .and_run(
                        (self, &user, &session, &replacement),
                        |tx, (call, user, session, replacement)| {
                            Box::pin(async move {
                                if !call.active_session_in(tx, session).await? {
                                    return Ok(false);
                                }
                                call.router
                                    .collection("users")
                                    .update_one(
                                        doc! {"_id": &user.id},
                                        doc! {"$set":{"twoFactorEnabled":false, "updatedAt": call.now}},
                                    )
                                    .session(&mut *tx)
                                    .await?;
                                call.router
                                    .collection("two_factors")
                                    .delete_one(doc! {"userId": &user.id})
                                    .session(&mut *tx)
                                    .await?;
                                call.insert_session_in(tx, replacement, "two_factor").await?;
                                call.end_sessions_in(tx, doc! {"_id": &session.id}).await?;
                                call.factor_audit_in(tx, "auth.mfa_disabled").await?;
                                Ok(true)
                            })
                        },
                    )
                    .await
                    .map_err(internal)?;
                if !changed {
                    return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
                }
                let mut reply = status();
                self.set_session(&mut reply, &replacement.token, self.remember_session());
                Ok(reply)
            }
            _ => Ok(empty(404)),
        }
    }

    async fn enrol_factor(&self, session: &Session, pending: &TwoFactor) -> Result<Option<Response>> {
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        let result = tx
            .start_transaction()
            .and_run((self, session, pending), |tx, (call, session, pending)| {
                Box::pin(async move {
                    if !call.active_session_in(tx, session).await? {
                        return Ok(Some(error(401, "UNAUTHORIZED", "Unauthorized")));
                    }
                    let factors = call.router.auth.collection::<TwoFactor>("two_factors");
                    let filter = doc! {"userId": &pending.user_id};
                    if let Some(existing) = factors.find_one(filter).session(&mut *tx).await? {
                        if existing.extra.get_bool("verified").ok() != Some(false) {
                            return Ok(Some(error(400, "TOTP_ALREADY_ENABLED", "TOTP is already enabled")));
                        }
                        factors
                            .update_one(
                                doc! {"_id": existing.id},
                                doc! {"$set": {
                                    "secret": &pending.secret, "backupCodes": &pending.backup_codes
                                }},
                            )
                            .session(&mut *tx)
                            .await?;
                    } else {
                        factors.insert_one(*pending).session(&mut *tx).await?;
                    }
                    call.factor_audit_in(tx, "auth.mfa_enrolment_started").await?;
                    Ok(None)
                })
            })
            .await;
        match result {
            Err(err)
                if matches!(err.kind.as_ref(), canopy_mongo::mongodb::error::ErrorKind::Write(
                canopy_mongo::mongodb::error::WriteFailure::WriteError(detail)) if detail.code == 11000) =>
            {
                Ok(Some(error(409, "CONFLICT", "Two factor enrolment changed. Please try again.")))
            }
            result => result.map_err(internal),
        }
    }

    async fn factor_audit_in(&self, tx: &mut ClientSession, action: &str) -> MongoResult<()> {
        self.router
            .meta
            .collection::<Document>("audit_log")
            .insert_one(doc! {
                "_id": object_id(self.now), "action":action, "actor":{"type":"user"},
                "ip":self.ip(), "at":self.now
            })
            .session(tx)
            .await?;
        Ok(())
    }

    async fn active_session_in(&self, tx: &mut ClientSession, session: &Session) -> MongoResult<bool> {
        Ok(self
            .router
            .collection("sessions")
            .find_one(doc! {"_id": &session.id, "expiresAt": {"$gt": self.now}})
            .session(tx)
            .await?
            .is_some())
    }

    async fn verify_factor(&self, code: &str, backup: bool, disable_session: bool) -> Result<Response> {
        let authenticated = self.authenticated().await?;
        let (session, user, challenge) = if let Some((session, user)) = authenticated {
            (Some(session), user, None)
        } else {
            let Some(id) = self
                .cookie(AuthCookie::TwoFactor)
                .or_else(|| self.ceremony_cookie(AuthCookie::TwoFactor))
                .and_then(|cookie| verify_session(&self.router.options.secret, &cookie))
                .filter(|id| id.starts_with("2fa-") && !id.starts_with("2fa-attempts-"))
            else {
                return Ok(invalid_cookie());
            };
            let Some(proof) = self
                .router
                .auth
                .collection::<Verification>("verifications")
                .find_one(doc! {"identifier": &id, "expiresAt": {"$gt": self.now}})
                .await
                .map_err(internal)?
            else {
                return Ok(invalid_cookie());
            };
            let ids = match bson::oid::ObjectId::parse_str(&proof.value) {
                Ok(id) => vec![Bson::ObjectId(id), Bson::String(proof.value.clone())],
                Err(_) => vec![Bson::String(proof.value.clone())],
            };
            let mut users = self
                .router
                .auth
                .collection::<User>("users")
                .find(doc! {"_id": {"$in": ids}})
                .limit(2)
                .await
                .map_err(internal)?;
            let Some(user) = users.try_next().await.map_err(internal)? else {
                return Ok(invalid_cookie());
            };
            if users.try_next().await.map_err(internal)?.is_some()
                || self.banned(&user)
                || !user.extra.get_bool("twoFactorEnabled").unwrap_or(false)
            {
                return Ok(invalid_cookie());
            }
            (None, user, Some(Challenge { id, proof }))
        };
        let remember = self.remember_session();
        let mut replacement = self.new_session(&user, session.is_some() || remember, "aal2")?;
        if let Some(session) = &session {
            replacement.ip_address.clone_from(&session.ip_address);
            replacement.user_agent.clone_from(&session.user_agent);
        }
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        let input = FactorVerification {
            user: &user,
            session: session.as_ref(),
            challenge: challenge.as_ref(),
            replacement: &replacement,
            code,
            backup,
            disable_session: backup && disable_session,
            remember,
        };
        tx.start_transaction()
            .and_run((self, &input), |tx, (call, input)| {
                Box::pin(async move { call.verify_factor_in(tx, input).await })
            })
            .await
            .map_err(internal)
    }

    async fn verify_factor_in(
        &self,
        tx: &mut ClientSession,
        input: &FactorVerification<'_>,
    ) -> MongoResult<Response> {
        let FactorVerification {
            user,
            session,
            challenge,
            replacement,
            code,
            backup,
            disable_session,
            remember,
        } = *input;
        if let Some(session) = session
            && !self.active_session_in(tx, session).await?
        {
            return Ok(invalid_cookie());
        }
        let factors = self.router.auth.collection::<TwoFactor>("two_factors");
        let factor = factors.find_one(doc! {"userId": &user.id}).session(&mut *tx).await?;
        let Some(factor) = factor
            .filter(|factor| challenge.is_none() || factor.extra.get_bool("verified").ok() != Some(false))
        else {
            return Ok(if backup {
                error(400, "BACKUP_CODES_NOT_ENABLED", "Backup codes aren't enabled")
            } else {
                error(400, "TOTP_NOT_ENABLED", "TOTP not enabled")
            });
        };
        let verifications = self.router.collection("verifications");
        let factor_filter = doc! {"_id": &factor.id};
        let mut count = factor.extra.get_i32("failedVerificationCount").unwrap_or_default().clamp(0, 10);
        let mut attempt = None;
        if let Some(challenge) = challenge {
            if let Ok(locked) = factor.extra.get_datetime("lockedUntil") {
                if *locked > self.now {
                    return Ok(error(
                        429,
                        "ACCOUNT_TEMPORARILY_LOCKED",
                        "Too many failed verification attempts. Your account is temporarily locked. Please try again later.",
                    ));
                }
                count = 0;
            }
            let identifier = format!("2fa-attempts-{}", challenge.id);
            let Some(proof) = verifications
                .find_one_and_delete(doc! {
                    "identifier": &identifier, "expiresAt": {"$gt": self.now},
                })
                .session(&mut *tx)
                .await?
            else {
                return Ok(invalid_cookie());
            };
            let previous =
                proof.get_str("value").ok().and_then(|value| value.parse::<u8>().ok()).unwrap_or(5);
            if previous >= 5 {
                verifications.delete_one(doc! {"identifier": &challenge.id}).session(&mut *tx).await?;
                let mut reply = error(
                    400,
                    "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
                    "Too many attempts. Please request a new code.",
                );
                self.set_cookie(&mut reply, AuthCookie::TwoFactor, "", Expiration::MaxAge(0));
                return Ok(reply);
            }
            attempt = Some((identifier, previous, challenge.proof.expires_at));
        }
        let mut update = doc! {};
        let valid = if backup {
            let decrypted = self.decrypt_factor(&factor.backup_codes).map_err(MongoError::custom)?;
            let mut codes = serde_json::from_str::<Vec<String>>(&decrypted).map_err(MongoError::custom)?;
            let length = codes.len();
            codes.retain(|candidate| !bool::from(candidate.as_bytes().ct_eq(code.as_bytes())));
            if length != codes.len() {
                let plain = Zeroizing::new(serde_json::to_string(&codes).map_err(MongoError::custom)?);
                update.insert("backupCodes", self.encrypt_factor(&plain).map_err(MongoError::custom)?);
            }
            length != codes.len()
        } else {
            let secret = self.decrypt_factor(&factor.secret).map_err(MongoError::custom)?;
            totp::verify_totp(
                secret.as_bytes(),
                code,
                self.now.timestamp_millis(),
                TotpOptions::default(),
                1,
                None,
            )
            .is_some()
        };
        if !valid {
            if let Some((identifier, previous, expires)) = attempt {
                verifications
                    .insert_one(self.proof(&identifier, &(previous + 1).to_string(), expires))
                    .session(&mut *tx)
                    .await?;
                let locked = if count >= 9 { Bson::DateTime(self.date_after(FRESH_MS)) } else { Bson::Null };
                factors
                    .update_one(
                        factor_filter,
                        doc! {"$set": {"failedVerificationCount": count + 1, "lockedUntil": locked}},
                    )
                    .session(tx)
                    .await?;
            }
            return Ok(invalid_code(backup));
        }
        let confirmed = !backup && session.is_some() && factor.extra.get_bool("verified").ok() != Some(true);
        if confirmed {
            update.insert("verified", true);
            self.router
                .collection("users")
                .update_one(
                    doc! {"_id": &user.id},
                    doc! {"$set":{"twoFactorEnabled":true, "updatedAt": self.now}},
                )
                .session(&mut *tx)
                .await?;
        }
        if challenge.is_some() && (count != 0 || factor.extra.get_datetime("lockedUntil").is_ok()) {
            update.insert("failedVerificationCount", 0);
            update.insert("lockedUntil", Bson::Null);
        }
        if !update.is_empty() {
            factors.update_one(factor_filter, doc! {"$set": update}).session(&mut *tx).await?;
        }
        if let Some(challenge) = challenge
            && !disable_session
        {
            let consumed = verifications
                .delete_one(doc! {"identifier": &challenge.id,
                "value": &challenge.proof.value, "expiresAt": {"$gt": self.now}})
                .session(&mut *tx)
                .await?;
            if consumed.deleted_count != 1 {
                return Err(MongoError::custom("Two factor challenge changed during verification"));
            }
            self.insert_session_in(tx, replacement, "two_factor").await?;
            let mut reply = response(200, object!("token":replacement.token, "user":user.public()));
            self.set_session(&mut reply, &replacement.token, remember);
            self.set_cookie(&mut reply, AuthCookie::TwoFactor, "", Expiration::MaxAge(0));
            return Ok(reply);
        }
        let Some(session) = session else {
            return Ok(response(200, object!("user":user.public())));
        };
        let mut reply = response(200, object!("token":session.token, "user":user.public()));
        if confirmed && !user.extra.get_bool("twoFactorEnabled").unwrap_or(false) {
            self.insert_session_in(tx, replacement, "two_factor").await?;
            self.end_sessions_in(tx, doc! {"_id": &session.id}).await?;
            self.set_session(&mut reply, &replacement.token, remember);
        }
        Ok(reply)
    }
}

struct FactorVerification<'a> {
    user: &'a User,
    session: Option<&'a Session>,
    challenge: Option<&'a Challenge>,
    replacement: &'a Session,
    code: &'a str,
    backup: bool,
    disable_session: bool,
    remember: bool,
}
