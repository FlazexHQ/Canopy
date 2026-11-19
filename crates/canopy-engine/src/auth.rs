use canopy_policy::{RequestContext, Role, Roles};
use canopy_protocol::Document;

/// Who a connection acts as, as the transport verified it.
#[derive(Debug, Clone, PartialEq)]
pub struct Principal {
    /// `sub`, or `anon` or `service`.
    pub subject: String,
    /// The roles: exactly one base role plus custom roles, or `service` alone.
    pub roles: Roles,
    /// The verified token payload, `None` for `anon` and API keys.
    pub claims: Option<Document>,
    /// When the token expires, in milliseconds since the epoch.
    pub expires_at_ms: Option<u64>,
    /// The id of a stored API key.
    pub key_id: Option<String>,
    /// Whether the principal may not write (a view token).
    pub read_only: bool,
}

impl Principal {
    /// The anonymous caller of a publishable key.
    pub fn anon() -> Principal {
        Principal {
            subject: "anon".to_owned(),
            roles: [Role::ANON].into_iter().collect(),
            claims: None,
            expires_at_ms: None,
            key_id: None,
            read_only: false,
        }
    }

    /// The `service` caller of a secret key.
    pub fn service() -> Principal {
        Principal {
            subject: "service".to_owned(),
            roles: [Role::SERVICE].into_iter().collect(),
            claims: None,
            expires_at_ms: None,
            key_id: None,
            read_only: false,
        }
    }

    /// The request context at `now_ms`, with the session's resolved context lookups.
    pub fn context(&self, ctx: Option<Document>, now_ms: u64) -> RequestContext {
        RequestContext {
            roles: self.roles.clone(),
            claims: self.claims.clone(),
            ctx,
            now: i64::try_from(now_ms).unwrap_or(i64::MAX),
        }
    }

    /// A key that differs whenever the roles or claims differ, to tell whether a new token changes access.
    pub fn context_key(&self) -> String {
        let mut roles: Vec<&str> = self.roles.iter().collect();
        roles.sort_unstable();
        let claims = self
            .claims
            .as_ref()
            .and_then(|claims| {
                canopy_protocol::ejson::canonical_string(&canopy_protocol::Value::Document(claims.clone()))
                    .ok()
            })
            .unwrap_or_default();
        format!("{}|{claims}", roles.join(","))
    }
}
