//! Studio view tokens: short lived, read only EdDSA tokens with which Studio follows data as an impersonated
//! caller. The server signs them with a key derived from its master key and gives the gateway the public key.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_engine::Principal;
use canopy_policy::Role;
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, ErrorCode, Value};
use ring::signature;

use crate::jwt::plain;

/// The issuer of view tokens.
pub(crate) const VIEW_TOKEN_ISSUER: &str = "urn:canopy:studio";
const VIEW_TOKEN_AUDIENCE: &str = "urn:canopy:view-as";
const VIEW_TOKEN_CLAIM: &str = "canopy_view";

fn invalid() -> CanopyError {
    CanopyError::new(ErrorCode::Unauthorized, "Invalid view token")
}

fn decode(part: &str) -> Option<Json> {
    let bytes = URL_SAFE_NO_PAD.decode(part).ok()?;
    parse_json(&String::from_utf8(bytes).ok()?).ok()
}

/// The `iss` of a token, read without verifying it, to route view tokens to their own check.
pub(crate) fn issuer_of(token: &str) -> Option<String> {
    let payload = decode(token.split('.').nth(1)?)?;
    match payload.get("iss") {
        Some(Json::String(iss)) => Some(iss.clone()),
        _ => None,
    }
}

/// Verifies a view token like the TypeScript authenticator: EdDSA by the view key, the view issuer and audience,
/// an expiry, and a `canopy_view` claim naming roles and the claims of the caller, or `null` for a role
/// without a signed in user. The principal is read only.
pub(crate) fn verify_view_token(key: &[u8], token: &str, now_s: f64) -> Result<Principal, CanopyError> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signed), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid());
    };
    let header_json = decode(header).ok_or_else(invalid)?;
    let payload_json = decode(payload).ok_or_else(invalid)?;
    if !matches!(header_json.get("alg"), Some(Json::String(alg)) if alg == "EdDSA") {
        return Err(invalid());
    }
    let signature_bytes = URL_SAFE_NO_PAD.decode(signed).map_err(|_| invalid())?;
    let message = format!("{header}.{payload}");
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(message.as_bytes(), &signature_bytes)
        .map_err(|_| invalid())?;
    if !matches!(payload_json.get("iss"), Some(Json::String(iss)) if iss == VIEW_TOKEN_ISSUER) {
        return Err(invalid());
    }
    let audience = match payload_json.get("aud") {
        Some(Json::String(aud)) => aud == VIEW_TOKEN_AUDIENCE,
        Some(Json::Array(items)) => {
            items.iter().any(|item| matches!(item, Json::String(aud) if aud == VIEW_TOKEN_AUDIENCE))
        }
        _ => false,
    };
    if !audience {
        return Err(invalid());
    }
    let exp = match payload_json.get("exp") {
        Some(Json::Number(exp)) => *exp,
        _ => return Err(invalid()),
    };
    if now_s >= exp {
        return Err(CanopyError::new(ErrorCode::TokenExpired, "The view token has expired"));
    }
    if let Some(Json::Number(nbf)) = payload_json.get("nbf")
        && now_s < *nbf
    {
        return Err(invalid());
    }
    let Some(view @ Json::Object(_)) = payload_json.get(VIEW_TOKEN_CLAIM) else { return Err(invalid()) };
    let Some(Json::Array(listed)) = view.get("roles") else { return Err(invalid()) };
    let claims = match view.get("claims") {
        None | Some(Json::Null) => None,
        Some(object @ Json::Object(_)) => match plain(object) {
            Value::Document(claims) => Some(claims),
            _ => return Err(invalid()),
        },
        Some(_) => return Err(invalid()),
    };
    let mut roles: Vec<String> = Vec::new();
    for role in listed {
        let Json::String(role) = role else { return Err(invalid()) };
        if role == Role::PUBLIC {
            return Err(invalid());
        }
        if !roles.contains(role) {
            roles.push(role.clone());
        }
    }
    if claims.is_some() && !roles.iter().any(|role| role == Role::AUTHENTICATED) {
        roles.push(Role::AUTHENTICATED.to_owned());
    }
    let alone = |name: &str| !roles.iter().any(|role| role == name) || roles.len() == 1;
    if roles.is_empty() || !alone(Role::ANON) || !alone(Role::SERVICE) {
        return Err(invalid());
    }
    let subject = match claims.as_ref().and_then(|claims| claims.get("sub")) {
        Some(Value::String(sub)) => sub.clone(),
        _ => roles.join(","),
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let expires_at_ms = Some((exp * 1000.0).max(0.0) as u64);
    Ok(Principal {
        subject,
        roles: roles.iter().map(String::as_str).collect(),
        claims,
        expires_at_ms,
        key_id: None,
        read_only: true,
    })
}

#[cfg(test)]
mod tests {
    use ring::signature::{Ed25519KeyPair, KeyPair};

    use super::*;

