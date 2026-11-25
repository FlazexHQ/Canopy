use base64::{
    Engine, alphabet,
    engine::{
        GeneralPurpose,
        general_purpose::{NO_PAD, STANDARD},
    },
};
use canopy_protocol::CanopyError;
use ring::hmac;

use crate::invalid;

/// Signs payloads the way Standard Webhooks expects: HMAC SHA-256 over `id.timestamp.body`.
pub struct Signer {
    key: hmac::Key,
}

impl Signer {
    /// Reads a secret, either `whsec_` followed by base64 key bytes or the raw text used as the key.
    pub fn new(secret: &str) -> Result<Self, CanopyError> {
        let bytes = if let Some(encoded) = secret.strip_prefix("whsec_") {
            let compact: String =
                encoded.chars().filter(|ch| !matches!(ch, ' ' | '\t' | '\r' | '\n' | '\x0c')).collect();
            let unpadded = GeneralPurpose::new(&alphabet::STANDARD, NO_PAD);
            STANDARD
                .decode(&compact)
                .or_else(|_| unpadded.decode(&compact))
                .map_err(|_| invalid("Invalid webhook secret"))?
        } else {
            secret.as_bytes().to_vec()
        };
        if bytes.is_empty() {
            return Err(invalid("The webhook secret is empty"));
        }
        Ok(Self { key: hmac::Key::new(hmac::HMAC_SHA256, &bytes) })
    }

    /// The `webhook-signature` header value, `v1,` followed by the base64 signature, for a message id,
    /// a Unix time in seconds and the exact body sent.
    pub fn sign(&self, id: &str, timestamp: i64, body: &str) -> String {
        let signed = hmac::sign(&self.key, format!("{id}.{timestamp}.{body}").as_bytes());
        format!("v1,{}", STANDARD.encode(signed.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    #[test]
    fn signs_the_standard_webhooks_example() {
        let signer = Signer::new("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw").expect("secret");
        assert_eq!(
            signer.sign("msg_p5jXN8AQM9LWM0D4loKWxJek", 1_614_265_330, r#"{"test": 2432232314}"#,),
            "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        );
    }

    #[test]
    fn refuses_empty_and_malformed_secrets() {
        assert!(Signer::new("").is_err());
        assert!(Signer::new("whsec_").is_err());
        assert!(Signer::new("whsec_!!!").is_err());
        let raw = Signer::new("plain text key").expect("raw secret");
        assert_ne!(raw.sign("a", 1, "b"), raw.sign("a", 2, "b"));
    }
}
