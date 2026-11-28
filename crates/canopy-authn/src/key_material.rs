//! Generates the BSON signing key documents shared with built in auth.

use base64ct::{Base64UrlUnpadded, Encoding};
use bson::{DateTime, Document, doc};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, Ed25519KeyPair, KeyPair as _},
};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::{
    secrets::encrypt_signing_key,
    tokens::{Algorithm, TokenError},
};

#[derive(Serialize)]
struct Jwk<'a> {
    kty: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<String>,
    x: String,
    crv: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    d: Option<&'a str>,
}

/// Generates a signing key with a private JWK sealed using the Better Auth secret.
pub fn generate(
    algorithm: Algorithm,
    secret: &str,
    created_at: i64,
    expires_at: i64,
) -> Result<Document, TokenError> {
    let random = SystemRandom::new();
    let failed = |_| TokenError::SigningFailed;
    let (mut jwk, scalar) = match algorithm {
        Algorithm::EdDSA => {
            let mut seed = Zeroizing::new([0; 32]);
            random.fill(seed.as_mut()).map_err(failed)?;
            let key =
                Ed25519KeyPair::from_seed_unchecked(seed.as_ref()).map_err(|_| TokenError::SigningFailed)?;
            (
                Jwk {
                    kty: "OKP",
                    crv: "Ed25519",
                    x: Base64UrlUnpadded::encode_string(key.public_key().as_ref()),
                    y: None,
                    d: None,
                },
                Zeroizing::new(Base64UrlUnpadded::encode_string(seed.as_ref())),
            )
        }
        Algorithm::ES256 => {
            let der =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &random).map_err(failed)?;
            let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der.as_ref(), &random)
                .map_err(|_| TokenError::SigningFailed)?;
            let point = key.public_key().as_ref();
            let invalid = TokenError::SigningFailed;
            let x = point.get(1..33).ok_or(TokenError::SigningFailed)?;
            let y = point.get(33..65).ok_or(TokenError::SigningFailed)?;
            let scalar = der
                .as_ref()
                .get(34..68)
                .and_then(|field| field.strip_prefix(&[0x04, 0x20]))
                .ok_or(invalid)?;
            (
                Jwk {
                    kty: "EC",
                    crv: "P-256",
                    x: Base64UrlUnpadded::encode_string(x),
                    y: Some(Base64UrlUnpadded::encode_string(y)),
                    d: None,
                },
                Zeroizing::new(Base64UrlUnpadded::encode_string(scalar)),
            )
        }
    };
    let public = serde_json::to_string(&jwk).map_err(|_| TokenError::SigningFailed)?;
    jwk.d = Some(scalar.as_str());
    let private = Zeroizing::new(serde_json::to_string(&jwk).map_err(|_| TokenError::SigningFailed)?);
    let encrypted = encrypt_signing_key(secret, &private).ok_or(TokenError::SigningFailed)?;
    Ok(doc! {
        "_id": uuid::Uuid::new_v4().to_string(),
        "publicKey": public, "privateKey": encrypted, "alg": algorithm.name(), "crv": jwk.crv,
        "createdAt": DateTime::from_millis(created_at), "expiresAt": DateTime::from_millis(expires_at),
    })
}