    fn pair() -> Ed25519KeyPair {
        match Ed25519KeyPair::from_seed_unchecked(&[9u8; 32]) {
            Ok(pair) => pair,
            Err(error) => unreachable!("a 32 byte seed is valid: {error:?}"),
        }
    }

    fn sign(pair: &Ed25519KeyPair, header: &str, payload: &str) -> String {
        let input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header), URL_SAFE_NO_PAD.encode(payload));
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(pair.sign(input.as_bytes()).as_ref()))
    }

    fn view(pair: &Ed25519KeyPair, view: &str, exp: f64) -> String {
        sign(
            pair,
            r#"{"alg":"EdDSA","typ":"JWT"}"#,
            &format!(
                r#"{{"canopy_view":{view},"iss":"urn:canopy:studio","aud":"urn:canopy:view-as","iat":1,"exp":{exp}}}"#
            ),
        )
    }

    const NOW: f64 = 1_000_000.0;

    #[test]
    fn a_view_token_gives_a_read_only_principal_of_the_named_caller() {
        let pair = pair();
        let key = pair.public_key().as_ref().to_vec();
        let token = view(&pair, r#"{"roles":["editor"],"claims":{"sub":"u1","org":"o1"}}"#, NOW + 60.0);
        assert_eq!(issuer_of(&token).as_deref(), Some(VIEW_TOKEN_ISSUER));
        let Ok(principal) = verify_view_token(&key, &token, NOW) else { unreachable!("a valid view token") };
        assert!(principal.read_only);
        assert_eq!(principal.subject, "u1");
        assert!(principal.roles.contains("editor") && principal.roles.contains(Role::AUTHENTICATED));
        assert_eq!(principal.roles.len(), 2);
        assert_eq!(principal.expires_at_ms, Some(1_000_060_000));
        let role_only = view(&pair, r#"{"roles":["anon"],"claims":null}"#, NOW + 60.0);
        let Ok(anon) = verify_view_token(&key, &role_only, NOW) else { unreachable!("a valid view token") };
        assert_eq!(anon.subject, "anon");
        assert_eq!(anon.claims, None);
    }

    #[test]
    fn refuses_view_tokens_that_fail_any_check() {
        let pair = pair();
        let key = pair.public_key().as_ref().to_vec();
        let other = match Ed25519KeyPair::from_seed_unchecked(&[3u8; 32]) {
            Ok(other) => other,
            Err(error) => unreachable!("{error:?}"),
        };
        let cases = [
            view(&other, r#"{"roles":["editor"],"claims":null}"#, NOW + 60.0),
            view(&pair, r#"{"roles":["public"],"claims":null}"#, NOW + 60.0),
            view(&pair, r#"{"roles":["anon","editor"],"claims":null}"#, NOW + 60.0),
            view(&pair, r#"{"roles":["service"],"claims":{"sub":"u1"}}"#, NOW + 60.0),
            view(&pair, r#"{"roles":[],"claims":null}"#, NOW + 60.0),
            view(&pair, r#"{"roles":[1],"claims":null}"#, NOW + 60.0),
            view(&pair, r#"{"roles":["editor"],"claims":"u1"}"#, NOW + 60.0),
            view(&pair, r#"{"claims":null}"#, NOW + 60.0),
            sign(
                &pair,
                r#"{"alg":"EdDSA"}"#,
                r#"{"canopy_view":{"roles":["a"],"claims":null},"iss":"urn:canopy:studio","aud":"urn:canopy:view-as"}"#,
            ),
            sign(
                &pair,
                r#"{"alg":"EdDSA"}"#,
                &format!(
                    r#"{{"canopy_view":{{"roles":["a"],"claims":null}},"iss":"x","aud":"urn:canopy:view-as","exp":{}}}"#,
                    NOW + 60.0
                ),
            ),
            sign(
                &pair,
                r#"{"alg":"EdDSA"}"#,
                &format!(
                    r#"{{"canopy_view":{{"roles":["a"],"claims":null}},"iss":"urn:canopy:studio","aud":"x","exp":{}}}"#,
                    NOW + 60.0
                ),
            ),
            sign(
                &pair,
                r#"{"alg":"HS256"}"#,
                &format!(
                    r#"{{"canopy_view":{{"roles":["a"],"claims":null}},"iss":"urn:canopy:studio","aud":"urn:canopy:view-as","exp":{}}}"#,
                    NOW + 60.0
                ),
            ),
        ];
        for token in cases {
            let refused = verify_view_token(&key, &token, NOW);
            assert!(
                matches!(&refused, Err(error) if error.code() == ErrorCode::Unauthorized && error.message() == "Invalid view token"),
                "{token}: {refused:?}"
            );
        }
        let expired = verify_view_token(&key, &view(&pair, r#"{"roles":["a"],"claims":null}"#, NOW), NOW);
        assert!(matches!(expired, Err(error) if error.code() == ErrorCode::TokenExpired));
    }
}
