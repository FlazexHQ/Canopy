use std::collections::BTreeMap;

use bson::{Bson, Document, doc};
use canopy_http::{Body, Response};
use futures_util::TryStreamExt as _;
use ring::hmac;
use serde::{Deserialize, Serialize};
use serde_json_bytes::Value;
use zeroize::Zeroizing;

use super::providers::{Identity, IdentityError, Provider, Tokens};
use crate::{
    cookies::{AuthCookie, Expiration, sign_value, verify_session},
    secrets,
    server::{
        Call, Result,
        documents::{Account, User, id_text},
        duplicate_key, empty, error, header, internal, object_id, random_token_from, response, validation,
    },
};

const RANDOM_ALPHABET: &[u8; 64] = b"abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const STATE_TTL_MS: i64 = 600_000;
const CALLBACK_FIELDS: [&str; 7] =
    ["code", "error", "device_id", "error_description", "state", "user", "iss"];
const BANNED_MESSAGE: &str =
    "You have been banned from this application. Please contact support if you believe this is an error.";

#[derive(Serialize, Deserialize)]
struct FlowState {
    #[serde(rename = "callbackURL")]
    callback_url: String,
    #[serde(rename = "codeVerifier")]
    code_verifier: String,
    #[serde(rename = "errorURL", default, skip_serializing_if = "Option::is_none")]
    error_url: Option<String>,
    #[serde(rename = "newUserURL", default, skip_serializing_if = "Option::is_none")]
    new_user_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    link: Option<LinkState>,
    #[serde(rename = "expiresAt")]
    expires_at: serde_json::Number,
    #[serde(rename = "requestSignUp", default, skip_serializing_if = "Option::is_none")]
    request_sign_up: Option<bool>,
    #[serde(rename = "idTokenNonce", default, skip_serializing_if = "Option::is_none")]
    id_token_nonce: Option<String>,
    #[serde(rename = "oauthState", default, skip_serializing_if = "Option::is_none")]
    oauth_state: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkState {
    user_id: String,
    email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    encrypted_session_token: Option<String>,
}

fn link_session_key(secret: &str) -> Zeroizing<String> {
    let salt = hmac::Key::new(hmac::HMAC_SHA256, b"better-auth:oauth-encryption:v1");
    let extracted = hmac::sign(&salt, secret.as_bytes());
    let key = hmac::Key::new(hmac::HMAC_SHA256, extracted.as_ref());
    Zeroizing::new(hex::encode(hmac::sign(&key, b"better-auth:oauth-link-session-token:v1\x01")))
}

pub(super) fn matching_ids(id: &str) -> Vec<Bson> {
    let mut ids = vec![Bson::String(id.to_owned())];
    if let Ok(object_id) = bson::oid::ObjectId::parse_str(id)
        && object_id.to_hex() == id
    {
        ids.push(Bson::ObjectId(object_id));
    }
    ids
}

fn optional_text<'a>(body: &'a Value, field: &str) -> std::result::Result<Option<&'a str>, Response> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.as_str())),
        Some(_) => Err(validation(body, field)),
    }
}

fn id_token_validation(value: Option<&Value>, field: &str, expected: &str) -> Response {
    let received = match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::Array(_)) => "array",
        Some(Value::String(_)) => "string",
        Some(Value::Object(_)) => "object",
    };
    error(
        400,
        "VALIDATION_ERROR",
        &format!("[body.{field}] Invalid input: expected {expected}, received {received}"),
    )
}

fn with_query(target: &str, pairs: &[(&str, &str)]) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        query.append_pair(name, value);
    }
    let separator = if target.contains('?') { '&' } else { '?' };
    format!("{target}{separator}{}", query.finish())
}

fn redirect(mut reply: Response, location: &str) -> Response {
    reply.status = 302;
    header(&mut reply, "location", location);
    reply
}

