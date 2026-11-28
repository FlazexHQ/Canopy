use std::{net::IpAddr, time::Duration};

use bson::Bson;
use canopy_webhooks::Signer;
use serde_json_bytes::{ByteString, Map, Value, json};
use url::{Host, Url};

use super::documents::{User, id_text, iso};

/// The most a claims hook answer may hold, in bytes.
pub const MAX_CLAIMS_ANSWER_BYTES: usize = 4096;

const RESERVED_ROLES: [&str; 4] = ["anon", "authenticated", "service", "public"];

/// The HTTPS endpoint asked for extra claims each time an access token is minted.
///
/// Each call is a `POST` of `{"user": ..., "session": {"id": ...}}` signed with Standard Webhooks headers
/// (`webhook-id`, `webhook-timestamp`, `webhook-signature`). A 2xx answer holds a JSON object with
/// `app_metadata` (merged over the stored one) and `roles` (added to the stored ones); an empty answer or
/// `null` adds nothing. Any other answer, a redirect, an answer over [`MAX_CLAIMS_ANSWER_BYTES`] or a call
/// that outlasts the timeout fails closed: no token is issued.
pub struct ClaimsHook {
    /// HTTPS, or HTTP on a loopback address outside production.
    pub url: Url,
    /// The Standard Webhooks secret: `whsec_` followed by base64 key bytes, or the raw key text.
    pub secret: String,
    /// How long one call may take, connecting included.
    pub timeout: Duration,
}

impl ClaimsHook {
    /// A hook with the standard 200 ms deadline.
    pub fn new(url: Url, secret: String) -> Self {
        Self { url, secret, timeout: Duration::from_millis(200) }
    }
}

/// Whether a claims hook URL may be used: HTTPS, or HTTP on a loopback host outside production, with no
/// credentials or fragment.
pub fn claims_url_allowed(url: &Url, production: bool) -> bool {
    let loopback = match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => return false,
    };
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https" || (url.scheme() == "http" && loopback && !production))
}

#[derive(Default)]
pub(super) struct Contributed {
    pub roles: Vec<String>,
    pub app_metadata: Map<ByteString, Value>,
}

pub(super) struct Hook {
    url: Url,
    signer: Signer,
    client: reqwest::Client,
    timeout: Duration,
}

impl Hook {
    pub(super) fn open(settings: ClaimsHook, production: bool) -> Result<Self, String> {
        if !claims_url_allowed(&settings.url, production) {
            return Err(
                "The claims hook URL must use HTTPS (HTTP only on a loopback address outside production)"
                    .into(),
            );
        }
        if settings.timeout.is_zero() {
            return Err("The claims hook timeout must be positive".into());
        }
        let signer = Signer::new(&settings.secret)
            .map_err(|error| format!("Invalid claims hook secret: {}", error.message()))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(settings.timeout)
            .build()
            .map_err(|error| format!("Could not create the claims hook client: {error}"))?;
        Ok(Self { url: settings.url, signer, client, timeout: settings.timeout })
    }

    /// Asks the hook for the claims of a token minted for `user` in `session_id`; the error is the reason.
    pub(super) async fn call(
        &self,
        user: &User,
        session_id: &str,
        now_ms: i64,
    ) -> Result<Contributed, String> {
        let body = serde_json::to_string(&json!({"user": hook_user(user), "session": {"id": session_id}}))
            .map_err(|_| "the request could not be encoded".to_owned())?;
        let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let timestamp = now_ms.div_euclid(1000);
        let signature = self.signer.sign(&id, timestamp, &body);
        let timed_out = || format!("timed out after {} ms", self.timeout.as_millis());
        let exchange = async {
            let mut response = self
                .client
                .post(self.url.clone())
                .header("content-type", "application/json")
                .header("user-agent", "canopy-auth")
                .header("webhook-id", &id)
                .header("webhook-timestamp", timestamp.to_string())
                .header("webhook-signature", signature)
                .body(body)
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        timed_out()
                    } else {
                        format!("the request failed: {:?}", error.without_url())
                    }
                })?;
            if !response.status().is_success() {
                return Err(format!("the hook answered {}", response.status().as_u16()));
            }
            let too_large = || format!("the answer is over {MAX_CLAIMS_ANSWER_BYTES} bytes");
            if response.content_length().is_some_and(|length| length > MAX_CLAIMS_ANSWER_BYTES as u64) {
                return Err(too_large());
            }
            let mut answer = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                if error.is_timeout() {
                    timed_out()
                } else {
                    format!("the answer could not be read: {:?}", error.without_url())
                }
            })? {
                if answer.len().saturating_add(chunk.len()) > MAX_CLAIMS_ANSWER_BYTES {
                    return Err(too_large());
                }
                answer.extend_from_slice(&chunk);
            }
            Ok(answer)
        };
        let answer = tokio::time::timeout(self.timeout, exchange).await.map_err(|_| timed_out())??;
        if answer.iter().all(u8::is_ascii_whitespace) {
            return Ok(Contributed::default());
        }
        let value =
            serde_json::from_slice::<Value>(&answer).map_err(|_| "the answer is not JSON".to_owned())?;
        check_result(value)
    }
}

