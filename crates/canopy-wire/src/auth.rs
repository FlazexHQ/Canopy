use std::num::NonZeroU32;
use std::sync::OnceLock;

use base64ct::{Base64, Encoding as _};
use canopy_auth::{ApiKeys, Authenticator, ScramVerifier};
use canopy_engine::Principal;
use canopy_mongo::mongodb::bson::{Binary, Document, doc, spec::BinarySubtype};
use canopy_protocol::ErrorCode;
use ring::{digest, hmac, pbkdf2, rand};
use subtle::{Choice, ConstantTimeEq as _};

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;

const ITERATIONS: NonZeroU32 = NonZeroU32::MIN.saturating_add(ScramVerifier::ITERATIONS - 1);
static DECOY_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

#[derive(Clone, Copy)]
pub(crate) enum Failure {
    Invalid,
    Expired,
}

pub(crate) enum Conversation {
    Scram(Scram),
    Finish(Option<StoredScram>),
}

pub(crate) struct Scram {
    first: String,
    challenge: String,
    channel_binding: &'static str,
    nonce: String,
    salt: Vec<u8>,
    iterations: NonZeroU32,
    skip_empty_exchange: bool,
    stored: Option<StoredScram>,
}

pub(crate) struct StoredScram {
    username: String,
    verifier: ScramVerifier,
    active: bool,
}

impl StoredScram {
    async fn lookup(auth: &Authenticator, username: &str) -> Option<ScramVerifier> {
        auth.api_keys.as_ref()?.scram_verifier(username).await.ok().flatten()
    }

    async fn current(&self, auth: &Authenticator) -> bool {
        Self::lookup(auth, &self.username).await.is_some_and(|current| {
            bool::from(
                current.salt.ct_eq(&self.verifier.salt)
                    & current.stored_key.ct_eq(&self.verifier.stored_key)
                    & current.server_key.ct_eq(&self.verifier.server_key),
            )
        })
    }
}

fn decoy(username: &str, rng: &rand::SystemRandom) -> Option<ScramVerifier> {
    let key = DECOY_KEY.get_or_init(|| rand::generate::<[u8; 32]>(rng).ok().map(|key| key.expose()));
    let key = key.as_ref()?;
    let seed = sign(key, username.as_bytes());
    Some(ScramVerifier {
        salt: sign(seed.as_ref(), b"Salt").as_ref()[..16].try_into().ok()?,
        stored_key: sign(seed.as_ref(), b"Client Key").as_ref().try_into().ok()?,
        server_key: sign(seed.as_ref(), b"Server Key").as_ref().try_into().ok()?,
    })
}

fn first_message(payload: &[u8]) -> Option<(&str, &str, &str, &'static str)> {
    let message = std::str::from_utf8(payload).ok()?;
    let (first, channel_binding) = if let Some(first) = message.strip_prefix("n,,") {
        (first, "c=biws,r=")
    } else {
        (message.strip_prefix("y,,")?, "c=eSws,r=")
    };
    let (name, nonce) = first.strip_prefix("n=")?.split_once(",r=")?;
    if nonce.is_empty() || !nonce.bytes().all(|b| b.is_ascii_graphic() && b != b',') {
        return None;
    }
    Some((first, name, nonce, channel_binding))
}

impl Scram {
    fn challenge(
        payload: &[u8],
        username: &str,
        server_nonce: &str,
        salt: Vec<u8>,
        iterations: NonZeroU32,
        skip_empty_exchange: bool,
    ) -> Option<Self> {
        let (first, name, nonce, channel_binding) = first_message(payload)?;
        if name != username {
            return None;
        }
        let nonce = format!("{nonce}{server_nonce}");
        let challenge = format!("r={nonce},s={},i={iterations}", Base64::encode_string(&salt));
        Some(Self {
            first: first.to_owned(),
            challenge,
            channel_binding,
            nonce,
            salt,
            iterations,
            skip_empty_exchange,
            stored: None,
        })
    }

