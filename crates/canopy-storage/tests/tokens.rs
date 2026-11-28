//! Signed URL tokens agree with the TypeScript `UrlSigner`: the tokens below were signed by it with the master
//! key `test master key`.

use canopy_storage::tokens::{SignedGrant, UrlSigner};

fn grant(bucket: &str, path: &str, expires_at: f64) -> SignedGrant {
    SignedGrant { bucket: bucket.to_owned(), path: path.to_owned(), expires_at }
}

const SIGNED: [(&str, &str, f64, &str); 3] = [
    (
        "avatars",
        "u/1.png",
        1_900_000_000_000.0,
        "eyJiIjoiYXZhdGFycyIsInAiOiJ1LzEucG5nIiwiZSI6MTkwMDAwMDAwMDAwMH0.XKju0niV2fXUXaMSXcv_NZ83psN5Ek2ugpPPaclXzes",
    ),
    (
        "docs",
        "é/\"quoted\"/ü.pdf",
        1_800_000_000_123.0,
        "eyJiIjoiZG9jcyIsInAiOiLDqS9cInF1b3RlZFwiL8O8LnBkZiIsImUiOjE4MDAwMDAwMDAxMjN9.d1W6T2njSelU3jyMELZ4DDdKKO14h4PEiLytoVJcDWY",
    ),
    ("b", "x", 1.5, "eyJiIjoiYiIsInAiOiJ4IiwiZSI6MS41fQ.sub2kG0znVsojzBLYtr-APv3A0OHrp_3yC50PVYsgHM"),
];

#[test]
fn tokens_are_the_typescript_tokens() {
    let signer = UrlSigner::new(Some("test master key"));
    for (bucket, path, expires_at, token) in SIGNED {
        assert_eq!(signer.sign(&grant(bucket, path, expires_at)), token, "{bucket}/{path}");
        assert_eq!(signer.verify(token, 0.0), Some(grant(bucket, path, expires_at)), "{bucket}/{path}");
    }
}

#[test]
fn a_token_expires_at_its_time() {
    let signer = UrlSigner::new(Some("test master key"));
    let (_, _, expires_at, token) = SIGNED[0];
    assert!(signer.verify(token, expires_at - 1.0).is_some());
    assert_eq!(signer.verify(token, expires_at), None);
    assert_eq!(signer.verify(token, expires_at + 1.0), None);
}

#[test]
fn another_key_and_altered_tokens_are_refused() {
    let (bucket, path, expires_at, token) = SIGNED[0];
    let other = UrlSigner::new(Some("other"));
    assert_eq!(
        other.sign(&grant(bucket, path, expires_at)),
        "eyJiIjoiYXZhdGFycyIsInAiOiJ1LzEucG5nIiwiZSI6MTkwMDAwMDAwMDAwMH0.mjp-RKZXATqTeGROWjKmjEfikuk1xrfxNc8JbCX33CA"
    );
    assert_eq!(other.verify(token, 0.0), None);
    let signer = UrlSigner::new(Some("test master key"));
    let (payload, mac) = token.split_once('.').unwrap_or_default();
    assert_eq!(signer.verify(&format!("{payload}.{mac}.x"), 0.0), None);
    assert_eq!(signer.verify(payload, 0.0), None);
    assert_eq!(signer.verify(&format!("{payload}.{}", &mac[1..]), 0.0), None);
    assert_eq!(signer.verify(&format!("{payload}.{mac}="), 0.0), None);
    let swapped = token.replace("YXZhdGFycy", "YXZhdGFyca");
    assert_ne!(swapped, token);
    assert_eq!(signer.verify(&swapped, 0.0), None);
}

#[test]
fn without_a_master_key_each_signer_has_its_own_key() {
    let (first, second) = (UrlSigner::new(None), UrlSigner::new(None));
    let token = first.sign(&grant("a", "b", 10.0));
    assert!(first.verify(&token, 0.0).is_some());
    assert_eq!(second.verify(&token, 0.0), None);
}
