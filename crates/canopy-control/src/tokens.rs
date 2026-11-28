//! Long lived admin API tokens for CI and GitOps in `admin_tokens`. A token is stored as a hash with a
//! display prefix and shown once; it acts as its admin with the lower of its role and the admin's current
//! role, and stops working when it is revoked, expires, or its admin is disabled or removed.

use canopy_mongo::mongodb::Collection;
use canopy_mongo::mongodb::bson::{DateTime, Document, doc};
use canopy_mongo::mongodb::options::ReturnDocument;
use canopy_protocol::{CanopyError, ErrorCode};

use crate::accounts::{AdminAccounts, AdminSession, TokenRef, Transport};
use crate::core::{AuditLog, Clock, RequestOrigin, collect, err, millis, mongo, random_url, text};
use crate::http::sha256_hex;
use crate::rbac::AdminRole;

/// The prefix of every admin API token, so leaked tokens are easy to recognize and scan for.
pub(crate) const ADMIN_TOKEN_PREFIX: &str = "canopy_pat_";
const DISPLAY_LENGTH: usize = ADMIN_TOKEN_PREFIX.len() + 6;
const MAX_LIFETIME_DAYS: i64 = 3650;
const TOUCH_MS: i64 = 60_000;

/// Admin API tokens.
pub(crate) struct AdminTokens {
    pub(crate) collection: Collection<Document>,
    audit: AuditLog,
    now: Clock,
}

impl AdminTokens {
    pub(crate) fn new(collection: Collection<Document>, audit: AuditLog, now: Clock) -> AdminTokens {
        AdminTokens { collection, audit, now }
    }

    /// Whether a bearer value looks like an admin API token rather than a session token.
    pub(crate) fn is_token(value: &str) -> bool {
        value.starts_with(ADMIN_TOKEN_PREFIX)
    }

    fn info(&self, document: &Document) -> Document {
        let now = (self.now)();
        let mut out = doc! {
            "id": text(document, "_id").unwrap_or_default(),
            "name": text(document, "name").unwrap_or_default(),
            "prefix": text(document, "prefix").unwrap_or_default(),
            "role": text(document, "role").unwrap_or_default(),
            "userId": text(document, "userId").unwrap_or_default(),
        };
        if let Some(value) = document.get("createdAt") {
            out.insert("createdAt", value.clone());
        }
        out.insert("createdBy", text(document, "createdBy").unwrap_or_default());
        for key in ["expiresAt", "lastUsedAt", "revokedAt"] {
            if let Some(value) = document.get(key) {
                out.insert(key, value.clone());
            }
        }
        let active =
            !document.contains_key("revokedAt") && millis(document, "expiresAt").is_none_or(|at| at > now);
        out.insert("active", active);
        out
    }

    /// Creates a token for the signed in admin, for a role no higher than theirs. Only sessions may create
    /// tokens, so a token cannot mint another one.
    pub(crate) async fn create(
        &self,
        session: &AdminSession,
        name: &str,
        role: Option<AdminRole>,
        expires_in_days: Option<i64>,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        if session.transport == Transport::Token {
            return Err(err(
                ErrorCode::Forbidden,
                "Admin API tokens cannot create tokens; sign in to create one",
            ));
        }
        let own = session.user.role;
        let role = role.unwrap_or(own);
        if !role.at_most(own) {
            return Err(err(
                ErrorCode::Forbidden,
                format!("Your role ({}) may not create a token for the {} role", own.as_str(), role.as_str()),
            ));
        }
        if let Some(days) = expires_in_days
            && !(1..=MAX_LIFETIME_DAYS).contains(&days)
        {
            return Err(err(
                ErrorCode::ValidationFailed,
                format!("expiresInDays must be a whole number from 1 to {MAX_LIFETIME_DAYS}"),
            ));
        }
        let token = format!("{ADMIN_TOKEN_PREFIX}{}", random_url(32)?);
        let now = (self.now)();
        let id = format!("tok_{}", random_url(12)?);
        let prefix: String = token.chars().take(DISPLAY_LENGTH).collect();
        let mut stored = doc! {
            "_id": &id,
            "hash": sha256_hex(&token),
            "prefix": &prefix,
            "name": name,
            "role": role.as_str(),
            "userId": &session.user.id,
            "createdAt": DateTime::from_millis(now),
            "createdBy": &session.user.id,
        };
        let expires = expires_in_days.map(|days| DateTime::from_millis(now + days * 86_400_000));
        if let Some(expires) = expires {
            stored.insert("expiresAt", expires);
        }
        self.collection.insert_one(&stored).await.map_err(mongo)?;
        let mut target = doc! { "tokenId": &id, "name": name, "role": role.as_str(), "prefix": &prefix };
        if let Some(expires) = expires {
            target.insert("expiresAt", expires);
        }
        self.audit
            .record(doc! {
                "action": "admin_token.create", "actor": session.user.actor(None).to_document(),
                "target": target, "origin": origin.to_document(),
            })
            .await?;
        let mut out = doc! { "token": token };
        out.extend(self.info(&stored));
        Ok(out)
    }

