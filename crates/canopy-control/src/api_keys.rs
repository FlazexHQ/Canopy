//! Management of the API keys stored in `api_keys`: creating, listing and revoking them. Secret keys are
//! stored as a hash and a SCRAM-SHA-256 verifier only; publishable keys are public and kept whole.

use std::num::NonZeroU32;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use canopy_mongo::mongodb::Collection;
use canopy_mongo::mongodb::bson::{DateTime, Document, doc};
use canopy_mongo::mongodb::options::ReturnDocument;
use canopy_protocol::{CanopyError, ErrorCode};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{digest, hmac, pbkdf2};

use crate::core::{Clock, collect, err, mongo, random_url, text};
use crate::http::sha256_hex;

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH: usize = 32;
const DISPLAY_LENGTH: usize = 8;
const SCRAM_ITERATIONS: u32 = 15_000;

/// The kind of an API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyKind {
    Publishable,
    Secret,
}

impl KeyKind {
    pub(crate) fn parse(text: &str) -> Option<KeyKind> {
        match text {
            "publishable" => Some(KeyKind::Publishable),
            "secret" => Some(KeyKind::Secret),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            KeyKind::Publishable => "publishable",
            KeyKind::Secret => "secret",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            KeyKind::Publishable => "canopy_pk_",
            KeyKind::Secret => "canopy_sk_",
        }
    }
}

fn no_randomness() -> CanopyError {
    err(ErrorCode::Internal, "No randomness")
}

/// A new key: the kind's prefix and 32 random base62 characters, every character equally likely.
fn generate(kind: KeyKind) -> Result<String, CanopyError> {
    let mut out = String::from(kind.prefix());
    let random = SystemRandom::new();
    let mut bytes = [0u8; 64];
    while out.len() < kind.prefix().len() + RANDOM_LENGTH {
        random.fill(&mut bytes).map_err(|_| no_randomness())?;
        for byte in bytes {
            if byte >= 248 {
                continue;
            }
            out.push(char::from(BASE62[usize::from(byte % 62)]));
            if out.len() == kind.prefix().len() + RANDOM_LENGTH {
                break;
            }
        }
    }
    Ok(out)
}

/// The stored hash of a key.
pub(crate) fn hash_key(key: &str) -> String {
    format!("sha256:{}", sha256_hex(key))
}

fn scram(key: &str) -> Result<Document, CanopyError> {
    let mut salt = [0u8; 16];
    SystemRandom::new().fill(&mut salt).map_err(|_| no_randomness())?;
    let mut salted = [0u8; 32];
    let iterations = NonZeroU32::new(SCRAM_ITERATIONS).ok_or_else(no_randomness)?;
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, iterations, &salt, key.as_bytes(), &mut salted);
    let signing = hmac::Key::new(hmac::HMAC_SHA256, &salted);
    let client = hmac::sign(&signing, b"Client Key");
    let server = hmac::sign(&signing, b"Server Key");
    Ok(doc! {
        "salt": STANDARD.encode(salt),
        "iterations": i32::try_from(SCRAM_ITERATIONS).unwrap_or(i32::MAX),
        "storedKey": STANDARD.encode(digest::digest(&digest::SHA256, client.as_ref())),
        "serverKey": STANDARD.encode(server.as_ref()),
    })
}

fn info(document: &Document) -> Document {
    let mut out = doc! {
        "id": text(document, "_id").unwrap_or_default(),
        "kind": text(document, "kind").unwrap_or_default(),
        "name": text(document, "name").unwrap_or_default(),
        "prefix": text(document, "prefix").unwrap_or_default(),
    };
    if text(document, "kind") == Some("publishable")
        && let Some(key) = document.get("key")
    {
        out.insert("key", key.clone());
    }
    if let Some(at) = document.get("createdAt") {
        out.insert("createdAt", at.clone());
    }
    out.insert("createdBy", text(document, "createdBy").unwrap_or_default());
    for key in ["lastUsedAt", "revokedAt", "revokedBy"] {
        if let Some(value) = document.get(key) {
            out.insert(key, value.clone());
        }
    }
    out
}

/// The API keys of the meta database.
pub(crate) struct ApiKeyStore {
    collection: Collection<Document>,
    now: Clock,
}

impl ApiKeyStore {
    pub(crate) fn new(collection: Collection<Document>, now: Clock) -> ApiKeyStore {
        ApiKeyStore { collection, now }
    }

    /// Creates a key. The returned `key` is the only time a secret key is ever available in full.
    pub(crate) async fn create(
        &self,
        kind: KeyKind,
        name: &str,
        created_by: &str,
    ) -> Result<Document, CanopyError> {
        let key = generate(kind)?;
        let prefix: String = key.chars().skip(kind.prefix().len()).take(DISPLAY_LENGTH).collect();
        let mut stored = doc! {
            "_id": format!("key_{}", random_url(12)?),
            "kind": kind.as_str(),
            "name": name,
            "prefix": prefix,
            "hash": hash_key(&key),
        };
        match kind {
            KeyKind::Publishable => stored.insert("key", &key),
            KeyKind::Secret => {
                let secret = key.clone();
                stored.insert("scram", crate::passwords::blocking(move || scram(&secret)).await??)
            }
        };
        stored.insert("createdAt", DateTime::from_millis((self.now)()));
        stored.insert("createdBy", created_by);
        self.collection.insert_one(&stored).await.map_err(mongo)?;
        Ok(doc! { "key": key, "info": info(&stored) })
    }

    pub(crate) async fn list(&self) -> Result<Vec<Document>, CanopyError> {
        let found = collect(
            self.collection.find(Document::new()).sort(doc! { "createdAt": -1 }).await.map_err(mongo)?,
        )
        .await?;
        Ok(found.iter().map(info).collect())
    }

    pub(crate) async fn get(&self, id: &str) -> Result<Option<Document>, CanopyError> {
        Ok(self.collection.find_one(doc! { "_id": id }).await.map_err(mongo)?.as_ref().map(info))
    }

    /// Revokes a key for good. Revoking a revoked key keeps the first revocation.
    pub(crate) async fn revoke(&self, id: &str, revoked_by: &str) -> Result<Document, CanopyError> {
        let now = DateTime::from_millis((self.now)());
        let update = vec![doc! { "$set": {
            "revokedAt": { "$ifNull": ["$revokedAt", now] },
            "revokedBy": { "$ifNull": ["$revokedBy", revoked_by] },
        } }];
        let found = self
            .collection
            .find_one_and_update(doc! { "_id": id }, update)
            .return_document(ReturnDocument::After)
            .await
            .map_err(mongo)?;
        found.as_ref().map(info).ok_or_else(|| err(ErrorCode::NotFound, "No such API key"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_have_their_prefix_and_32_base62_characters() -> Result<(), CanopyError> {
        for kind in [KeyKind::Publishable, KeyKind::Secret] {
            let key = generate(kind)?;
            let random = key.strip_prefix(kind.prefix()).unwrap_or_default();
            assert_eq!(random.len(), 32);
            assert!(random.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        }
        assert_eq!(
            hash_key("abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        Ok(())
    }
}
