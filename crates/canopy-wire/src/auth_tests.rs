#![allow(clippy::unwrap_used)]

use super::*;

const FIRST: &[u8] = b"n,,n=user,r=rOprNGfwEbeRWgbNEkqO";
const SUFFIX: &str = "%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
const FINAL: &str = concat!(
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,",
    "p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
);

fn challenge(first: &[u8], suffix: &str) -> Option<Scram> {
    Scram::challenge(
        first,
        "user",
        suffix,
        STANDARD.decode("W22ZaJ0SNY7soEsUEjb6gQ==").unwrap(),
        NonZeroU32::new(4096).unwrap(),
        false,
    )
}

#[test]
fn rfc_7677_exchange() {
    let scram = challenge(FIRST, SUFFIX).unwrap();
    assert_eq!(
        scram.challenge,
        "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
    );
    assert_eq!(
        scram.verify(FINAL.as_bytes(), &["other".into(), "pencil".into()]).as_deref(),
        Some("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
    );
}

#[test]
fn rejects_wrong_proof() {
    let scram = challenge(FIRST, SUFFIX).unwrap();
    let wrong = FINAL.replace("p=dH", "p=AH");
    assert!(scram.verify(wrong.as_bytes(), &["pencil".into()]).is_none());
}

#[test]
fn rejects_replay_with_fresh_nonce() {
    let scram = challenge(FIRST, "anotherNonce").unwrap();
    assert!(scram.verify(FINAL.as_bytes(), &["pencil".into()]).is_none());
}

#[test]
fn rejects_wrong_user() {
    assert!(challenge(b"n,,n=other,r=rOprNGfwEbeRWgbNEkqO", SUFFIX).is_none());
}

#[tokio::test]
async fn authenticates_after_the_empty_final_exchange() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let authenticator =
        Authenticator::new(None, None, vec!["pencil".into()], reqwest::Client::new()).unwrap();
    let id = 7;
    let sasl = |bytes: &[u8]| {
        doc! {
            "saslContinue": 1,
            "conversationId": id,
            "payload": Binary { bytes: bytes.to_vec(), subtype: BinarySubtype::Generic },
        }
    };
    let first = continue_exchange(
        &authenticator,
        id,
        Conversation::Scram(challenge(FIRST, SUFFIX).unwrap()),
        &sasl(FINAL.as_bytes()),
    )
    .await
    .ok()
    .unwrap();
    assert!(!first.response.get_bool("done").unwrap());
    assert!(first.principal.is_none());
    let final_reply =
        continue_exchange(&authenticator, id, first.next.unwrap(), &sasl(&[])).await.ok().unwrap();
    assert!(final_reply.response.get_bool("done").unwrap());
    assert!(final_reply.response.get_binary_generic("payload").unwrap().is_empty());
    assert_eq!(final_reply.principal.unwrap().subject, "service");
    assert!(final_reply.next.is_none());
}