    /// Lists tokens newest first: those of one admin, or every token.
    pub(crate) async fn list(&self, user_id: Option<&str>) -> Result<Vec<Document>, CanopyError> {
        let filter = user_id.map_or_else(Document::new, |id| doc! { "userId": id });
        let found = collect(
            self.collection.find(filter).sort(doc! { "createdAt": -1 }).limit(1000).await.map_err(mongo)?,
        )
        .await?;
        Ok(found.iter().map(|document| self.info(document)).collect())
    }

    /// Revokes a token at once. Admins revoke their own tokens; `others` lets the caller revoke anyone's, and
    /// tokens with the owner role also need `owners`.
    pub(crate) async fn revoke(
        &self,
        session: &AdminSession,
        id: &str,
        others: bool,
        owners: bool,
        origin: &RequestOrigin,
    ) -> Result<Document, CanopyError> {
        let found = self.collection.find_one(doc! { "_id": id }).await.map_err(mongo)?;
        let mine = found.as_ref().and_then(|doc| text(doc, "userId")) == Some(session.user.id.as_str());
        let Some(stored) = found.filter(|_| mine || others) else {
            return Err(err(ErrorCode::NotFound, "No such admin API token"));
        };
        if !mine && text(&stored, "role") == Some("owner") && !owners {
            return Err(err(ErrorCode::Forbidden, "Only owners may revoke the tokens of owners"));
        }
        let updated = if stored.contains_key("revokedAt") {
            None
        } else {
            self.collection
                .find_one_and_update(
                    doc! { "_id": id },
                    doc! { "$set": { "revokedAt": DateTime::from_millis((self.now)()), "revokedBy": &session.user.id } },
                )
                .return_document(ReturnDocument::After)
                .await
                .map_err(mongo)?
        };
        self.audit
            .record(doc! {
                "action": "admin_token.revoke", "actor": session.user.actor(None).to_document(),
                "target": {
                    "tokenId": id,
                    "name": text(&stored, "name").unwrap_or_default(),
                    "role": text(&stored, "role").unwrap_or_default(),
                    "prefix": text(&stored, "prefix").unwrap_or_default(),
                    "userId": text(&stored, "userId").unwrap_or_default(),
                },
                "origin": origin.to_document(),
            })
            .await?;
        Ok(self.info(updated.as_ref().unwrap_or(&stored)))
    }

    /// The session a token stands for. Known tokens that are refused are audited.
    pub(crate) async fn authenticate(
        &self,
        value: &str,
        accounts: &AdminAccounts,
        origin: &RequestOrigin,
    ) -> Result<Option<AdminSession>, CanopyError> {
        if !Self::is_token(value) || value.encode_utf16().count() > 200 {
            return Ok(None);
        }
        let Some(stored) =
            self.collection.find_one(doc! { "hash": sha256_hex(value) }).await.map_err(mongo)?
        else {
            return Ok(None);
        };
        let now = (self.now)();
        let id = text(&stored, "_id").unwrap_or_default().to_owned();
        let prefix = text(&stored, "prefix").unwrap_or_default().to_owned();
        let refuse = |reason: &'static str, actor: Document| {
            let (id, prefix) = (id.clone(), prefix.clone());
            async move {
                self.audit
                    .record(doc! {
                        "action": "admin_token.use", "actor": actor, "outcome": "failed",
                        "target": { "tokenId": id, "prefix": prefix }, "origin": origin.to_document(),
                        "details": { "reason": reason },
                    })
                    .await
                    .map(|()| None)
            }
        };
        let anonymous = doc! { "type": "system", "id": "anonymous" };
        if stored.contains_key("revokedAt") {
            return refuse("revoked", anonymous).await;
        }
        if millis(&stored, "expiresAt").is_some_and(|at| at <= now) {
            return refuse("expired", anonymous).await;
        }
        let Some(user) = accounts.find(text(&stored, "userId").unwrap_or_default()).await? else {
            return refuse("admin removed", anonymous).await;
        };
        if user.disabled {
            return refuse("admin disabled", user.actor(None).to_document()).await;
        }
        if millis(&stored, "lastUsedAt").is_none_or(|at| now - at >= TOUCH_MS) {
            self.collection
                .update_one(
                    doc! { "_id": &id },
                    doc! { "$set": { "lastUsedAt": DateTime::from_millis(now) } },
                )
                .await
                .map_err(mongo)?;
        }
        let role = text(&stored, "role").and_then(AdminRole::parse).unwrap_or(AdminRole::Viewer);
        let mut acting = user;
        acting.role = role.lower(acting.role);
        Ok(Some(AdminSession {
            id: id.clone(),
            user: acting,
            transport: Transport::Token,
            csrf_hash: String::new(),
            expires_at: millis(&stored, "expiresAt"),
            token: Some(TokenRef {
                id,
                name: text(&stored, "name").unwrap_or_default().to_owned(),
                prefix,
                role,
            }),
        }))
    }
}

/// The token of a session as `GET /admin/v1/me` shows it.
pub(crate) fn token_document(token: &TokenRef) -> Document {
    doc! { "id": &token.id, "name": &token.name, "prefix": &token.prefix, "role": token.role.as_str() }
}
