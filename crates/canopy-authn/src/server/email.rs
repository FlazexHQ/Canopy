use base64ct::{Base64UrlUnpadded, Encoding};
use ring::hmac;
use serde::Deserialize;

use super::password::normalize_email;
use super::*;

const MAIL_JWT_HEADER: &str = "eyJhbGciOiJIUzI1NiJ9";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MailClaims {
    email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    update_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_type: Option<EmailChange>,
    user_id: String,
    iat: i64,
    exp: i64,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(super) enum EmailChange {
    #[serde(rename = "change-email-confirmation")]
    Confirm,
    #[serde(rename = "change-email-verification")]
    Verify,
}

impl Call<'_> {
    fn mail_key(&self) -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA256, self.router.options.secret.as_bytes())
    }

    pub(super) async fn send_verification(
        &self,
        user: &User,
        callback: &str,
        change: Option<(EmailChange, &str)>,
    ) {
        let iat = self.now.timestamp_millis().div_euclid(1000);
        let claims = MailClaims {
            email: user.email.clone(),
            update_to: change.map(|(_, email)| email.into()),
            request_type: change.map(|(kind, _)| kind),
            user_id: id_text(&user.id),
            iat,
            exp: iat + 3600,
        };
        let Ok(payload) = serde_json::to_vec(&claims) else { return };
        let signed = format!("{MAIL_JWT_HEADER}.{}", Base64UrlUnpadded::encode_string(&payload));
        let tag = hmac::sign(&self.mail_key(), signed.as_bytes());
        let url = format!(
            "{}/auth/v1/verify-email?token={signed}.{}&callbackURL={}",
            self.router.public_url(),
            Base64UrlUnpadded::encode_string(tag.as_ref()),
            crate::cookies::encode(callback)
        );
        let (kind, email, new_email) = match change {
            Some((EmailChange::Confirm, next)) => (EmailKind::EmailChange, user.email.as_str(), Some(next)),
            Some((EmailChange::Verify, next)) => (EmailKind::Verification, next, None),
            None => (EmailKind::Verification, user.email.as_str(), None),
        };
        self.router
            .mail
            .clone()
            .send(kind, Recipient { email, url: Some(&url), new_email, ..Recipient::default() })
            .await;
    }

    fn verify_mail_jwt(&self, token: &str) -> Option<MailClaims> {
        let (signed, signature) = token.rsplit_once('.')?;
        let (header, payload) = signed.split_once('.')?;
        if header != MAIL_JWT_HEADER {
            return None;
        }
        let signature = Base64UrlUnpadded::decode_vec(signature).ok()?;
        hmac::verify(&self.mail_key(), signed.as_bytes(), &signature).ok()?;
        serde_json::from_slice(&Base64UrlUnpadded::decode_vec(payload).ok()?).ok()
    }

    pub(super) async fn resend(&self, body: &Value) -> Result<Response> {
        let Some(email) = body.get("email").and_then(Value::as_str) else {
            return Ok(validation(body, "email"));
        };
        let Some(email) = normalize_email(email) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        if let Some(user) = self.user(doc! {"email": email, "emailVerified": false}).await? {
            self.send_verification(
                &user,
                body.get("callbackURL").and_then(Value::as_str).unwrap_or("/"),
                None,
            )
            .await;
        }
        Ok(status())
    }

    /// Verifies the address of `user` for the first time and returns whether this call verified it. Unless
    /// the request proves it comes from the browser that signed the account up, the same transaction removes
    /// the account's password and ends its sessions: whoever set that password may not control the address.
    pub(super) async fn confirm_address(&self, user: &User) -> Result<bool> {
        let proven = self.signed_up_here(user);
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        let outcome = tx
            .start_transaction()
            .and_run((self, user, proven), |tx, (call, user, proven)| {
                Box::pin(async move {
                    let verified = call
                        .router
                        .collection("users")
                        .update_one(
                            doc! {"_id": &user.id, "email": &user.email, "emailVerified": false},
                            doc! {"$set": {"emailVerified": true, "updatedAt": call.now}},
                        )
                        .session(&mut *tx)
                        .await?;
                    if verified.modified_count == 0 {
                        return Ok((false, false));
                    }
                    if *proven {
                        return Ok((true, false));
                    }
                    let removed = call
                        .router
                        .collection("accounts")
                        .delete_many(doc! {"userId": &user.id, "providerId": "credential"})
                        .session(&mut *tx)
                        .await?;
                    if removed.deleted_count == 0 {
                        return Ok((true, false));
                    }
                    call.end_sessions_in(tx, doc! {"userId": &user.id}).await?;
                    Ok((true, true))
                })
            })
            .await
            .map_err(internal)?;
        if outcome.1 {
            let uid = id_text(&user.id);
            self.audit(
                "auth.password_removed",
                doc! {"type": "user", "id": &uid},
                Some(doc! {"type": "user", "id": &uid}),
                Some(doc! {"reason": "address verified without the sign up proof"}),
                true,
            )
            .await?;
        }
        Ok(outcome.0)
    }

    pub(super) async fn verify_email(&self, query: &BTreeMap<String, String>) -> Result<Response> {
        let callback = query.get("callbackURL").map(String::as_str).unwrap_or("/");
        let Some(claims) = query.get("token").and_then(|token| self.verify_mail_jwt(token)) else {
            return Ok(redirect_parameter(callback, "error", "INVALID_TOKEN"));
        };
        if claims.exp <= self.now.timestamp_millis().div_euclid(1000) {
            return Ok(redirect_parameter(callback, "error", "TOKEN_EXPIRED"));
        }
        let Some(user) = self
            .user(doc! {"email": &claims.email})
            .await?
            .filter(|user| id_text(&user.id) == claims.user_id && !self.banned(user))
        else {
            return Ok(redirect_parameter(callback, "error", "USER_NOT_FOUND"));
        };
        let mut reply = redirect(callback);
        match (claims.request_type, claims.update_to.as_deref()) {
            (Some(EmailChange::Confirm), Some(next)) => {
                self.send_verification(&user, callback, Some((EmailChange::Verify, next))).await;
            }
            (Some(EmailChange::Verify), Some(next)) => {
                if self.user(doc! {"email": next}).await?.is_some() {
                    return Ok(redirect_parameter(callback, "error", "USER_ALREADY_EXISTS"));
                }
                self.router
                    .collection("users")
                    .update_one(
                        doc! {"_id": &user.id, "email": &claims.email},
                        doc! {"$set": {"email":next, "emailVerified":true, "updatedAt":self.now}},
                    )
                    .await
                    .map_err(internal)?;
            }
            (None, None) if !user.email_verified => {
                if self.confirm_address(&user).await?
                    && !user.extra.get_bool("twoFactorEnabled").unwrap_or(false)
                {
                    if let Some((session, _)) =
                        self.authenticated().await?.filter(|(_, current)| current.id == user.id)
                    {
                        self.set_session(&mut reply, &session.token, self.remember_session());
                    } else {
                        let session = self.create_session(&user, true, "email_verification").await?;
                        self.set_session(&mut reply, &session.token, true);
                    }
                }
            }
            (None, None) => {}
            _ => return Ok(redirect_parameter(callback, "error", "INVALID_TOKEN")),
        }
        Ok(reply)
    }

    pub(super) async fn change_email(&self, body: &Value, user: &User) -> Result<Response> {
        let Some(next) = body.get("newEmail").and_then(Value::as_str) else {
            return Ok(validation(body, "newEmail"));
        };
        let Some(next) = normalize_email(next) else {
            return Ok(error(400, "INVALID_EMAIL", "Invalid email"));
        };
        if user.email == next {
            return Ok(error(400, "EMAIL_IS_THE_SAME", "Email is the same"));
        }
        if self.user(doc! {"email": &next}).await?.is_none() {
            let callback = body.get("callbackURL").and_then(Value::as_str).unwrap_or("/");
            let change = if user.email_verified { EmailChange::Confirm } else { EmailChange::Verify };
            self.send_verification(user, callback, Some((change, &next))).await;
        }
        self.audit("auth.email_change_requested", doc! {"type":"user"}, None, None, true).await?;
        Ok(status())
    }
}

pub(super) fn redirect(location: &str) -> Response {
    let mut response = empty(302);
    header(&mut response, "location", location);
    response
}

pub(super) fn redirect_parameter(location: &str, name: &str, value: &str) -> Response {
    let encoded = crate::cookies::encode(value);
    let (location, fragment) = location.split_once('#').unwrap_or((location, ""));
    let separator = if location.contains('?') { '&' } else { '?' };
    let mut target = format!("{location}{separator}{name}={encoded}");
    if !fragment.is_empty() {
        target.push('#');
        target.push_str(fragment);
    }
    redirect(&target)
}
