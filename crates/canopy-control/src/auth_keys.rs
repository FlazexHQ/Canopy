use std::sync::Arc;

use canopy_authn::key_material::generate;
pub use canopy_authn::tokens::Algorithm;
use canopy_mongo::mongodb::{
    ClientSession, Collection, Database,
    bson::{DateTime, Document, doc},
};
use canopy_protocol::{CanopyError, ErrorCode};

use crate::core::{collect, err, is_duplicate, millis, mongo, text, to_value, transaction};
use crate::{BoxFuture, Call, Clock, Delegate, Reply};

const LEASE: &str = "signing-keys";

/// Settings shared with the built in auth keyring.
pub struct SigningKeyOptions {
    /// The algorithm for new signing keys.
    pub algorithm: Algorithm,
    /// The time in milliseconds for which a key signs.
    pub interval_ms: i64,
    /// The Better Auth secret used to encrypt new private keys.
    pub secret: Option<String>,
}

/// Admin routes for the signing keys of built in auth.
#[derive(Clone)]
pub struct SigningKeyRoutes {
    database: Database,
    keys: Collection<Document>,
    options: Arc<SigningKeyOptions>,
    clock: Clock,
}

impl SigningKeyRoutes {
    /// Reads and writes signing keys in the given auth database.
    pub fn new(database: Database, options: SigningKeyOptions, clock: Clock) -> Result<Self, CanopyError> {
        if options.interval_ms <= 0 {
            return Err(err(ErrorCode::ValidationFailed, "The rotation interval must be positive"));
        }
        Ok(Self { keys: database.collection("signing_keys"), database, options: Arc::new(options), clock })
    }

    /// Ensures an active and a standby key if this node can take the scheduled rotation lease.
    pub async fn tick(&self, owner: &str, refresh_ms: i64) -> Result<bool, CanopyError> {
        let now = (self.clock)();
        let expires = now.saturating_add(refresh_ms.saturating_mul(3).max(10_000));
        let leases = self.database.collection::<Document>("leases");
        match leases.update_one(
            doc! { "_id": LEASE, "$or": [{ "owner": owner }, { "expiresAt": { "$lte": DateTime::from_millis(now) } }] },
            doc! { "$set": { "owner": owner, "expiresAt": DateTime::from_millis(expires) } },
        ).upsert(true).await {
            Ok(_) => {}
            Err(error) if is_duplicate(&error) => return Ok(false),
            Err(error) => return Err(mongo(error)),
        }
        transaction(self.database.client(), |session| {
            let routes = self.clone();
            Box::pin(async move { routes.ensure(session, now).await })
        })
        .await?;
        Ok(true)
    }

    async fn eligible(&self, session: &mut ClientSession) -> Result<Vec<Document>, crate::core::Abort> {
        let algorithm = match self.options.algorithm {
            Algorithm::EdDSA => "EdDSA",
            Algorithm::ES256 => "ES256",
        };
        let mut cursor = self
            .keys
            .find(doc! { "revokedAt": { "$exists": false }, "alg": algorithm })
            .sort(doc! { "createdAt": 1 })
            .session(&mut *session)
            .await?;
        let mut keys = Vec::new();
        while let Some(key) = cursor.next(&mut *session).await {
            keys.push(key?);
        }
        Ok(keys)
    }

    fn expiry(&self, from: i64) -> i64 {
        from.saturating_add(self.options.interval_ms)
    }

    async fn insert(&self, session: &mut ClientSession, from: i64) -> Result<i64, crate::core::Abort> {
        let expires = self.expiry(from);
        let secret = self.options.secret.as_deref().ok_or_else(|| {
            err(ErrorCode::Unavailable, "Signing key rotation needs auth.secret or CANOPY_MASTER_KEY")
        })?;
        let document = generate(self.options.algorithm, secret, from, expires)
            .map_err(|error| err(ErrorCode::Internal, error.to_string()))?;
        self.keys.insert_one(document).session(session).await?;
        Ok(expires)
    }

    async fn ensure(&self, session: &mut ClientSession, now: i64) -> Result<(), crate::core::Abort> {
        let keys = self.eligible(session).await?;
        let expires = match keys.iter().rev().find(|key| active(key, now)) {
            Some(key) => date(key, "expiresAt")?,
            None => self.insert(session, now).await?,
        };
        if !keys.iter().any(|key| standby(key, now)) {
            self.insert(session, expires).await?;
        }
        Ok(())
    }

