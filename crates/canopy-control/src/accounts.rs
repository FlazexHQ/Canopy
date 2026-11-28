//! Admin accounts in `admin_users` and their sessions in `admin_sessions`: the first run claim, password and
//! TOTP login with rate limits and lockout, sessions with an absolute and an idle lifetime, and account
//! management with the rules that keep at least one owner and stop anyone from changing their own role.

use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, doc};
use canopy_mongo::mongodb::options::ReturnDocument;
use canopy_mongo::mongodb::{Client, Collection, Database};
use canopy_protocol::{CanopyError, ErrorCode};

use crate::core::{
    Abort, Actor, AuditLog, Clock, RequestOrigin, collect, details, err, is_duplicate, js_bson, millis,
    mongo, random_url, text, transaction,
};
use crate::http::sha256_hex;
use crate::passwords::{
    DUMMY_PASSWORD_HASH, blocking, check_strength, hash_password, needs_rehash, verify_login_password,
    verify_password,
};
use crate::rate_limit::{RateLimiter, lockout_ms};
use crate::rbac::AdminRole;
use crate::secrets::SecretBox;
use crate::totp::{TotpOptions, base32_decode, generate_secret, totp_uri, verify_totp};

const SESSION_PREFIX: &str = "canopy_admin_";
const SETUP_PREFIX: &str = "canopy_setup_";
const TOUCH_INTERVAL_MS: i64 = 60_000;
const INVALID_LOGIN: &str = "Invalid email or password";

/// An admin account as the admin API shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminUser {
    /// The admin id.
    pub id: String,
    /// The normalized email address.
    pub email: String,
    pub(crate) name: Option<String>,
    /// The assigned admin role.
    pub role: AdminRole,
    pub(crate) must_change_password: bool,
    /// Whether the admin has confirmed their authenticator.
    pub totp_enabled: bool,
    /// Whether sign in is disabled.
    pub disabled: bool,
    pub(crate) created_at: i64,
    /// The last login, in Unix milliseconds.
    pub last_login_at: Option<i64>,
}

impl AdminUser {
    pub(crate) fn from_document(document: &Document) -> Option<AdminUser> {
        let totp_enabled = matches!(document.get("totp"), Some(Bson::Document(totp)) if totp.get_bool("confirmed").is_ok_and(|flag| flag));
        Some(AdminUser {
            id: text(document, "_id")?.to_owned(),
            email: text(document, "email")?.to_owned(),
            name: text(document, "name").map(str::to_owned),
            role: AdminRole::parse(text(document, "role")?)?,
            must_change_password: document.get_bool("mustChangePassword").unwrap_or(false),
            totp_enabled,
            disabled: document.get_bool("disabled").unwrap_or(false),
            created_at: millis(document, "createdAt")?,
            last_login_at: millis(document, "lastLoginAt"),
        })
    }

    pub(crate) fn to_document(&self) -> Document {
        let mut out = doc! { "id": &self.id, "email": &self.email };
        if let Some(name) = &self.name {
            out.insert("name", name);
        }
        out.insert("role", self.role.as_str());
        out.insert("mustChangePassword", self.must_change_password);
        out.insert("totpEnabled", self.totp_enabled);
        out.insert("disabled", self.disabled);
        out.insert("createdAt", DateTime::from_millis(self.created_at));
        if let Some(at) = self.last_login_at {
            out.insert("lastLoginAt", DateTime::from_millis(at));
        }
        out
    }

    /// The audit actor of this account, and of the admin API token it acts through when there is one.
    pub(crate) fn actor(&self, token_id: Option<&str>) -> Actor {
        Actor {
            kind: "admin",
            id: self.id.clone(),
            email: Some(self.email.clone()),
            role: Some(self.role.as_str().to_owned()),
            token_id: token_id.map(str::to_owned),
        }
    }
}

/// How a session is carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transport {
    /// The session cookie, which needs the CSRF token and an allowed `Origin` on every change.
    Cookie,
    /// `Authorization: Bearer` with a session token.
    Bearer,
    /// `Authorization: Bearer` with an admin API token.
    Token,
}

impl Transport {
    fn as_str(self) -> &'static str {
        match self {
            Transport::Cookie => "cookie",
            Transport::Bearer => "bearer",
            Transport::Token => "token",
        }
    }
}

/// The admin API token behind a token session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TokenRef {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) prefix: String,
    pub(crate) role: AdminRole,
}

/// A valid session with its account; for a token its role is the lower of the token's and the account's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdminSession {
    pub(crate) id: String,
    pub(crate) user: AdminUser,
    pub(crate) transport: Transport,
    pub(crate) csrf_hash: String,
    pub(crate) expires_at: Option<i64>,
    pub(crate) token: Option<TokenRef>,
}

/// A new session: its tokens are only ever returned here.
pub(crate) struct LoginResult {
    pub(crate) user: AdminUser,
    pub(crate) token: String,
    pub(crate) csrf_token: String,
    pub(crate) expires_at: i64,
}

/// The secret an authenticator app needs, shown once at enrollment.
pub(crate) fn enrollment(secret: &str, email: &str) -> Document {
    doc! { "secret": secret, "uri": totp_uri(secret, email, "Canopy") }
}

