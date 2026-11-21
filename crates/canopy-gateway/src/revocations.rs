use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use canopy_engine::Principal;
use canopy_protocol::{Document as Claims, Value};
use futures_util::TryStreamExt as _;
use mongodb::{
    Collection, Database,
    bson::{DateTime, Document, doc},
};

use crate::log::Log;

pub(crate) const REVOKED_TOKEN: &str = "The session of this token was revoked";
pub(crate) const REVOKED_SESSION: &str = "The session was revoked";

#[derive(Debug)]
enum Scope {
    Session(String),
    User(String),
    All,
}

#[derive(Clone, Copy, Debug, Default)]
struct Window {
    at: i64,
    expires_at: i64,
}

impl Window {
    fn merge(&mut self, window: Self) {
        self.at = self.at.max(window.at);
        self.expires_at = self.expires_at.max(window.expires_at);
    }

    #[allow(clippy::cast_precision_loss)]
    fn covers(self, iat: Option<f64>, now: i64) -> bool {
        self.expires_at > now && iat.is_none_or(|iat| iat * 1000.0 <= self.at as f64)
    }
}

#[derive(Default)]
struct RevocationSet {
    sessions: HashMap<String, i64>,
    users: HashMap<String, Window>,
    all: Window,
}

impl RevocationSet {
    fn add(&mut self, doc: &Document, now: i64) {
        let parse = || {
            let scope = match doc.get_str("kind").ok()? {
                "session" => Scope::Session(doc.get_str("sid").ok()?.to_owned()),
                "user" => Scope::User(doc.get_str("sub").ok()?.to_owned()),
                "all" => Scope::All,
                _ => return None,
            };
            let window = Window {
                at: doc.get_datetime("at").ok()?.timestamp_millis(),
                expires_at: doc.get_datetime("expiresAt").ok()?.timestamp_millis(),
            };
            (window.expires_at > now).then_some((scope, window))
        };
        let Some((scope, window)) = parse() else { return };
        match scope {
            Scope::Session(sid) => {
                let until = self.sessions.entry(sid).or_default();
                *until = (*until).max(window.expires_at);
            }
            Scope::User(sub) => self.users.entry(sub).or_default().merge(window),
            Scope::All => self.all.merge(window),
        }
    }

    fn prune(&mut self, now: i64) {
        self.sessions.retain(|_, until| *until > now);
        self.users.retain(|_, window| window.expires_at > now);
        if self.all.expires_at <= now {
            self.all = Window::default();
        }
    }

    fn has(&self, claims: &Claims, now: i64) -> bool {
        if let Some(Value::String(sid)) = claims.get("sid")
            && self.sessions.get(sid).is_some_and(|until| *until > now)
        {
            return true;
        }
        let iat = match claims.get("iat") {
            Some(Value::Double(iat)) => Some(*iat),
            Some(Value::Int32(iat)) => Some(f64::from(*iat)),
            _ => None,
        };
        self.all.covers(iat, now)
            || matches!(claims.get("sub"), Some(Value::String(sub))
                if self.users.get(sub).is_some_and(|window| window.covers(iat, now)))
    }
}

/// The built in auth revocations held in memory and followed through the meta database.
pub(crate) struct Revocations {
    collection: Collection<Document>,
    set: RwLock<RevocationSet>,
}

impl Revocations {
    pub(crate) fn new(meta: &Database) -> Self {
        Self { collection: meta.collection("revocations"), set: RwLock::default() }
    }

    /// Whether a verified token is covered by a current revocation.
    pub(crate) fn has(&self, principal: &Principal) -> bool {
        principal.claims.as_ref().is_some_and(|claims| self.has_claims(claims))
    }

    pub(crate) fn has_claims(&self, claims: &Claims) -> bool {
        self.set
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .has(claims, DateTime::now().timestamp_millis())
    }

    /// Opens the stream before loading outstanding revocations, so inserts during startup are seen.
    pub(crate) async fn start(
        &self,
    ) -> mongodb::error::Result<
        mongodb::change_stream::ChangeStream<mongodb::change_stream::event::ChangeStreamEvent<Document>>,
    > {
        let kinds = ["session", "user", "all"];
        let stream = self
            .collection
            .watch()
            .pipeline([doc! {
                "$match": { "operationType": "insert", "fullDocument.kind": { "$in": kinds } },
            }])
            .await?;
        let now = DateTime::now();
        let mut docs = self
            .collection
            .find(doc! {
                "kind": { "$in": kinds },
                "expiresAt": { "$gt": now },
            })
            .await?;
        let mut active = Vec::new();
        while let Some(doc) = docs.try_next().await? {
            active.push(doc);
        }
        let mut set = self.set.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        set.prune(now.timestamp_millis());
        for doc in active {
            set.add(&doc, now.timestamp_millis());
        }
        Ok(stream)
    }

    pub(crate) async fn watch(
        &self,
        initial: mongodb::change_stream::ChangeStream<
            mongodb::change_stream::event::ChangeStreamEvent<Document>,
        >,
        on_change: impl Fn(),
        log: Log,
    ) {
        let mut delay = Duration::from_secs(1);
        let mut stream = Some(initial);
        loop {
            let result = async {
                let mut stream = match stream.take() {
                    Some(stream) => stream,
                    None => {
                        let stream = self.start().await?;
                        on_change();
                        stream
                    }
                };
                delay = Duration::from_secs(1);
                while let Some(event) = stream.try_next().await? {
                    if let Some(doc) = event.full_document {
                        let now = DateTime::now().timestamp_millis();
                        {
                            let mut set = self.set.write().unwrap_or_else(std::sync::PoisonError::into_inner);
                            set.prune(now);
                            set.add(&doc, now);
                        }
                        on_change();
                    }
                }
                Ok::<(), mongodb::error::Error>(())
            }
            .await;
            if let Err(error) = result {
                log.warn("Session revocation stream failed; reopening", &[("err", &error.to_string())]);
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn claims(sub: &str, sid: &str, iat: Option<i32>) -> Claims {
        let mut claims = Claims::new();
        claims.insert("sub".to_owned(), Value::String(sub.to_owned()));
        claims.insert("sid".to_owned(), Value::String(sid.to_owned()));
        if let Some(iat) = iat {
            claims.insert("iat".to_owned(), Value::Int32(iat));
        }
        claims
    }

    #[test]
    fn checks_session_user_and_global_revocations() {
        let mut set = RevocationSet::default();
        let mut revocation = doc! {
            "kind": "session", "sub": "alice", "sid": "old",
            "at": DateTime::from_millis(1000), "expiresAt": DateTime::from_millis(3000),
        };
        set.add(&revocation, 1000);
        assert!(set.has(&claims("alice", "old", Some(2)), 2999));
        assert!(!set.has(&claims("alice", "old", Some(2)), 3000));
        assert!(!set.has(&claims("alice", "new", Some(1)), 1000));

        revocation.insert("kind", "user");
        set.add(&revocation, 1000);
        assert!(set.has(&claims("alice", "new", Some(1)), 1000));
        assert!(!set.has(&claims("alice", "new", Some(2)), 1000));
        assert!(!set.has(&claims("bob", "new", None), 1000));

        revocation.insert("kind", "all");
        set.add(&revocation, 1000);
        assert!(set.has(&claims("bob", "new", None), 1000));
        set.prune(3000);
        assert!(set.sessions.is_empty() && set.users.is_empty());
        assert!(!set.has(&claims("bob", "new", None), 3000));
    }
}
