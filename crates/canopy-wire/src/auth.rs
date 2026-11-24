use std::num::NonZeroU32;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use canopy_auth::Authenticator;
use canopy_engine::Principal;
use canopy_mongo::mongodb::bson::{Binary, Document, doc, spec::BinarySubtype};
use canopy_protocol::ErrorCode;
use ring::{digest, hmac, pbkdf2, rand};
use subtle::{Choice, ConstantTimeEq as _};

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;

const ITERATIONS: NonZeroU32 = NonZeroU32::MIN.saturating_add(14_999);

#[derive(Clone, Copy)]
pub(crate) enum Failure {
    Invalid,
    Expired,
    NoConfiguredKeys,
}

pub(crate) enum Conversation {
    Scram(Scram),
    Finish,
}

pub(crate) struct Scram {
    first: String,
    challenge: String,
    channel_binding: &'static str,
    nonce: String,
    salt: Vec<u8>,
    iterations: NonZeroU32,
    skip_empty_exchange: bool,
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
        let message = std::str::from_utf8(payload).ok()?;
        let (first, channel_binding) = if let Some(first) = message.strip_prefix("n,,") {
            (first, "c=biws,r=")
        } else {
            (message.strip_prefix("y,,")?, "c=eSws,r=")
        };
        let (name, nonce) = first.strip_prefix("n=")?.split_once(",r=")?;
        if name != username || nonce.is_empty() || !nonce.bytes().all(|b| b.is_ascii_graphic() && b != b',') {
            return None;
        }
        let nonce = format!("{nonce}{server_nonce}");
        let challenge = format!("r={nonce},s={},i={iterations}", STANDARD.encode(&salt));
        Some(Self {
            first: first.to_owned(),
            challenge,
            channel_binding,
            nonce,
            salt,
            iterations,
            skip_empty_exchange,
        })
    }

    fn verify(&self, payload: &[u8], secrets: &[String]) -> Option<String> {
        let (final_message, proof) = std::str::from_utf8(payload).ok()?.split_once(",p=")?;
        if final_message.strip_prefix(self.channel_binding)? != self.nonce {
            return None;
        }
        let proof: [u8; 32] = STANDARD.decode(proof).ok()?.try_into().ok()?;
        let transcript = format!("{},{},{final_message}", self.first, self.challenge);
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
            let client_signature = sign(stored_key.as_ref(), transcript.as_bytes());
            let mut candidate = proof;
            for (byte, mask) in candidate.iter_mut().zip(client_signature.as_ref()) {
                *byte ^= mask;
            }
            let valid = client_key.as_ref().ct_eq(&candidate);
            matched |= valid;
            let server_key = sign(&salted, b"Server Key");
            let server_signature = sign(server_key.as_ref(), transcript.as_bytes());
            let mask = 0u8.wrapping_sub(valid.unwrap_u8());
            for (byte, value) in signature.iter_mut().zip(server_signature.as_ref()) {
                *byte = (*byte & !mask) | (value & mask);
            }
        }
        bool::from(matched).then(|| format!("v={}", STANDARD.encode(signature)))
    }
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
            let salt = rand::generate::<[u8; 16]>(&rng).map_err(|_| Failure::Invalid)?.expose();
            let scram =
                Scram::challenge(bytes, "service", &STANDARD.encode(nonce), salt.to_vec(), ITERATIONS, skip)
                    .ok_or(Failure::Invalid)?;
            if authenticator.configured_service_keys().is_empty() {
                return Err(Failure::NoConfiguredKeys);
            }
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
            let authenticator = authenticator.clone();
            let signature = tokio::task::spawn_blocking(move || {
                scram.verify(&bytes, authenticator.configured_service_keys())
            })
            .await
            .ok()
            .flatten()
            .ok_or(Failure::Invalid)?;
            Ok(Exchange {
                response: reply(id, signature.as_bytes(), done),
                principal: done.then(Principal::service),
                next: (!done).then_some(Conversation::Finish),
            })
        }
        Conversation::Finish if bytes.is_empty() => {
            Ok(Exchange { response: reply(id, &[], true), principal: Some(Principal::service()), next: None })
        }
        Conversation::Finish => Err(Failure::Invalid),
    }
}