/// Hashes a CSRF token the way sessions store it.
pub(crate) fn csrf_hash(value: &str) -> String {
    sha256_hex(&format!("csrf:{value}"))
}

fn normalize_email(email: &str) -> Result<String, CanopyError> {
    let value = email.trim().to_lowercase();
    let valid = value.encode_utf16().count() <= 320
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.is_empty()
                && !value.chars().any(|c| c.is_whitespace())
                && !domain.contains('@')
        });
    if valid { Ok(value) } else { Err(err(ErrorCode::ValidationFailed, "The email is not valid")) }
}

fn not_found() -> CanopyError {
    err(ErrorCode::NotFound, "No such admin")
}

/// Changes an admin's role, name or disabled flag.
#[derive(Debug, Clone, Default)]
pub(crate) struct AdminChanges {
    pub(crate) role: Option<AdminRole>,
    pub(crate) disabled: Option<bool>,
    pub(crate) name: Option<String>,
}

/// Admin accounts and sessions.
pub struct AdminAccounts {
    pub(crate) users: Collection<Document>,
    pub(crate) sessions: Collection<Document>,
    settings: Collection<Document>,
    client: Client,
    audit: AuditLog,
    secrets: SecretBox,
    lifetime_ms: i64,
    idle_ms: i64,
    setup_ttl_ms: i64,
    now: Clock,
    by_ip: RateLimiter,
    by_email: RateLimiter,
    setup_attempts: RateLimiter,
}

impl AdminAccounts {
    /// Opens the admin store for local bootstrap and recovery tools.
    pub fn for_cli(meta: &Database) -> Self {
        let now = crate::system_clock();
        Self::new(meta.client(), meta, AuditLog::new(meta, now.clone()), SecretBox::new(None, &[]), now)
    }

    /// Clears an admin's TOTP secret and sessions for a local recovery tool.
    pub async fn reset_totp_for_cli(&self, id: &str, actor: &Actor) -> Result<AdminUser, CanopyError> {
        self.reset_totp(id, actor, None, &RequestOrigin::default()).await
    }