    fn verify(&self, payload: &[u8], secrets: &[String]) -> Option<String> {
        let (final_message, proof) = std::str::from_utf8(payload).ok()?.split_once(",p=")?;
        if final_message.strip_prefix(self.channel_binding)? != self.nonce {
            return None;
        }
        let mut proof_buffer = [0; 32];
        let proof: [u8; 32] = Base64::decode(proof, &mut proof_buffer).ok()?.try_into().ok()?;
        let transcript = format!("{},{},{final_message}", self.first, self.challenge);
        if let Some(stored) = &self.stored {
            let (valid, signature) = verify_proof(
                &stored.verifier.stored_key,
                &stored.verifier.server_key,
                proof,
                transcript.as_bytes(),
            );
            return bool::from(valid & Choice::from(u8::from(stored.active)))
                .then(|| format!("v={}", Base64::encode_string(signature.as_ref())));
        }
        let mut matched = Choice::from(0);
        let mut signature = [0; 32];
        for password in secrets {
            let Ok(password) = stringprep::saslprep(password) else { continue };
            let mut salted = [0; 32];
            pbkdf2::derive(
                pbkdf2::PBKDF2_HMAC_SHA256,
                self.iterations,
                &self.salt,
                password.as_bytes(),
                &mut salted,
            );
            let client_key = sign(&salted, b"Client Key");
            let stored_key = digest::digest(&digest::SHA256, client_key.as_ref());
            let server_key = sign(&salted, b"Server Key");
            let (valid, server_signature) =
                verify_proof(stored_key.as_ref(), server_key.as_ref(), proof, transcript.as_bytes());
            matched |= valid;
            let mask = 0u8.wrapping_sub(valid.unwrap_u8());
            for (byte, value) in signature.iter_mut().zip(server_signature.as_ref()) {
                *byte = (*byte & !mask) | (value & mask);
            }
        }
        bool::from(matched).then(|| format!("v={}", Base64::encode_string(&signature)))
    }
}

fn verify_proof(
    stored_key: &[u8],
    server_key: &[u8],
    mut proof: [u8; 32],
    transcript: &[u8],
) -> (Choice, hmac::Tag) {
    let client_signature = sign(stored_key, transcript);
    for (byte, mask) in proof.iter_mut().zip(client_signature.as_ref()) {
        *byte ^= mask;
    }
    let candidate = digest::digest(&digest::SHA256, &proof);
    (candidate.as_ref().ct_eq(stored_key), sign(server_key, transcript))
}

fn sign(key: &[u8], message: &[u8]) -> hmac::Tag {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), message)
}

fn payload(command: &Document) -> Result<&[u8], Failure> {
    command.get_binary_generic("payload").map(Vec::as_slice).map_err(|_| Failure::Invalid)
}

fn reply(id: i32, bytes: &[u8], done: bool) -> Document {
    doc! {
        "conversationId": id,
        "payload": Binary { subtype: BinarySubtype::Generic, bytes: bytes.to_vec() },
        "done": done,
        "ok": 1.0,
    }
}

pub(crate) struct Exchange {
    pub(crate) response: Document,
    pub(crate) principal: Option<Principal>,
    pub(crate) next: Option<Conversation>,
}

