//! Password compatibility with the TypeScript implementation and its exported documents.

mod support;

use std::collections::{HashMap, HashSet};

use canopy_authn::passwords::{VerifiedPassword, hash_password, verify_password};
use proptest::prelude::*;
use serde::Deserialize;
use serde_json::json;
use support::typescript;

#[derive(Deserialize)]
struct Manifest {
    passwords: Vec<PasswordFixture>,
}

#[derive(Deserialize)]
struct PasswordFixture {
    email: String,
    password: String,
    hash: String,
}

#[derive(Deserialize, PartialEq, Eq, Hash)]
struct ObjectId {
    #[serde(rename = "$oid")]
    hex: String,
}

#[derive(Deserialize)]
struct User {
    #[serde(rename = "_id")]
    id: ObjectId,
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    user_id: ObjectId,
    provider_id: String,
    password: Option<String>,
}

#[test]
fn typescript_fixture_passwords() -> Result<(), serde_json::Error> {
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/manifest.json"))?;
    let users: Vec<User> =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/users.json"))?;
    let accounts: Vec<Account> =
        serde_json::from_str(include_str!("../../../conformance/auth/documents/accounts.json"))?;
    let users: HashMap<_, _> = users.into_iter().map(|user| (user.id, user.email)).collect();
    let mut passwords: HashMap<_, _> = accounts
        .iter()
        .filter(|account| account.provider_id == "credential")
        .filter_map(|account| Some((users.get(&account.user_id)?, account.password.as_deref()?)))
        .collect();
    assert!(!manifest.passwords.is_empty());
    let mut kinds = HashSet::new();
    for fixture in manifest.passwords {
        let stored = passwords.remove(&fixture.email);
        assert!(stored.is_some(), "missing password for {}", fixture.email);
        let Some(stored) = stored else { continue };
        assert_eq!(
            verify_password(&fixture.password, stored),
            Some(VerifiedPassword { needs_rehash: fixture.hash != "argon2id (native)" }),
            "{}",
            fixture.email
        );
        assert_eq!(verify_password("wrong password", stored), None, "{}", fixture.email);
        kinds.insert(fixture.hash);
    }
    assert!(passwords.is_empty(), "credentials missing from manifest");
    assert_eq!(kinds.len(), 8);
    Ok(())
}