    pub(crate) fn new(
        client: &Client,
        meta: &Database,
        audit: AuditLog,
        secrets: SecretBox,
        now: Clock,
    ) -> AdminAccounts {
        AdminAccounts {
            users: meta.collection("admin_users"),
            sessions: meta.collection("admin_sessions"),
            settings: meta.collection("settings"),
            client: client.clone(),
            audit,
            secrets,
            lifetime_ms: 12 * 3_600_000,
            idle_ms: 3_600_000,
            setup_ttl_ms: 24 * 3_600_000,
            now,
            by_ip: RateLimiter::new(30, 5 * 60_000),
            by_email: RateLimiter::new(10, 5 * 60_000),
            setup_attempts: RateLimiter::new(10, 5 * 60_000),
        }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    pub(crate) fn secrets(&self) -> &SecretBox {
        &self.secrets
    }

    /// Whether an enabled owner exists.
    pub(crate) async fn has_owner(&self) -> Result<bool, CanopyError> {
        let count = self
            .users
            .count_documents(doc! { "role": "owner", "disabled": false })
            .limit(1)
            .await
            .map_err(mongo)?;
        Ok(count > 0)
    }

    /// On a server that was never claimed, makes a one time setup token and stores its hash. Every node and
    /// every restart adds its own token; any of them works until one is used.
    pub(crate) async fn create_setup_token(&self) -> Result<Option<String>, CanopyError> {
        if self.has_owner().await?
            || self.settings.count_documents(doc! { "_id": "claimed" }).await.map_err(mongo)? > 0
        {
            return Ok(None);
        }
        let value = format!("{SETUP_PREFIX}{}", random_url(32)?);
        let entry = doc! { "hash": sha256_hex(&value), "expiresAt": DateTime::from_millis(self.now() + self.setup_ttl_ms) };
        self.settings
            .update_one(
                doc! { "_id": "setup" },
                doc! { "$push": { "tokens": { "$each": [entry], "$slice": -20 } } },
            )
            .upsert(true)
            .await
            .map_err(mongo)?;
        Ok(Some(value))
    }

    /// Creates the first owner with a setup token. The owner's TOTP secret is returned for enrollment and
    /// confirmed by the first login.
    pub(crate) async fn claim(
        &self,
        token: &str,
        email: &str,
        password: &str,
        name: Option<&str>,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        let system = Actor::system("setup").to_document();
        let retry = self.setup_attempts.hit(origin.ip.as_deref().unwrap_or("unknown"), self.now());
        if retry > 0 {
            self.audit
                .record(doc! {
                    "action": "setup.claim", "actor": system, "outcome": "failed",
                    "origin": origin.to_document(), "details": { "reason": "rate limited" },
                })
                .await?;
            return Err(err(ErrorCode::RateLimited, "Too many setup attempts")
                .with_details(format!("{{\"retryAfterSeconds\":{}}}", (retry + 999) / 1000)));
        }
        let setup = self.settings.find_one(doc! { "_id": "setup" }).await.map_err(mongo)?;
        let hash = sha256_hex(token);
        let now = self.now();
        let valid = token.starts_with(SETUP_PREFIX)
            && setup.as_ref().and_then(|setup| setup.get_array("tokens").ok()).is_some_and(|tokens| {
                tokens.iter().any(|entry| match entry {
                    Bson::Document(entry) => {
                        text(entry, "hash") == Some(&hash)
                            && millis(entry, "expiresAt").is_some_and(|at| at > now)
                    }
                    _ => false,
                })
            });
        if !valid || self.has_owner().await? {
            self.audit
                .record(doc! { "action": "setup.claim", "actor": system, "outcome": "failed", "origin": origin.to_document() })
                .await?;
            return Err(if valid {
                err(ErrorCode::Conflict, "This server already has an owner")
            } else {
                err(
                    ErrorCode::Unauthorized,
                    "The setup token is not valid; use the one printed in the server logs",
                )
            });
        }
        check_strength(password)?;
        let email = normalize_email(email)?;
        let secret = generate_secret().ok_or_else(|| err(ErrorCode::Internal, "No randomness"))?;
        let at = DateTime::from_millis(now);
        let id = format!("adm_{}", random_url(12)?);
        let password = password.to_owned();
        let password_hash = blocking(move || hash_password(&password)).await??;
        let mut user = doc! { "_id": &id, "email": &email };
        if let Some(name) = name {
            user.insert("name", name);
        }
        user.extend(doc! {
            "role": "owner",
            "passwordHash": password_hash,
            "mustChangePassword": false,
            "totp": { "secret": self.secrets.seal(&secret, &format!("totp:{email}"))?, "confirmed": false },
            "disabled": false,
            "failedLogins": 0,
            "createdAt": at,
            "createdBy": "setup",
            "updatedAt": at,
            "passwordChangedAt": at,
        });
        let view =
            AdminUser::from_document(&user).ok_or_else(|| err(ErrorCode::Internal, "Invalid admin"))?;
        let audit = self.audit.clone();
        let entry = doc! {
            "action": "setup.claim", "actor": view.actor(None).to_document(),
            "target": { "adminId": &id }, "origin": origin.to_document(),
        };
        let (settings, users) = (self.settings.clone(), self.users.clone());
        transaction(&self.client, |session| {
            let (settings, users, audit, user, entry) =
                (settings.clone(), users.clone(), audit.clone(), user.clone(), entry.clone());
            let id = id.clone();
            Box::pin(async move {
                if let Err(error) = settings
                    .insert_one(doc! { "_id": "claimed", "at": at, "by": &id })
                    .session(&mut *session)
                    .await
                {
                    return Err(if is_duplicate(&error) {
                        Abort::Refused(err(ErrorCode::Conflict, "This server already has an owner"))
                    } else {
                        Abort::Mongo(error)
                    });
                }
                users.insert_one(user).session(&mut *session).await?;
                settings.delete_one(doc! { "_id": "setup" }).session(&mut *session).await?;
                audit.record_in(entry, session).await?;
                Ok(())
            })
        })
        .await?;
        Ok(doc! { "user": view.to_document(), "totp": enrollment(&secret, &email) })
    }

    async fn fail_login(
        &self,
        user: Option<&Document>,
        email: &str,
        origin: &RequestOrigin,
        reason: &str,
    ) -> CanopyError {
        if let Some(id) = user.and_then(|user| text(user, "_id")) {
            let updated = match self
                .users
                .find_one_and_update(doc! { "_id": id }, doc! { "$inc": { "failedLogins": 1 } })
                .return_document(ReturnDocument::After)
                .await
            {
                Ok(updated) => updated,
                Err(error) => return mongo(error),
            };
            #[allow(clippy::cast_possible_truncation)]
            let failures =
                updated.and_then(|doc| crate::core::number(&doc, "failedLogins")).unwrap_or(0.0) as i64;
            let wait = lockout_ms(failures);
            if wait > 0 {
                let until = DateTime::from_millis(self.now() + wait);
                if let Err(error) =
                    self.users.update_one(doc! { "_id": id }, doc! { "$set": { "lockedUntil": until } }).await
                {
                    return mongo(error);
                }
            }
        }
        let id = user.and_then(|user| text(user, "_id")).unwrap_or("unknown");
        let recorded = self
            .audit
            .record(doc! {
                "action": "session.login", "actor": { "type": "admin", "id": id, "email": email },
                "outcome": "failed", "origin": origin.to_document(), "details": { "reason": reason },
            })
            .await;
        match recorded {
            Ok(()) => err(ErrorCode::Unauthorized, INVALID_LOGIN),
            Err(error) => error,
        }
    }

    /// Logs in with email, password and, for owners and accounts with TOTP, a current code. Refuses with one
    /// generic message whether the account is unknown, disabled or the password is wrong, and spends the same
    /// hashing time on each. Attempts are limited per address and per account, and repeated failures lock the
    /// account for a doubling delay.
    pub(crate) async fn login(
        &self,
        email: &str,
        password: &str,
        code: Option<&str>,
        origin: &RequestOrigin,
        transport: Transport,
    ) -> Result<LoginResult, CanopyError> {
        let email: String = email.trim().to_lowercase().chars().take(320).collect();
        let address = format!("ip:{}", origin.ip.as_deref().unwrap_or("unknown"));
        let account = format!("email:{email}");
        for (limiter, key) in [(&self.by_ip, &address), (&self.by_email, &account)] {
            let retry = limiter.hit(key, self.now());
            if retry > 0 {
                self.audit
                    .record(doc! {
                        "action": "session.login", "actor": { "type": "admin", "id": "unknown", "email": &email },
                        "outcome": "failed", "origin": origin.to_document(), "details": { "reason": "rate limited" },
                    })
                    .await?;
                return Err(err(ErrorCode::RateLimited, "Too many login attempts")
                    .with_details(format!("{{\"retryAfterSeconds\":{}}}", (retry + 999) / 1000)));
            }
        }
        let user = self.users.find_one(doc! { "email": &email }).await.map_err(mongo)?;
        if let Some(user) = &user
            && let Some(locked) = millis(user, "lockedUntil")
            && locked > self.now()
        {
            let id = text(user, "_id").unwrap_or("unknown");
            self.audit
                .record(doc! {
                    "action": "session.login", "actor": { "type": "admin", "id": id, "email": &email },
                    "outcome": "failed", "origin": origin.to_document(), "details": { "reason": "locked" },
                })
                .await?;
            return Err(err(ErrorCode::RateLimited, "Too many failed logins; try again later")
                .with_details(format!("{{\"retryAfterSeconds\":{}}}", (locked - self.now() + 999) / 1000)));
        }
        let stored = user
            .as_ref()
            .and_then(|user| text(user, "passwordHash"))
            .unwrap_or(DUMMY_PASSWORD_HASH)
            .to_owned();
        let attempt = password.to_owned();
        let matches = blocking(move || verify_login_password(&attempt, &stored)).await?;
        let refused = match &user {
            None => Some("unknown account"),
            Some(_) if !matches => Some("password"),
            Some(user) if user.get_bool("disabled").is_ok_and(|flag| flag) => Some("disabled"),
            Some(_) => None,
        };
        if let Some(reason) = refused {
            return Err(self.fail_login(user.as_ref(), &email, origin, reason).await);
        }
        let Some(user) = user else { return Err(not_found()) };
        let id = text(&user, "_id").ok_or_else(not_found)?.to_owned();
        let view = AdminUser::from_document(&user).ok_or_else(not_found)?;
        let totp = match user.get("totp") {
            Some(Bson::Document(totp)) => Some(totp.clone()),
            _ => None,
        };
        let confirmed = totp.as_ref().is_some_and(|totp| totp.get_bool("confirmed").is_ok_and(|flag| flag));
        if view.role == AdminRole::Owner || confirmed {
            let pending = totp.is_some() && !confirmed;
            if totp.is_none() || (pending && code.is_none()) {
                let enrollment = self.begin_totp(&user).await?;
                return Err(err(
                    ErrorCode::Unauthorized,
                    "Set up an authenticator app, then log in with its code",
                )
                .with_details(details(&doc! { "totpRequired": true, "totpEnrollment": enrollment })));
            }
            let (Some(code), Some(totp)) = (code, totp) else {
                return Err(err(ErrorCode::Unauthorized, "Enter the code of your authenticator app")
                    .with_details("{\"totpRequired\":true}"));
            };
            let sealed = text(&totp, "secret").unwrap_or_default();
            let secret = base32_decode(&self.secrets.open(sealed, &format!("totp:{}", view.email))?)
                .unwrap_or_default();
            #[allow(clippy::cast_possible_truncation)]
            let last = crate::core::number(&totp, "lastStep").map(|step| step as i64);
            let Some(step) = verify_totp(&secret, code, self.now(), TotpOptions::default(), 1, last) else {
                return Err(self.fail_login(Some(&user), &email, origin, "totp").await);
            };
            #[allow(clippy::cast_precision_loss)]
            let stored_step = js_bson(step as f64);
            let claimed = self
                .users
                .update_one(
                    doc! { "_id": &id, "$or": [{ "totp.lastStep": { "$lt": stored_step.clone() } }, { "totp.lastStep": { "$exists": false } }] },
                    doc! { "$set": { "totp.lastStep": stored_step, "totp.confirmed": true } },
                )
                .await
                .map_err(mongo)?;
            if claimed.modified_count == 0 {
                return Err(self.fail_login(Some(&user), &email, origin, "totp reused").await);
            }
        }
        let current_hash = text(&user, "passwordHash").unwrap_or_default().to_owned();
        if needs_rehash(&current_hash) {
            let attempt = password.to_owned();
            let rehashed = blocking(move || hash_password(&attempt)).await??;
            self.users
                .update_one(
                    doc! { "_id": &id, "passwordHash": &current_hash },
                    doc! { "$set": { "passwordHash": rehashed } },
                )
                .await
                .map_err(mongo)?;
        }
        let now = self.now();
        let session_token = format!("{SESSION_PREFIX}{}", random_url(32)?);
        let csrf = random_url(32)?;
        let expires_at = now + self.lifetime_ms;
        let mut session = doc! {
            "_id": sha256_hex(&session_token),
            "userId": &id,
            "csrfHash": csrf_hash(&csrf),
            "transport": transport.as_str(),
            "createdAt": DateTime::from_millis(now),
            "lastSeenAt": DateTime::from_millis(now),
            "expiresAt": DateTime::from_millis(expires_at),
        };
        if let Some(ip) = &origin.ip {
            session.insert("ip", ip);
        }
        if let Some(agent) = &origin.user_agent {
            session.insert("userAgent", agent.chars().take(512).collect::<String>());
        }
        self.sessions.insert_one(session).await.map_err(mongo)?;
        let updated = self
            .users
            .find_one_and_update(
                doc! { "_id": &id },
                doc! { "$set": { "failedLogins": 0, "lastLoginAt": DateTime::from_millis(now) }, "$unset": { "lockedUntil": "" } },
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(mongo)?;
        self.by_email.reset(&account);
        let account = updated.as_ref().and_then(AdminUser::from_document).unwrap_or(view);
        self.audit
            .record(doc! {
                "action": "session.login", "actor": account.actor(None).to_document(),
                "origin": origin.to_document(), "details": { "transport": transport.as_str() },
            })
            .await?;
        Ok(LoginResult { user: account, token: session_token, csrf_token: csrf, expires_at })
    }

    async fn begin_totp(&self, user: &Document) -> Result<Document, CanopyError> {
        let email = text(user, "email").unwrap_or_default();
        let context = format!("totp:{email}");
        if let Some(Bson::Document(totp)) = user.get("totp")
            && !totp.get_bool("confirmed").is_ok_and(|flag| flag)
        {
            let secret = self.secrets.open(text(totp, "secret").unwrap_or_default(), &context)?;
            return Ok(enrollment(&secret, email));
        }
        let secret = generate_secret().ok_or_else(|| err(ErrorCode::Internal, "No randomness"))?;
        self.users
            .update_one(
                doc! { "_id": text(user, "_id").unwrap_or_default(), "totp.confirmed": { "$ne": true } },
                doc! { "$set": { "totp": { "secret": self.secrets.seal(&secret, &context)?, "confirmed": false } } },
            )
            .await
            .map_err(mongo)?;
        Ok(enrollment(&secret, email))
    }

    /// Starts TOTP enrollment for the signed in account. A confirmed secret cannot be replaced here.
    pub(crate) async fn enroll_totp(
        &self,
        session: &AdminSession,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        let user = self
            .users
            .find_one(doc! { "_id": &session.user.id })
            .await
            .map_err(mongo)?
            .ok_or_else(not_found)?;
        if matches!(user.get("totp"), Some(Bson::Document(totp)) if totp.get_bool("confirmed").is_ok_and(|flag| flag))
        {
            return Err(err(ErrorCode::Conflict, "TOTP is already set up for this account"));
        }
        let enrolled = self.begin_totp(&user).await?;
        self.audit
            .record(doc! { "action": "admin.totp.enroll", "actor": session.user.actor(None).to_document(), "origin": origin.to_document() })
            .await?;
        Ok(enrolled)
    }

    /// Confirms a pending TOTP secret with a current code.
    pub(crate) async fn confirm_totp(
        &self,
        session: &AdminSession,
        code: &str,
        origin: &RequestOrigin,
    ) -> Result<(), CanopyError> {
        let user = self.users.find_one(doc! { "_id": &session.user.id }).await.map_err(mongo)?;
        let Some(totp) = user.as_ref().and_then(|user| match user.get("totp") {
            Some(Bson::Document(totp)) if !totp.get_bool("confirmed").is_ok_and(|flag| flag) => {
                Some(totp.clone())
            }
            _ => None,
        }) else {
            return Err(err(ErrorCode::Conflict, "There is no pending TOTP enrollment"));
        };
        let email = user.as_ref().and_then(|user| text(user, "email")).unwrap_or_default();
        let secret = base32_decode(
            &self.secrets.open(text(&totp, "secret").unwrap_or_default(), &format!("totp:{email}"))?,
        )
        .unwrap_or_default();
        let actor = session.user.actor(None).to_document();
        let Some(step) = verify_totp(&secret, code, self.now(), TotpOptions::default(), 1, None) else {
            self.audit
                .record(doc! { "action": "admin.totp.confirm", "actor": actor, "outcome": "failed", "origin": origin.to_document() })
                .await?;
            return Err(err(ErrorCode::ValidationFailed, "The code is not valid"));
        };
        #[allow(clippy::cast_precision_loss)]
        let step = js_bson(step as f64);
        self.users
            .update_one(
                doc! { "_id": &session.user.id },
                doc! { "$set": { "totp.confirmed": true, "totp.lastStep": step, "updatedAt": DateTime::from_millis(self.now()) } },
            )
            .await
            .map_err(mongo)?;
        self.audit
            .record(doc! { "action": "admin.totp.confirm", "actor": actor, "origin": origin.to_document() })
            .await
    }

    /// Resolves a session token. Unknown, expired or idle sessions and those of disabled or removed accounts
    /// are refused. The role is read from the account every time, so role changes apply at once.
    pub(crate) async fn session(&self, token: &str) -> Result<Option<AdminSession>, CanopyError> {
        if !token.starts_with(SESSION_PREFIX) || token.encode_utf16().count() > 200 {
            return Ok(None);
        }
        let id = sha256_hex(token);
        let Some(stored) = self.sessions.find_one(doc! { "_id": &id }).await.map_err(mongo)? else {
            return Ok(None);
        };
        let now = self.now();
        let expires = millis(&stored, "expiresAt").unwrap_or(0);
        let seen = millis(&stored, "lastSeenAt").unwrap_or(0);
        if expires <= now || seen + self.idle_ms <= now {
            self.sessions.delete_one(doc! { "_id": &id }).await.map_err(mongo)?;
            return Ok(None);
        }
        let user = self
            .users
            .find_one(doc! { "_id": text(&stored, "userId").unwrap_or_default() })
            .await
            .map_err(mongo)?;
        let Some(user) = user.as_ref().and_then(AdminUser::from_document).filter(|user| !user.disabled)
        else {
            self.sessions.delete_one(doc! { "_id": &id }).await.map_err(mongo)?;
            return Ok(None);
        };
        if now - seen >= TOUCH_INTERVAL_MS {
            self.sessions
                .update_one(
                    doc! { "_id": &id },
                    doc! { "$set": { "lastSeenAt": DateTime::from_millis(now) } },
                )
                .await
                .map_err(mongo)?;
        }
        let transport =
            if text(&stored, "transport") == Some("cookie") { Transport::Cookie } else { Transport::Bearer };
        Ok(Some(AdminSession {
            id,
            user,
            transport,
            csrf_hash: text(&stored, "csrfHash").unwrap_or_default().to_owned(),
            expires_at: Some(expires),
            token: None,
        }))
    }

    pub(crate) async fn logout(
        &self,
        session: &AdminSession,
        origin: &RequestOrigin,
    ) -> Result<(), CanopyError> {
        self.sessions.delete_one(doc! { "_id": &session.id }).await.map_err(mongo)?;
        self.audit
            .record(doc! { "action": "session.logout", "actor": session.user.actor(None).to_document(), "origin": origin.to_document() })
            .await
    }

    /// Changes the signed in account's password and ends its other sessions.
    pub(crate) async fn change_password(
        &self,
        session: &AdminSession,
        current: &str,
        next: &str,
        origin: &RequestOrigin,
    ) -> Result<(), CanopyError> {
        let user = self.users.find_one(doc! { "_id": &session.user.id }).await.map_err(mongo)?;
        let stored = user.as_ref().and_then(|user| text(user, "passwordHash")).map(str::to_owned);
        let attempt = current.to_owned();
        let matches = match stored {
            Some(stored) => blocking(move || verify_password(&attempt, &stored)).await?,
            None => false,
        };
        let actor = session.user.actor(None).to_document();
        if !matches {
            self.audit
                .record(doc! { "action": "admin.password.change", "actor": actor, "outcome": "failed", "origin": origin.to_document() })
                .await?;
            return Err(err(ErrorCode::Forbidden, "The current password is not correct"));
        }
        check_strength(next)?;
        if current == next {
            return Err(err(ErrorCode::ValidationFailed, "Choose a different password"));
        }
        let now = DateTime::from_millis(self.now());
        let next = next.to_owned();
        let hash = blocking(move || hash_password(&next)).await??;
        self.users
            .update_one(
                doc! { "_id": &session.user.id },
                doc! { "$set": { "passwordHash": hash, "mustChangePassword": false, "passwordChangedAt": now, "updatedAt": now } },
            )
            .await
            .map_err(mongo)?;
        self.sessions
            .delete_many(doc! { "userId": &session.user.id, "_id": { "$ne": &session.id } })
            .await
            .map_err(mongo)?;
        self.audit
            .record(
                doc! { "action": "admin.password.change", "actor": actor, "origin": origin.to_document() },
            )
            .await
    }

    /// Lists admin accounts in creation order.
    pub async fn list(&self) -> Result<Vec<AdminUser>, CanopyError> {
        let found =
            collect(self.users.find(Document::new()).sort(doc! { "createdAt": 1 }).await.map_err(mongo)?)
                .await?;
        Ok(found.iter().filter_map(AdminUser::from_document).collect())
    }

    fn guard(
        actor: &AdminSession,
        target: Option<AdminRole>,
        next: Option<AdminRole>,
    ) -> Result<(), CanopyError> {
        let touches_owner = target == Some(AdminRole::Owner) || next == Some(AdminRole::Owner);
        if touches_owner && actor.user.role != AdminRole::Owner {
            return Err(err(ErrorCode::Forbidden, "Only owners may manage owners"));
        }
        Ok(())
    }

    /// Creates an admin with a generated password, returned once; it must be changed at first login.
    pub(crate) async fn create(
        &self,
        actor: &AdminSession,
        email: &str,
        role: AdminRole,
        name: Option<&str>,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        Self::guard(actor, None, Some(role))?;
        self.insert_admin(email, role, name, &actor.user.actor(None), origin).await
    }

    /// Creates an admin without a session, for bootstrap tools that reach the meta database directly. Creating
    /// an owner also claims the server, so setup tokens stop working.
    pub async fn create_bootstrap(
        &self,
        email: &str,
        role: AdminRole,
        name: Option<&str>,
        actor: &Actor,
    ) -> Result<Document, CanopyError> {
        let created = self.insert_admin(email, role, name, actor, &RequestOrigin::default()).await?;
        if role == AdminRole::Owner {
            let id = created
                .get_document("user")
                .ok()
                .and_then(|user| text(user, "id"))
                .unwrap_or_default()
                .to_owned();
            let claimed = doc! { "_id": "claimed", "at": DateTime::from_millis(self.now()), "by": id };
            if let Err(error) = self.settings.insert_one(claimed).await
                && !is_duplicate(&error)
            {
                return Err(mongo(error));
            }
            self.settings.delete_one(doc! { "_id": "setup" }).await.map_err(mongo)?;
        }
        Ok(created)
    }

    async fn insert_admin(
        &self,
        email: &str,
        role: AdminRole,
        name: Option<&str>,
        actor: &Actor,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        let email = normalize_email(email)?;
        let password = random_url(18)?;
        let now = DateTime::from_millis(self.now());
        let id = format!("adm_{}", random_url(12)?);
        let generated = password.clone();
        let hash = blocking(move || hash_password(&generated)).await??;
        let mut user = doc! { "_id": &id, "email": &email };
        if let Some(name) = name {
            user.insert("name", name);
        }
        user.extend(doc! {
            "role": role.as_str(),
            "passwordHash": hash,
            "mustChangePassword": true,
            "disabled": false,
            "failedLogins": 0,
            "createdAt": now,
            "createdBy": &actor.id,
            "updatedAt": now,
            "passwordChangedAt": now,
        });
        if let Err(error) = self.users.insert_one(&user).await {
            return Err(if is_duplicate(&error) {
                err(ErrorCode::Conflict, "An admin with this email already exists")
            } else {
                mongo(error)
            });
        }
        self.audit
            .record(doc! {
                "action": "admin.create", "actor": actor.to_document(),
                "target": { "adminId": &id, "email": &email, "role": role.as_str() }, "origin": origin.to_document(),
            })
            .await?;
        let view = AdminUser::from_document(&user).ok_or_else(not_found)?;
        Ok(doc! { "user": view.to_document(), "password": password })
    }

    /// Finds an admin by id or email.
    pub async fn find(&self, id_or_email: &str) -> Result<Option<AdminUser>, CanopyError> {
        let filter = if id_or_email.contains('@') {
            doc! { "email": id_or_email.trim().to_lowercase() }
        } else {
            doc! { "_id": id_or_email }
        };
        Ok(self.users.find_one(filter).await.map_err(mongo)?.as_ref().and_then(AdminUser::from_document))
    }

    /// Ends every admin session, the caller's included. Admin API tokens are not sessions and stay.
    pub(crate) async fn end_all_sessions(&self) -> Result<u64, CanopyError> {
        Ok(self.sessions.delete_many(Document::new()).await.map_err(mongo)?.deleted_count)
    }

    /// Seals every stored TOTP secret again with the current master key. Returns how many changed.
    pub(crate) async fn reseal_secrets(&self) -> Result<u64, CanopyError> {
        let users =
            collect(self.users.find(doc! { "totp": { "$exists": true } }).await.map_err(mongo)?).await?;
        let mut changed = 0;
        for user in users {
            let Some(Bson::Document(totp)) = user.get("totp") else { continue };
            let Some(sealed) = text(totp, "secret") else { continue };
            let context = format!("totp:{}", text(&user, "email").unwrap_or_default());
            if self.secrets.is_current(sealed, &context)? {
                continue;
            }
            let resealed = self.secrets.seal(&self.secrets.open(sealed, &context)?, &context)?;
            let result = self
                .users
                .update_one(
                    doc! { "_id": text(&user, "_id").unwrap_or_default(), "totp.secret": sealed },
                    doc! { "$set": { "totp.secret": resealed } },
                )
                .await
                .map_err(mongo)?;
            changed += result.modified_count;
        }
        Ok(changed)
    }

    /// Clears an admin's TOTP secret and ends their sessions, for a lost authenticator.
    pub(crate) async fn reset_totp(
        &self,
        id: &str,
        actor: &Actor,
        session: Option<&AdminSession>,
        origin: &RequestOrigin,
    ) -> Result<AdminUser, CanopyError> {
        let target = self.users.find_one(doc! { "_id": id }).await.map_err(mongo)?.ok_or_else(not_found)?;
        let view = AdminUser::from_document(&target).ok_or_else(not_found)?;
        if let Some(session) = session {
            Self::guard(session, Some(view.role), None)?;
        }
        let updated = self
            .users
            .find_one_and_update(
                doc! { "_id": id },
                doc! { "$unset": { "totp": "" }, "$set": { "updatedAt": DateTime::from_millis(self.now()) } },
            )
            .return_document(ReturnDocument::After)
            .await
            .map_err(mongo)?;
        self.sessions.delete_many(doc! { "userId": id }).await.map_err(mongo)?;
        self.audit
            .record(doc! {
                "action": "admin.totp.reset", "actor": actor.to_document(),
                "target": { "adminId": id, "email": &view.email, "role": view.role.as_str() }, "origin": origin.to_document(),
            })
            .await?;
        Ok(updated.as_ref().and_then(AdminUser::from_document).unwrap_or(view))
    }

    /// Changes an admin's role, name or disabled flag. Their sessions end when the role or flag changes.
    pub(crate) async fn update(
        &self,
        actor: &AdminSession,
        id: &str,
        changes: &AdminChanges,
        origin: &RequestOrigin,
    ) -> Result<AdminUser, CanopyError> {
        let target = self.users.find_one(doc! { "_id": id }).await.map_err(mongo)?.ok_or_else(not_found)?;
        let before = AdminUser::from_document(&target).ok_or_else(not_found)?;
        Self::guard(actor, Some(before.role), changes.role)?;
        if id == actor.user.id && (changes.role.is_some() || changes.disabled.is_some()) {
            return Err(err(ErrorCode::Forbidden, "You cannot change your own role or disable yourself"));
        }
        let loses_owner = before.role == AdminRole::Owner
            && !before.disabled
            && (changes.role.is_some_and(|role| role != AdminRole::Owner) || changes.disabled == Some(true));
        let mut set = Document::new();
        if let Some(role) = changes.role {
            set.insert("role", role.as_str());
        }
        if let Some(disabled) = changes.disabled {
            set.insert("disabled", disabled);
        }
        if let Some(name) = &changes.name {
            set.insert("name", name);
        }
        set.insert("updatedAt", DateTime::from_millis(self.now()));
        let ends_sessions = changes.role.is_some() || changes.disabled == Some(true);
        let (users, sessions, audit) = (self.users.clone(), self.sessions.clone(), self.audit.clone());
        let (actor_doc, origin_doc) = (actor.user.actor(None).to_document(), origin.to_document());
        let name_of = |user: &AdminUser| user.name.clone().map_or(Bson::Null, Bson::String);
        let before_doc =
            doc! { "role": before.role.as_str(), "disabled": before.disabled, "name": name_of(&before) };
        let updated = transaction(&self.client, |session| {
            let (users, sessions, audit, set) = (users.clone(), sessions.clone(), audit.clone(), set.clone());
            let (actor_doc, origin_doc, before_doc, id) =
                (actor_doc.clone(), origin_doc.clone(), before_doc.clone(), id.to_owned());
            Box::pin(async move {
                if loses_owner {
                    let owners = users
                        .count_documents(doc! { "role": "owner", "disabled": false })
                        .session(&mut *session)
                        .await?;
                    if owners <= 1 {
                        return Err(Abort::Refused(err(
                            ErrorCode::Conflict,
                            "The last owner cannot be demoted or disabled",
                        )));
                    }
                }
                let result = users
                    .find_one_and_update(doc! { "_id": &id }, doc! { "$set": set })
                    .return_document(ReturnDocument::After)
                    .session(&mut *session)
                    .await?;
                let Some(result) = result.as_ref().and_then(AdminUser::from_document) else {
                    return Err(Abort::Refused(not_found()));
                };
                if ends_sessions {
                    sessions.delete_many(doc! { "userId": &id }).session(&mut *session).await?;
                }
                let after = doc! {
                    "role": result.role.as_str(), "disabled": result.disabled,
                    "name": result.name.clone().map_or(Bson::Null, Bson::String),
                };
                audit
                    .record_in(
                        doc! {
                            "action": "admin.update", "actor": actor_doc, "target": { "adminId": &id },
                            "diff": { "before": before_doc, "after": after }, "origin": origin_doc,
                        },
                        session,
                    )
                    .await?;
                Ok(result)
            })
        })
        .await?;
        Ok(updated)
    }

    /// Removes an admin and ends their sessions.
    pub(crate) async fn remove(
        &self,
        actor: &AdminSession,
        id: &str,
        origin: &RequestOrigin,
    ) -> Result<(), CanopyError> {
        let target = self.users.find_one(doc! { "_id": id }).await.map_err(mongo)?.ok_or_else(not_found)?;
        let view = AdminUser::from_document(&target).ok_or_else(not_found)?;
        Self::guard(actor, Some(view.role), None)?;
        if id == actor.user.id {
            return Err(err(ErrorCode::Forbidden, "You cannot remove yourself"));
        }
        let (users, sessions, audit) = (self.users.clone(), self.sessions.clone(), self.audit.clone());
        let entry = doc! {
            "action": "admin.remove", "actor": actor.user.actor(None).to_document(),
            "target": { "adminId": id, "email": &view.email, "role": view.role.as_str() }, "origin": origin.to_document(),
        };
        let last_owner = view.role == AdminRole::Owner && !view.disabled;
        transaction(&self.client, |session| {
            let (users, sessions, audit, entry, id) =
                (users.clone(), sessions.clone(), audit.clone(), entry.clone(), id.to_owned());
            Box::pin(async move {
                if last_owner {
                    let owners = users
                        .count_documents(doc! { "role": "owner", "disabled": false })
                        .session(&mut *session)
                        .await?;
                    if owners <= 1 {
                        return Err(Abort::Refused(err(
                            ErrorCode::Conflict,
                            "The last owner cannot be removed",
                        )));
                    }
                }
                users.delete_one(doc! { "_id": &id }).session(&mut *session).await?;
                sessions.delete_many(doc! { "userId": &id }).session(&mut *session).await?;
                audit.record_in(entry, session).await?;
                Ok(())
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_trimmed_lowercased_and_checked() {
        assert_eq!(normalize_email(" Owner@Example.TEST ").ok().as_deref(), Some("owner@example.test"));
        for invalid in ["owner", "@example.test", "owner@", "a b@example.test", "a@b@c"] {
            assert!(normalize_email(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn csrf_hashes_are_salted_sha256() {
        assert_eq!(csrf_hash("x"), sha256_hex("csrf:x"));
        assert_ne!(csrf_hash("x"), sha256_hex("x"));
    }
}