enum Outcome {
    SignedIn(Box<User>, bool),
    Refused(&'static str),
}

impl Call<'_> {
    pub(in crate::server) async fn sign_in_social(&self, body: &Value) -> Result<Response> {
        let linking = self.route == "/link-social";
        let Some(provider_id) = body.get("provider").and_then(Value::as_str) else {
            return Ok(validation(body, "provider"));
        };
        let mut fields = BTreeMap::new();
        for field in ["callbackURL", "errorCallbackURL", "newUserCallbackURL", "loginHint"] {
            match optional_text(body, field) {
                Ok(value) => {
                    fields.insert(field, value.filter(|value| !value.is_empty()));
                }
                Err(reply) => return Ok(reply),
            }
        }
        let scopes: Vec<String> = match body.get("scopes") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(scopes)) if scopes.iter().all(Value::is_string) => {
                scopes.iter().filter_map(Value::as_str).map(str::to_owned).collect()
            }
            Some(_) => {
                return Ok(error(400, "VALIDATION_ERROR", "[body.scopes] Invalid input: expected array"));
            }
        };
        let link = if linking {
            let Some((session, user)) = self.authenticated().await? else {
                return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
            };
            let encrypted = secrets::encrypt(&link_session_key(&self.router.options.secret), &session.token)
                .ok_or_else(|| internal("Could not encrypt the account link session"))?;
            Some(LinkState {
                user_id: id_text(&user.id),
                email: user.email,
                encrypted_session_token: Some(encrypted),
            })
        } else {
            None
        };
        let Some(provider) = self.router.oauth.provider(provider_id).await else {
            return Ok(error(404, "PROVIDER_NOT_FOUND", "Provider not found"));
        };
        if let Some(token) = body.get("idToken") {
            if !linking {
                return self.sign_in_id_token(&provider, token).await;
            }
            if !token.is_null() {
                return Ok(error(404, "ID_TOKEN_NOT_SUPPORTED", "id_token not supported"));
            }
        }
        let state = random_token_from(32, RANDOM_ALPHABET)?;
        let verifier = random_token_from(128, RANDOM_ALPHABET)?;
        let nonce =
            if provider.requires_nonce() { Some(random_token_from(32, RANDOM_ALPHABET)?) } else { None };
        let field = |name: &str| fields.get(name).copied().flatten().map(str::to_owned);
        let expires = self.date_after(STATE_TTL_MS);
        let flow = FlowState {
            callback_url: field("callbackURL").unwrap_or_else(|| self.router.public_url().to_owned()),
            code_verifier: verifier.clone(),
            error_url: field("errorCallbackURL"),
            new_user_url: if linking { None } else { field("newUserCallbackURL") },
            link,
            expires_at: expires.timestamp_millis().into(),
            request_sign_up: body.get("requestSignUp").and_then(Value::as_bool),
            id_token_nonce: nonce.clone(),
            oauth_state: Some(state.clone()),
        };
        let redirect_uri = format!("{}/auth/v1/callback/{}", self.router.public_url(), provider.id());
        let Some(url) = provider.authorization_url(
            &redirect_uri,
            &state,
            &verifier,
            nonce.as_deref(),
            &scopes,
            field("loginHint").as_deref(),
        ) else {
            return Err(internal("Could not build the authorization URL"));
        };
        self.router
            .collection("verifications")
            .insert_one(doc! {
                "_id": object_id(self.now), "identifier": format!("auth-state:{state}"),
                "value": serde_json::to_string(&flow).map_err(internal)?,
                "expiresAt": expires, "createdAt": self.now, "updatedAt": self.now,
            })
            .await
            .map_err(internal)?;
        let follow = body.get("disableRedirect").and_then(Value::as_bool) != Some(true);
        let mut reply = response(200, object!("url": url.as_str(), "redirect": follow));
        if follow {
            header(&mut reply, "location", url.as_str());
        }
        self.set_cookie(
            &mut reply,
            AuthCookie::State,
            &sign_value(&self.router.options.secret, &state),
            Expiration::MaxAge(300),
        );
        Ok(reply)
    }

    fn callback_params(&self, query: &str) -> Option<BTreeMap<String, String>> {
        let mut params = BTreeMap::new();
        for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if CALLBACK_FIELDS.contains(&name.as_ref())
                && params.insert(name.into_owned(), value.into_owned()).is_some()
            {
                return None;
            }
        }
        Some(params)
    }

    async fn sign_in_id_token(&self, provider: &Provider<'_>, body: &Value) -> Result<Response> {
        if !body.is_object() {
            return Ok(id_token_validation(Some(body), "idToken", "object"));
        }
        let Some(token) = body.get("token").and_then(Value::as_str) else {
            return Ok(id_token_validation(body.get("token"), "idToken.token", "string"));
        };
        for key in ["nonce", "accessToken", "refreshToken"] {
            if let Some(value) = body.get(key).filter(|value| !value.is_string()) {
                return Ok(id_token_validation(Some(value), &format!("idToken.{key}"), "string"));
            }
        }
        if let Some(value) = body.get("expiresAt").filter(|value| !value.is_number()) {
            return Ok(id_token_validation(Some(value), "idToken.expiresAt", "number"));
        }
        if let Some(user) = body.get("user") {
            if !user.is_object() {
                return Ok(id_token_validation(Some(user), "idToken.user", "object"));
            }
            if let Some(email) = user.get("email").filter(|value| !value.is_string()) {
                return Ok(id_token_validation(Some(email), "idToken.user.email", "string"));
            }
            if let Some(name) = user.get("name") {
                if !name.is_object() {
                    return Ok(id_token_validation(Some(name), "idToken.user.name", "object"));
                }
                for key in ["firstName", "lastName"] {
                    if let Some(value) = name.get(key).filter(|value| !value.is_string()) {
                        return Ok(id_token_validation(
                            Some(value),
                            &format!("idToken.user.name.{key}"),
                            "string",
                        ));
                    }
                }
            }
        }
        if !provider.supports_id_token() {
            return Ok(error(404, "ID_TOKEN_NOT_SUPPORTED", "id_token not supported"));
        }
        let apple_user = body.get("user").map(Value::to_string);
        let tokens = Tokens {
            access_token: body.get("accessToken").and_then(Value::as_str).map(str::to_owned),
            id_token: Some(token.to_owned()),
            refresh_token: None,
            access_expires_in_s: None,
            refresh_expires_in_s: None,
            scopes: None,
        };
        let identity = match provider
            .identity(
                &self.router.oauth,
                &tokens,
                body.get("nonce").and_then(Value::as_str),
                apple_user.as_deref(),
                true,
                self.now.timestamp_millis(),
            )
            .await
        {
            Ok(identity) => identity,
            Err(IdentityError::InvalidToken) => return Ok(error(401, "INVALID_TOKEN", "Invalid token")),
            Err(IdentityError::UserInfo) => {
                return Ok(error(401, "FAILED_TO_GET_USER_INFO", "Failed to get user info"));
            }
        };
        let Some(email) = identity.email.as_deref().map(str::to_lowercase) else {
            return Ok(error(401, "USER_EMAIL_NOT_FOUND", "User email not found"));
        };
        let user = match self.oauth_user(provider, &identity, &tokens, &email, "sign-in/social").await? {
            Outcome::SignedIn(user, _) => user,
            Outcome::Refused(code) => return Ok(error(401, "OAUTH_LINK_ERROR", &code.replace('_', " "))),
        };
        if self.banned(&user) {
            return Ok(error(403, "BANNED_USER", BANNED_MESSAGE));
        }
        let session = self.create_session(&user, true, "sign-in/social").await?;
        let mut reply =
            response(200, object!("redirect": false, "token": session.token, "user": user.public()));
        self.set_session(&mut reply, &session.token, true);
        Ok(reply)
    }

    fn callback_post(&self, provider_id: &str, query: &str) -> Response {
        let base = format!("{}/auth/v1", self.router.public_url());
        let fail = || {
            redirect(
                empty(302),
                &with_query(&format!("{base}/error"), &[("error", "invalid_callback_request")]),
            )
        };
        let mut fields = BTreeMap::new();
        let bytes = match &self.request.body {
            Body::Bytes(bytes) => bytes.as_slice(),
            _ => &[],
        };
        let json = self.request.header("content-type").is_some_and(|kind| kind.contains("json"));
        if json && !bytes.is_empty() {
            let Ok(serde_json::Value::Object(body)) = serde_json::from_slice::<serde_json::Value>(bytes)
            else {
                return fail();
            };
            for (name, value) in body {
                if CALLBACK_FIELDS.contains(&name.as_str()) {
                    match value {
                        serde_json::Value::String(value) => fields.insert(name, value),
                        serde_json::Value::Null => None,
                        _ => return fail(),
                    };
                }
            }
        } else {
            for (name, value) in url::form_urlencoded::parse(bytes) {
                if CALLBACK_FIELDS.contains(&name.as_ref()) {
                    fields.insert(name.into_owned(), value.into_owned());
                }
            }
        }
        let known = provider_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-'));
        let Some(query) = self.callback_params(query).filter(|_| known && !provider_id.is_empty()) else {
            return fail();
        };
        fields.extend(query);
        let mut target = url::form_urlencoded::Serializer::new(String::new());
        for name in CALLBACK_FIELDS {
            if let Some(value) = fields.get(name) {
                target.append_pair(name, value);
            }
        }
        redirect(empty(302), &format!("{base}/callback/{provider_id}?{}", target.finish()))
    }

    pub(in crate::server) async fn oauth_callback(&self, provider_id: &str, query: &str) -> Result<Response> {
        if self.request.method == "POST" {
            return Ok(self.callback_post(provider_id, query));
        }
        let default_error = format!("{}/auth/v1/error", self.router.public_url());
        let fail = |reply: Response, target: &str, code: &str, description: Option<&str>| {
            let mut pairs = vec![("error", code)];
            if let Some(description) = description.filter(|description| !description.is_empty()) {
                pairs.push(("error_description", description));
            }
            redirect(reply, &with_query(target, &pairs))
        };
        let Some(params) = self.callback_params(query) else {
            return Ok(fail(empty(302), &default_error, "invalid_callback_request", None));
        };
        let Some(state) = params.get("state").filter(|state| !state.is_empty()) else {
            return Ok(fail(empty(302), &default_error, "state_not_found", None));
        };
        let identifier = format!("auth-state:{state}");
        let stored = self
            .router
            .collection("verifications")
            .find_one(doc! {"identifier": &identifier})
            .sort(doc! {"createdAt": -1})
            .await
            .map_err(internal)?;
        let Some(stored) = stored else {
            return Ok(fail(empty(302), &default_error, "state_mismatch", None));
        };
        let Some(flow) =
            stored.get_str("value").ok().and_then(|value| serde_json::from_str::<FlowState>(value).ok())
        else {
            return Ok(fail(empty(302), &default_error, "internal_server_error", None));
        };
        let error_url = flow.error_url.clone().unwrap_or(default_error);
        let cookie = self
            .cookie(AuthCookie::State)
            .and_then(|value| verify_session(&self.router.options.secret, &value));
        if flow.oauth_state.as_ref().is_some_and(|stored| stored != state)
            || cookie.as_deref() != Some(state.as_str())
        {
            return Ok(fail(empty(302), &error_url, "state_mismatch", None));
        }
        let mut reply = empty(302);
        self.set_cookie(&mut reply, AuthCookie::State, "", Expiration::MaxAge(0));
        self.router
            .collection("verifications")
            .delete_many(doc! {"identifier": &identifier})
            .await
            .map_err(internal)?;
        #[allow(clippy::cast_precision_loss)]
        let now_ms = self.now.timestamp_millis() as f64;
        if flow.expires_at.as_f64().is_none_or(|expires| expires < now_ms) {
            return Ok(fail(reply, &error_url, "state_mismatch", None));
        }
        if let Some(code) = params.get("error") {
            return Ok(fail(reply, &error_url, code, params.get("error_description").map(String::as_str)));
        }
        let Some(code) = params.get("code").filter(|code| !code.is_empty()) else {
            return Ok(fail(reply, &error_url, "no_code", None));
        };
        let Some(provider) = self.router.oauth.provider(provider_id).await else {
            return Ok(fail(reply, &error_url, "oauth_provider_not_found", None));
        };
        if let (Some(issuer), Some(expected)) = (params.get("iss"), provider.issuer())
            && issuer != expected
        {
            return Ok(fail(reply, &error_url, "issuer_mismatch", None));
        }
        if provider.requires_nonce() && flow.id_token_nonce.is_none() {
            return Ok(fail(reply, &error_url, "nonce_binding_missing", None));
        }
        let now = self.now.timestamp_millis();
        let redirect_uri = format!("{}/auth/v1/callback/{}", self.router.public_url(), provider.id());
        let Some(tokens) =
            provider.exchange(&self.router.oauth, code, &flow.code_verifier, &redirect_uri, now).await
        else {
            return Ok(fail(reply, &error_url, "invalid_code", None));
        };
        let Ok(identity) = provider
            .identity(
                &self.router.oauth,
                &tokens,
                flow.id_token_nonce.as_deref(),
                params.get("user").map(String::as_str),
                false,
                now,
            )
            .await
        else {
            return Ok(fail(reply, &error_url, "unable_to_get_user_info", None));
        };
        if let Some(link) = &flow.link {
            return Ok(match self.link_oauth_account(link, &provider, &identity, &tokens).await? {
                Some(code) => fail(reply, &error_url, code, None),
                None => redirect(reply, &flow.callback_url),
            });
        }
        let Some(email) = identity.email.as_deref().map(str::to_lowercase) else {
            return Ok(fail(reply, &error_url, "email_not_found", None));
        };
        let (user, registered) = match self.oauth_user(&provider, &identity, &tokens, &email, "oauth").await?
        {
            Outcome::SignedIn(user, registered) => (user, registered),
            Outcome::Refused(code) => return Ok(fail(reply, &error_url, code, None)),
        };
        if self.banned(&user) {
            return Ok(fail(reply, &error_url, "BANNED_USER", Some(BANNED_MESSAGE)));
        }
        let session = self.create_session(&user, true, "oauth").await?;
        self.set_session(&mut reply, &session.token, true);
        let target = if registered { flow.new_user_url.as_ref() } else { None }.unwrap_or(&flow.callback_url);
        Ok(redirect(reply, target))
    }

    async fn link_oauth_account(
        &self,
        link: &LinkState,
        provider: &Provider<'_>,
        identity: &Identity,
        tokens: &Tokens,
    ) -> Result<Option<&'static str>> {
        const UNABLE: &str = "unable_to_link_account";
        let user_id = if let Some(encrypted) = &link.encrypted_session_token {
            let Some(token) = secrets::decrypt(&link_session_key(&self.router.options.secret), encrypted)
                .map(Zeroizing::new)
            else {
                return Ok(Some(UNABLE));
            };
            let session = self
                .router
                .collection("sessions")
                .find_one(doc! {"token": token.as_str(), "expiresAt": {"$gt": self.now}})
                .await
                .map_err(internal)?;
            session
                .and_then(|session| session.get("userId").filter(|id| id_text(id) == link.user_id).cloned())
        } else {
            self.user(doc! {"_id": {"$in": matching_ids(&link.user_id)}}).await?.map(|user| user.id)
        };
        let Some(user_id) = user_id else {
            return Ok(Some(UNABLE));
        };
        if !identity.email_verified {
            return Ok(Some(UNABLE));
        }
        if identity.email.as_deref().map(str::to_lowercase) != Some(link.email.to_lowercase()) {
            return Ok(Some("email_does_not_match"));
        }
        let accounts = self.router.collection("accounts");
        let key = doc! {"providerId": provider.id(), "accountId": &identity.account_id};
        let owned = doc! {"providerId": provider.id(), "accountId": &identity.account_id, "userId": &user_id};
        for attempt in 0..2 {
            if let Some(account) = accounts.find_one(key.clone()).await.map_err(internal)? {
                if account.get("userId") != Some(&user_id) {
                    return Ok(Some("account_already_linked_to_different_user"));
                }
                let mut scope = Vec::new();
                for value in account
                    .get_str("scope")
                    .unwrap_or_default()
                    .split(',')
                    .chain(tokens.scopes.as_deref().unwrap_or_default().iter().map(String::as_str))
                {
                    let value = value.trim();
                    if !value.is_empty() && !scope.contains(&value) {
                        scope.push(value);
                    }
                }
                let mut fields = self.token_fields(tokens);
                fields.insert("updatedAt", self.now);
                if !scope.is_empty() {
                    fields.insert("scope", scope.join(","));
                }
                let result =
                    accounts.update_one(owned.clone(), doc! {"$set": fields}).await.map_err(internal)?;
                if result.matched_count != 0 {
                    return Ok(None);
                }
            } else {
                let document = self.account_document(provider.id(), identity, tokens, &user_id);
                match accounts.insert_one(document).await {
                    Ok(_) => return Ok(None),
                    Err(cause) if duplicate_key(&cause) && attempt == 0 => {}
                    Err(cause) if duplicate_key(&cause) => return Ok(Some(UNABLE)),
                    Err(cause) => return Err(internal(cause)),
                }
            }
        }
        Ok(Some(UNABLE))
    }

    pub(in crate::server) async fn unlink_account(&self, body: &Value) -> Result<Response> {
        let Some(account_id) = body.get("accountId").and_then(Value::as_str) else {
            return Ok(validation(body, "accountId"));
        };
        let Some((session, user)) = self.authenticated().await? else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        if !self.fresh(&session) {
            return Ok(error(403, "SESSION_NOT_FRESH", "Session is not fresh"));
        }
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        tx.start_transaction()
            .and_run((self, &user.id, account_id), |tx, (call, user_id, account_id)| {
                Box::pin(async move {
                    let users = call.router.collection("users");
                    let user_filter = doc! {"_id": *user_id};
                    let Some(previous) = users
                        .find_one_and_update(
                            user_filter.clone(),
                            doc! {"$set": {"unlinkAccountLock": bson::oid::ObjectId::new()}},
                        )
                        .projection(doc! {"unlinkAccountLock": 1})
                        .session(&mut *tx)
                        .await?
                    else {
                        return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
                    };
                    let accounts = call.router.collection("accounts");
                    let count = accounts
                        .count_documents(doc! {"userId": *user_id})
                        .limit(2)
                        .session(&mut *tx)
                        .await?;
                    let mut removed = false;
                    if count > 1 {
                        removed = accounts
                            .delete_one(doc! {"_id": {"$in": matching_ids(account_id)}, "userId": *user_id})
                            .session(&mut *tx)
                            .await?
                            .deleted_count
                            == 1;
                    }
                    let unlock = match previous.get("unlinkAccountLock") {
                        Some(value) => doc! {"$set": {"unlinkAccountLock": value}},
                        None => doc! {"$unset": {"unlinkAccountLock": ""}},
                    };
                    users.update_one(user_filter, unlock).session(&mut *tx).await?;
                    Ok(if removed {
                        response(200, object!("status": true))
                    } else if count == 1 {
                        error(400, "FAILED_TO_UNLINK_LAST_ACCOUNT", "You can't unlink your last account")
                    } else {
                        error(400, "ACCOUNT_NOT_FOUND", "Account not found")
                    })
                })
            })
            .await
            .map_err(internal)
    }

    fn account_document(
        &self,
        provider: &str,
        identity: &Identity,
        tokens: &Tokens,
        user_id: &Bson,
    ) -> Document {
        let mut account = doc! {
            "_id": object_id(self.now), "accountId": &identity.account_id, "providerId": provider,
            "userId": user_id.clone(),
        };
        account.extend(self.token_fields(tokens));
        if let Some(scopes) = &tokens.scopes {
            account.insert("scope", scopes.join(","));
        }
        account.insert("createdAt", self.now);
        account.insert("updatedAt", self.now);
        account
    }

    pub(super) fn token_fields(&self, tokens: &Tokens) -> Document {
        #[allow(clippy::cast_possible_truncation)]
        let after = |seconds: f64| self.date_after((seconds * 1000.0).round() as i64);
        let mut fields = doc! {};
        if let Some(access) = &tokens.access_token {
            fields.insert("accessToken", access);
        }
        if let Some(refresh) = &tokens.refresh_token {
            fields.insert("refreshToken", refresh);
        }
        if let Some(id_token) = &tokens.id_token {
            fields.insert("idToken", id_token);
        }
        if let Some(seconds) = tokens.access_expires_in_s {
            fields.insert("accessTokenExpiresAt", after(seconds));
        }
        if let Some(seconds) = tokens.refresh_expires_in_s {
            fields.insert("refreshTokenExpiresAt", after(seconds));
        }
        fields
    }

    async fn oauth_user(
        &self,
        provider: &Provider<'_>,
        identity: &Identity,
        tokens: &Tokens,
        email: &str,
        method: &str,
    ) -> Result<Outcome> {
        let provider_id = provider.id();
        for attempt in 0..2 {
            let accounts = self.router.auth.collection::<Account>("accounts");
            let linked = accounts
                .find_one(doc! {"providerId": provider_id, "accountId": &identity.account_id})
                .await
                .map_err(internal)?;
            if let Some(account) = linked {
                let Some(user) = self.user(doc! {"_id": &account.user_id}).await? else {
                    return Ok(Outcome::Refused("unable_to_link_account"));
                };
                let mut fresh = doc! {"providerId": provider_id};
                fresh.extend(self.token_fields(tokens));
                fresh.insert("updatedAt", self.now);
                let updated = self
                    .router
                    .collection("accounts")
                    .update_one(doc! {"_id": &account.id, "userId": &user.id}, doc! {"$set": fresh})
                    .await
                    .map_err(internal)?;
                if updated.matched_count == 0 {
                    return Ok(Outcome::Refused("unable_to_update_account"));
                }
                return Ok(Outcome::SignedIn(
                    Box::new(self.verify_address(user, identity, email).await?),
                    false,
                ));
            }
            if let Some(user) = self.user(doc! {"email": email}).await? {
                if !identity.email_verified || !user.email_verified {
                    return Ok(Outcome::Refused("account_not_linked"));
                }
                let account = self.account_document(provider_id, identity, tokens, &user.id);
                match self.router.collection("accounts").insert_one(account).await {
                    Ok(_) => return Ok(Outcome::SignedIn(Box::new(user), false)),
                    Err(cause) if duplicate_key(&cause) && attempt == 0 => continue,
                    Err(_) => return Ok(Outcome::Refused("unable_to_link_account")),
                }
            }
            let user_id = Bson::ObjectId(object_id(self.now));
            let mut user = doc! {"_id": &user_id, "name": &identity.name, "email": email,
            "emailVerified": identity.email_verified};
            if let Some(image) = &identity.image {
                user.insert("image", image);
            }
            user.extend(doc! {
                "createdAt": self.now, "updatedAt": self.now, "isAnonymous": false, "role": "user",
                "banned": false, "twoFactorEnabled": false, "roles": [],
            });
            let account = self.account_document(provider_id, identity, tokens, &user_id);
            let mut session = self.router.auth.client().start_session().await.map_err(internal)?;
            let created = session
                .start_transaction()
                .and_run((self, &user, &account), |session, (call, user, account)| {
                    Box::pin(async move {
                        call.router.collection("users").insert_one(*user).session(&mut *session).await?;
                        call.router
                            .collection("accounts")
                            .insert_one(*account)
                            .session(&mut *session)
                            .await?;
                        Ok(())
                    })
                })
                .await;
            match created {
                Ok(()) => {}
                Err(cause) if duplicate_key(&cause) && attempt == 0 => continue,
                Err(cause) => return Err(internal(cause)),
            }
            let uid = id_text(&user_id);
            self.audit(
                "auth.sign_up",
                doc! {"type": "user", "id": &uid},
                Some(doc! {"type": "user", "id": uid}),
                Some(doc! {"method": method}),
                false,
            )
            .await?;
            let user: User = bson::deserialize_from_document(user).map_err(internal)?;
            return Ok(Outcome::SignedIn(Box::new(user), true));
        }
        Ok(Outcome::Refused("unable_to_create_user"))
    }

    async fn verify_address(&self, user: User, identity: &Identity, email: &str) -> Result<User> {
        if !identity.email_verified || user.email_verified || user.email != email {
            return Ok(user);
        }
        Ok(self
            .router
            .auth
            .collection::<User>("users")
            .find_one_and_update(
                doc! {"_id": &user.id},
                doc! {"$set": {"emailVerified": true, "updatedAt": self.now}},
            )
            .return_document(canopy_mongo::mongodb::options::ReturnDocument::After)
            .await
            .map_err(internal)?
            .unwrap_or(user))
    }

    pub(in crate::server) async fn list_accounts(&self) -> Result<Response> {
        let Some((_, user)) = self.authenticated().await? else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        let accounts: Vec<Account> = self
            .router
            .auth
            .collection("accounts")
            .find(doc! {"userId": &user.id})
            .sort(doc! {"_id": 1})
            .await
            .map_err(internal)?
            .try_collect()
            .await
            .map_err(internal)?;
        Ok(response(200, accounts.iter().map(Account::public).collect::<Vec<_>>()))
    }
}

#[cfg(test)]
mod tests {
    use super::link_session_key;

    #[test]
    fn link_session_key_matches_better_auth() {
        assert_eq!(
            link_session_key("a secret of more than thirty two bytes").as_str(),
            "0f8ce9f1027bc6695528f8c8eeaf8dcabee4cc236c8caca77242eb29a253a742"
        );
    }
}
