//! Secrets stored in the meta database, sealed with AES-256-GCM under a key derived from the master key.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_protocol::{CanopyError, ErrorCode};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};

const VERSION: &str = "v1";
const PLAIN: &str = "plain:";

struct KeyLength;

impl hkdf::KeyType for KeyLength {
    fn len(&self) -> usize {
        32
    }
}

fn derive(master_key: &str) -> Option<[u8; 32]> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"canopy");
    let info: &[&[u8]] = &[b"canopy meta secrets v1"];
    let mut key = [0u8; 32];
    salt.extract(master_key.as_bytes()).expand(info, KeyLength).ok()?.fill(&mut key).ok()?;
    Some(key)
}

fn undecryptable() -> CanopyError {
    CanopyError::new(ErrorCode::Internal, "A stored secret cannot be decrypted with this master key")
}

/// Seals and opens secrets kept in the meta database. Without a master key (development only) secrets are
/// kept with a `plain:` marker, so they can be sealed once a master key is set. Secrets sealed with one of
/// the previous master keys still open, so the master key can be rotated without downtime.
pub(crate) struct SecretBox {
    key: Option<[u8; 32]>,
    previous: Vec<[u8; 32]>,
}

impl SecretBox {
    /// A box for the current master key and the previous ones that may still have sealed secrets.
    pub(crate) fn new(master_key: Option<&str>, previous_master_keys: &[String]) -> SecretBox {
        SecretBox {
            key: master_key.filter(|key| !key.is_empty()).and_then(derive),
            previous: previous_master_keys
                .iter()
                .filter(|key| !key.is_empty())
                .filter_map(|key| derive(key))
                .collect(),
        }
    }

    /// Whether secrets are encrypted.
    pub(crate) fn encrypting(&self) -> bool {
        self.key.is_some()
    }

    /// Seals `plaintext`, bound to `context` (another context cannot open it).
    pub(crate) fn seal(&self, plaintext: &str, context: &str) -> Result<String, CanopyError> {
        let Some(key) = self.key else { return Ok(format!("{PLAIN}{plaintext}")) };
        let mut iv = [0u8; 12];
        SystemRandom::new()
            .fill(&mut iv)
            .map_err(|_| CanopyError::new(ErrorCode::Internal, "No randomness"))?;
        let sealing = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).map_err(|_| undecryptable())?);
        let mut body = plaintext.as_bytes().to_vec();
        sealing
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(iv),
                Aad::from(context.as_bytes()),
                &mut body,
            )
            .map_err(|_| CanopyError::new(ErrorCode::Internal, "A secret could not be sealed"))?;
        Ok(format!("{VERSION}.{}.{}", URL_SAFE_NO_PAD.encode(iv), URL_SAFE_NO_PAD.encode(body)))
    }

    /// Opens a sealed secret.
    pub(crate) fn open(&self, sealed: &str, context: &str) -> Result<String, CanopyError> {
        self.unseal(sealed, context).map(|(plaintext, _)| plaintext)
    }

    /// Whether `sealed` is sealed with the current master key, or stays in plain text because there is none.
    /// Anything else should be sealed again.
    pub(crate) fn is_current(&self, sealed: &str, context: &str) -> Result<bool, CanopyError> {
        if sealed.starts_with(PLAIN) {
            return Ok(self.key.is_none());
        }
        self.unseal(sealed, context).map(|(_, current)| current)
    }

    fn unseal(&self, sealed: &str, context: &str) -> Result<(String, bool), CanopyError> {
        if let Some(plaintext) = sealed.strip_prefix(PLAIN) {
            return Ok((plaintext.to_owned(), true));
        }
        let mut parts = sealed.split('.');
        let (Some(VERSION), Some(iv), Some(body), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(undecryptable());
        };
        let iv: [u8; 12] =
            URL_SAFE_NO_PAD.decode(iv).ok().and_then(|iv| iv.try_into().ok()).ok_or_else(undecryptable)?;
        let bytes = URL_SAFE_NO_PAD.decode(body).map_err(|_| undecryptable())?;
        let keys = self.key.iter().map(|key| (key, true)).chain(self.previous.iter().map(|key| (key, false)));
        for (key, current) in keys {
            let Ok(unbound) = UnboundKey::new(&AES_256_GCM, key) else { continue };
            let mut buffer = bytes.clone();
            let opened = LessSafeKey::new(unbound).open_in_place(
                Nonce::assume_unique_for_key(iv),
                Aad::from(context.as_bytes()),
                &mut buffer,
            );
            if let Ok(plaintext) = opened {
                let text = String::from_utf8(plaintext.to_vec()).map_err(|_| undecryptable())?;
                return Ok((text, current));
            }
        }
        Err(undecryptable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_secrets_open_only_in_their_context_and_survive_rotation() -> Result<(), CanopyError> {
        let old = SecretBox::new(Some("old master key"), &[]);
        let sealed = old.seal("JBSWY3DPEHPK3PXP", "totp:a@b")?;
        assert!(sealed.starts_with("v1."));
        assert_eq!(old.open(&sealed, "totp:a@b")?, "JBSWY3DPEHPK3PXP");
        assert!(old.open(&sealed, "totp:other@b").is_err());
        let rotated = SecretBox::new(Some("new master key"), &["old master key".to_owned()]);
        assert_eq!(rotated.open(&sealed, "totp:a@b")?, "JBSWY3DPEHPK3PXP");
        assert!(!rotated.is_current(&sealed, "totp:a@b")?);
        let resealed = rotated.seal("JBSWY3DPEHPK3PXP", "totp:a@b")?;
        assert!(rotated.is_current(&resealed, "totp:a@b")?);
        assert!(SecretBox::new(Some("other"), &[]).open(&sealed, "totp:a@b").is_err());
        Ok(())
    }

    #[test]
    fn without_a_master_key_secrets_are_marked_plain() -> Result<(), CanopyError> {
        let plain = SecretBox::new(None, &[]);
        assert!(!plain.encrypting());
        let sealed = plain.seal("s", "c")?;
        assert_eq!(sealed, "plain:s");
        assert!(plain.is_current(&sealed, "c")?);
        assert!(!SecretBox::new(Some("k"), &[]).is_current(&sealed, "c")?);
        assert_eq!(SecretBox::new(Some("k"), &[]).open(&sealed, "c")?, "s");
        Ok(())
    }

    #[test]
    fn keys_and_sealed_secrets_match_the_typescript_server() -> Result<(), CanopyError> {
        let master = "m".repeat(48);
        let derived = derive(&master).map(|key| canopy_protocol::hex(&key));
        assert_eq!(
            derived.as_deref(),
            Some("d1b196956d0ad2d9fb461a6d16d9d1adf20e753906c3b43af2fd81a254eb3a67")
        );
        let sealed = "v1.AAECAwQFBgcICQoL.yeFlJMc33hIYurpbFjC61aSRI28uwjfaRVbf3X5Y48Q";
        let secrets = SecretBox::new(Some(&master), &[]);
        assert_eq!(secrets.open(sealed, "totp:owner@example.test")?, "JBSWY3DPEHPK3PXP");
        assert!(secrets.is_current(sealed, "totp:owner@example.test")?);
        Ok(())
    }
}