#[test]
fn argon2id_interoperates_in_both_directions() -> Result<(), Box<dyn std::error::Error>> {
    for (password, equivalent) in [("ﬁancée ①", "fiance\u{301}e 1"), ("", "")] {
        let rust = hash_password(password)?;
        assert!(rust.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert_ne!(rust, hash_password(password)?);
        typescript("verify", &json!({"password": equivalent, "hash": rust}))?;
        let ts = typescript("hash", &json!({"password": password}))?;
        assert_eq!(
            verify_password(equivalent, std::str::from_utf8(&ts.stdout)?),
            Some(VerifiedPassword { needs_rehash: false })
        );
    }
    Ok(())
}

#[test]
fn imported_bcrypt_2x_preserves_the_signed_byte_variant() -> Result<(), Box<dyn std::error::Error>> {
    let password = "é".repeat(36);
    // libxcrypt produced this vector with a zero salt and cost 4.
    let stored = "canopy-legacy$bcrypt$$2x$04$......................t9KxgN56XvfLYrSBBHg0jUZMRMhwFKi";
    typescript("verify", &json!({"password": password, "hash": stored}))?;
    assert_eq!(verify_password(&password, stored), Some(VerifiedPassword { needs_rehash: true }));
    assert_eq!(verify_password(&password, &stored.replace("$2x$", "$2b$")), None);
    assert_eq!(verify_password(&"é".repeat(37), stored), None);
    Ok(())
}

#[test]
fn native_rehash_requires_a_strictly_weaker_single_lane_hash() -> Result<(), argon2::Error> {
    use argon2::{Algorithm, Argon2, Params, Version};
    use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};

    let salt = [12; 16];
    for (memory, passes, lanes, needs_rehash) in [
        (8, 1, 1, true),
        (19_456, 1, 1, true),
        (19_456, 2, 1, false),
        (19_456, 3, 1, false),
        (19_457, 1, 1, false),
        (32, 1, 4, false),
    ] {
        let params = Params::new(memory, passes, lanes, Some(32))?;
        let mut tag = [0; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(
            b"password",
            &salt,
            &mut tag,
        )?;
        let stored = format!(
            "$argon2id$v=19$m={memory},t={passes},p={lanes}${}${}",
            STANDARD_NO_PAD.encode(salt),
            STANDARD_NO_PAD.encode(tag)
        );
        assert_eq!(verify_password("password", &stored), Some(VerifiedPassword { needs_rehash }));
    }
    Ok(())
}

#[test]
fn matching_argon2_tags_cannot_bypass_work_limits() -> Result<(), argon2::Error> {
    use argon2::{Algorithm, Argon2, Params, Version};
    use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};

    let salt = [12; 16];
    for (memory, passes, lanes, imported_matches) in
        [(8, 9, 1, true), (40, 1, 5, true), (8, 33, 1, false), (136, 1, 17, false)]
    {
        let params = Params::new(memory, passes, lanes, Some(32))?;
        let mut tag = [0; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password_into(
            b"password",
            &salt,
            &mut tag,
        )?;
        let stored = format!(
            "$argon2id$v=19$m={memory},t={passes},p={lanes}${}${}",
            STANDARD_NO_PAD.encode(salt),
            STANDARD_NO_PAD.encode(tag)
        );
        assert_eq!(verify_password("password", &stored), None);
        assert_eq!(
            verify_password("password", &format!("canopy-legacy$argon2id${stored}")),
            imported_matches.then_some(VerifiedPassword { needs_rehash: true })
        );
    }
    Ok(())
}

#[test]
fn out_of_bounds_work_factors_and_empty_legacy_tags_are_refused() {
    for parameters in ["m=262145,t=2,p=1", "m=32,t=9,p=1", "m=40,t=2,p=5", "m=15,t=2,p=2", "m=32,t=0,p=1"] {
        let stored = format!(
            "$argon2id$v=19${parameters}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert_eq!(verify_password("password", &stored), None, "{stored}");
    }
    for parameters in ["m=262145,t=1,p=1", "m=8,t=33,p=1", "m=136,t=1,p=17", "m=7,t=1,p=1", "m=64,t=0,p=1"] {
        let stored = format!("canopy-legacy$argon2id$$argon2id$v=19${parameters}$AAAAAAAAAAA$AAAAAA");
        assert_eq!(verify_password("password", &stored), None, "{stored}");
    }
    for stored in [
        "canopy-legacy$bcrypt$$2b$17$.....................................................",
        "canopy-legacy$bcrypt$$2b$03$.....................................................",
        "canopy-legacy$pbkdf2-sha1$10000001$YQ==$YQ==",
        "canopy-legacy$pbkdf2-sha256$0$YQ==$YQ==",
        "canopy-legacy$pbkdf2-sha512$1$YQ==$",
        "canopy-legacy$firebase-scrypt$YQ==$YQ==$17$1$YQ==$YQ==",
        "canopy-legacy$firebase-scrypt$YQ==$YQ==$1$17$YQ==$YQ==",
        "canopy-legacy$firebase-scrypt$$$1$1$$",
    ] {
        assert_eq!(verify_password("password", stored), None, "{stored}");
    }
}

proptest! {
    #[test]
    fn malformed_hashes_are_refused_without_panicking(
        prefix in prop::sample::select(vec![
            "", "$argon2id$", "$argon2id$v=19$", "canopy-legacy$", "canopy-legacy$bcrypt$",
            "canopy-legacy$pbkdf2-sha1$", "canopy-legacy$pbkdf2-sha256$", "canopy-legacy$pbkdf2-sha512$",
            "canopy-legacy$firebase-scrypt$", "canopy-legacy$argon2id$$argon2id$v=19$"
        ]),
        body in "[$:a-zA-Z0-9./=+,]{0,150}",
        tail in "\\PC{0,16}",
        password in "\\PC{0,80}",
    ) {
        let malformed = format!("{prefix}{body}💥{tail}");
        prop_assert_eq!(verify_password(&password, &malformed), None);
        prop_assert_eq!(verify_password(&password, &tail), None);
    }
}