fn hook_user(user: &User) -> Value {
    let anonymous = user.extra.get_bool("isAnonymous").unwrap_or(false);
    let mut output = Map::new();
    output.insert("id", json!(id_text(&user.id)));
    if !anonymous {
        output.insert("email", json!(user.email));
    }
    output.insert("emailVerified", json!(user.email_verified));
    if !user.name.is_empty() {
        output.insert("name", json!(user.name));
    }
    output.insert("isAnonymous", json!(anonymous));
    let roles: Vec<&str> =
        user.extra.get_array("roles").into_iter().flatten().filter_map(Bson::as_str).collect();
    output.insert("roles", json!(roles));
    output.insert("appMetadata", Value::Object(user.metadata("appMetadata")));
    output.insert("userMetadata", Value::Object(user.metadata("userMetadata")));
    output.insert("banned", json!(user.extra.get_bool("banned").unwrap_or(false)));
    if let Ok(reason) = user.extra.get_str("banReason") {
        output.insert("banReason", json!(reason));
    }
    if let Ok(until) = user.extra.get_datetime("banExpires") {
        output.insert("banExpires", json!(iso(*until)));
    }
    output.insert("createdAt", json!(iso(user.created_at)));
    output.insert("updatedAt", json!(iso(user.updated_at)));
    Value::Object(output)
}

fn check_result(value: Value) -> Result<Contributed, String> {
    let fields = match value {
        Value::Null => return Ok(Contributed::default()),
        Value::Object(fields) => fields,
        _ => return Err("the hook must return an object".into()),
    };
    let extra: Vec<&str> = fields
        .keys()
        .map(ByteString::as_str)
        .filter(|key| !matches!(*key, "app_metadata" | "roles"))
        .collect();
    if !extra.is_empty() {
        return Err(format!("the hook may only return app_metadata and roles, not {}", extra.join(", ")));
    }
    let mut contributed = Contributed::default();
    match fields.get("app_metadata") {
        None => {}
        Some(Value::Object(metadata)) => contributed.app_metadata = metadata.clone(),
        Some(_) => return Err("app_metadata must be an object".into()),
    }
    match fields.get("roles") {
        None => {}
        Some(Value::Array(roles)) => {
            for role in roles {
                match role.as_str() {
                    Some(role) if !role.is_empty() && !RESERVED_ROLES.contains(&role) => {
                        contributed.roles.push(role.to_owned());
                    }
                    _ => return Err(reserved_roles()),
                }
            }
        }
        Some(_) => return Err(reserved_roles()),
    }
    Ok(contributed)
}

fn reserved_roles() -> String {
    "roles must be a list of names other than anon, authenticated, service and public".into()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    fn parse(text: &str) -> Result<Contributed, String> {
        check_result(serde_json::from_str(text).expect("JSON fixture"))
    }

    #[test]
    fn accepts_app_metadata_and_roles() {
        let contributed =
            parse(r#"{"app_metadata":{"plan":"pro","seats":3},"roles":["editor"]}"#).expect("valid");
        assert_eq!(contributed.roles, ["editor"]);
        assert_eq!(Value::Object(contributed.app_metadata), json!({"plan": "pro", "seats": 3}));
        let empty = parse("null").expect("null adds nothing");
        assert!(empty.roles.is_empty() && empty.app_metadata.is_empty());
        assert!(parse("{}").expect("empty object").roles.is_empty());
    }

    #[test]
    fn refuses_what_the_typescript_hook_refused() {
        for (answer, reason) in [
            ("[]", "the hook must return an object"),
            ("\"claims\"", "the hook must return an object"),
            (
                r#"{"sub":"other","role":"service"}"#,
                "the hook may only return app_metadata and roles, not sub, role",
            ),
            (r#"{"app_metadata":null}"#, "app_metadata must be an object"),
            (r#"{"app_metadata":[1]}"#, "app_metadata must be an object"),
            (r#"{"roles":"editor"}"#, "roles must be a list"),
            (r#"{"roles":[""]}"#, "roles must be a list"),
            (r#"{"roles":[1]}"#, "roles must be a list"),
        ] {
            let error = parse(answer).err().expect(answer);
            assert!(error.starts_with(reason), "{answer}: {error}");
        }
        for role in RESERVED_ROLES {
            assert!(parse(&format!(r#"{{"roles":["editor","{role}"]}}"#)).is_err(), "{role}");
        }
    }

    #[test]
    fn allows_https_and_loopback_http_outside_production() {
        let allowed = |url: &str, production| claims_url_allowed(&Url::parse(url).expect("URL"), production);
        assert!(allowed("https://hooks.example.test/claims", true));
        assert!(allowed("http://127.0.0.1:9000/claims", false));
        assert!(allowed("http://localhost:9000/claims", false));
        assert!(allowed("http://[::1]:9000/claims", false));
        assert!(!allowed("http://127.0.0.1:9000/claims", true));
        assert!(!allowed("http://hooks.example.test/claims", false));
        assert!(!allowed("http://10.0.0.1/claims", false));
        assert!(!allowed("ftp://hooks.example.test/claims", false));
        assert!(!allowed("https://user:pass@hooks.example.test/claims", false)); // trufflehog:ignore
    }
}