    async fn rotate(&self, session: &mut ClientSession, now: i64) -> Result<(), crate::core::Abort> {
        self.ensure(session, now).await?;
        let keys = self.eligible(session).await?;
        let at = DateTime::from_millis(now);
        if let Some(key) = keys.iter().find(|key| standby(key, now)) {
            self.keys.update_one(
                doc! { "_id": required(key, "_id")? },
                doc! { "$set": { "createdAt": at, "expiresAt": DateTime::from_millis(self.expiry(now)) } },
            ).session(&mut *session).await?;
        }
        for key in keys.iter().filter(|key| active(key, now)) {
            self.keys
                .update_one(doc! { "_id": required(key, "_id")? }, doc! { "$set": { "expiresAt": at } })
                .session(&mut *session)
                .await?;
        }
        self.ensure(session, now).await
    }

    async fn revoke(
        &self,
        session: &mut ClientSession,
        kid: &str,
        now: i64,
    ) -> Result<(), crate::core::Abort> {
        let key = self
            .keys
            .find_one(doc! { "_id": kid, "revokedAt": { "$exists": false } })
            .session(&mut *session)
            .await?
            .ok_or_else(|| err(ErrorCode::NotFound, "No such signing key"))?;
        if active(&key, now) {
            self.rotate(session, now).await?;
        }
        let expires = now.min(date(&key, "expiresAt")?);
        self.keys.update_one(
            doc! { "_id": kid },
            doc! { "$set": { "revokedAt": DateTime::from_millis(now), "expiresAt": DateTime::from_millis(expires) } },
        ).session(&mut *session).await?;
        self.ensure(session, now).await
    }

    async fn list(&self, now: i64) -> Result<Vec<Document>, CanopyError> {
        let cursor = self.keys.find(doc! {}).sort(doc! { "createdAt": -1 }).await.map_err(mongo)?;
        collect(cursor).await?.iter().map(|key| info(key, now)).collect()
    }
}

fn invalid() -> CanopyError {
    err(ErrorCode::Internal, "Invalid signing key document")
}

fn required<'a>(key: &'a Document, field: &str) -> Result<&'a str, CanopyError> {
    text(key, field).ok_or_else(invalid)
}

fn date(key: &Document, field: &str) -> Result<i64, CanopyError> {
    millis(key, field).ok_or_else(invalid)
}

fn standby(key: &Document, now: i64) -> bool {
    millis(key, "createdAt").is_some_and(|at| at > now)
}

fn active(key: &Document, now: i64) -> bool {
    millis(key, "createdAt").is_some_and(|at| at <= now)
        && millis(key, "expiresAt").is_some_and(|at| at > now)
}

fn info(key: &Document, now: i64) -> Result<Document, CanopyError> {
    let created = date(key, "createdAt")?;
    let expires = date(key, "expiresAt")?;
    let revoked = key.contains_key("revokedAt").then(|| date(key, "revokedAt")).transpose()?;
    let state = if revoked.is_some() {
        "revoked"
    } else if created > now {
        "standby"
    } else if expires > now {
        "active"
    } else {
        "retired"
    };
    let mut info = doc! {
        "kid": required(key, "_id")?, "alg": required(key, "alg")?, "state": state,
        "createdAt": DateTime::from_millis(created), "expiresAt": DateTime::from_millis(expires),
    };
    if let Some(at) = revoked {
        info.insert("revokedAt", DateTime::from_millis(at));
    }
    Ok(info)
}

impl Delegate for SigningKeyRoutes {
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>> {
        Box::pin(async move {
            let now = (self.clock)();
            let audit = match call.route.as_str() {
                "GET auth/keys" => None,
                "POST auth/keys/rotate" => {
                    transaction(self.database.client(), |session| {
                        let routes = self.clone();
                        Box::pin(async move { routes.rotate(session, now).await })
                    })
                    .await?;
                    Some(doc! { "action": "auth.keys.rotate" })
                }
                "DELETE auth/keys/:kid" => {
                    let kid = call.param("kid").to_owned();
                    transaction(self.database.client(), |session| {
                        let routes = self.clone();
                        let kid = kid.clone();
                        Box::pin(async move { routes.revoke(session, &kid, now).await })
                    })
                    .await?;
                    Some(doc! { "action": "auth.keys.revoke", "target": { "kid": kid } })
                }
                _ => return Err(err(ErrorCode::NotFound, "No such route")),
            };
            let list = self.list(now).await?;
            let mut reply = Reply::json(200, to_value(&doc! { "data": list })?);
            reply.audit.extend(audit);
            Ok(reply)
        })
    }
}