pub(crate) async fn start(
    authenticator: &Authenticator,
    id: i32,
    command: &Document,
) -> Result<Exchange, Failure> {
    let bytes = payload(command)?;
    match command.get_str("mechanism") {
        Ok("MONGODB-OIDC") => {
            if command.get_str("$db").ok() != Some("$external") || bytes.len() > 1024 * 1024 {
                return Err(Failure::Invalid);
            }
            let mut remaining = bytes;
            let token = Document::from_reader(&mut remaining).map_err(|_| Failure::Invalid)?;
            if !remaining.is_empty() {
                return Err(Failure::Invalid);
            }
            let jwt = token.get_str("jwt").map_err(|_| Failure::Invalid)?;
            let principal = authenticator.authenticate_access_token(jwt).await.map_err(|error| {
                if error.code() == ErrorCode::TokenExpired { Failure::Expired } else { Failure::Invalid }
            })?;
            Ok(Exchange { response: reply(id, &[], true), principal: Some(principal), next: None })
        }
        Ok("SCRAM-SHA-256") => {
            if bytes.len() > 4096 {
                return Err(Failure::Invalid);
            }
            let skip = command
                .get_document("options")
                .and_then(|options| options.get_bool("skipEmptyExchange"))
                .unwrap_or(false);
            let rng = rand::SystemRandom::new();
            let nonce = rand::generate::<[u8; 24]>(&rng).map_err(|_| Failure::Invalid)?.expose();
            let (_, username, _, _) = first_message(bytes).ok_or(Failure::Invalid)?;
            let (salt, stored) =
                if username == "service" && !authenticator.configured_service_keys().is_empty() {
                    (rand::generate::<[u8; 16]>(&rng).map_err(|_| Failure::Invalid)?.expose(), None)
                } else {
                    let fallback = decoy(username, &rng).ok_or(Failure::Invalid)?;
                    let found = if ApiKeys::is_scram_username(username) {
                        StoredScram::lookup(authenticator, username).await
                    } else {
                        None
                    };
                    let active = found.is_some();
                    let verifier = found.unwrap_or(fallback);
                    (verifier.salt, Some(StoredScram { username: username.to_owned(), verifier, active }))
                };
            let mut scram = Scram::challenge(
                bytes,
                username,
                &Base64::encode_string(&nonce),
                salt.to_vec(),
                ITERATIONS,
                skip,
            )
            .ok_or(Failure::Invalid)?;
            scram.stored = stored;
            Ok(Exchange {
                response: reply(id, scram.challenge.as_bytes(), false),
                principal: None,
                next: Some(Conversation::Scram(scram)),
            })
        }
        _ => Err(Failure::Invalid),
    }
}

pub(crate) async fn continue_exchange(
    authenticator: &Authenticator,
    id: i32,
    conversation: Conversation,
    command: &Document,
) -> Result<Exchange, Failure> {
    let bytes = payload(command)?;
    if command.get_i32("conversationId").ok() != Some(id) || bytes.len() > 4096 {
        return Err(Failure::Invalid);
    }
    match conversation {
        Conversation::Scram(scram) => {
            let done = scram.skip_empty_exchange;
            let bytes = bytes.to_owned();
            let (signature, stored) = if let Some(stored) = &scram.stored {
                let signature = scram.verify(&bytes, &[]).ok_or(Failure::Invalid)?;
                if !stored.current(authenticator).await {
                    return Err(Failure::Invalid);
                }
                (signature, scram.stored)
            } else {
                let auth = authenticator.clone();
                let signature =
                    tokio::task::spawn_blocking(move || scram.verify(&bytes, auth.configured_service_keys()))
                        .await
                        .ok()
                        .flatten()
                        .ok_or(Failure::Invalid)?;
                (signature, None)
            };
            let (principal, next) =
                if done { (Some(service(stored)), None) } else { (None, Some(Conversation::Finish(stored))) };
            Ok(Exchange { response: reply(id, signature.as_bytes(), done), principal, next })
        }
        Conversation::Finish(stored) if bytes.is_empty() => {
            if let Some(stored) = &stored
                && !stored.current(authenticator).await
            {
                return Err(Failure::Invalid);
            }
            Ok(Exchange { response: reply(id, &[], true), principal: Some(service(stored)), next: None })
        }
        Conversation::Finish(_) => Err(Failure::Invalid),
    }
}

fn service(stored: Option<StoredScram>) -> Principal {
    Principal { key_id: stored.map(|stored| stored.username), ..Principal::service() }
}
