//! Admin access to the realtime engine and its read only view tokens.

use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use canopy_mongo::mongodb::{
    Database,
    bson::{Document as BsonDocument, doc},
};
use canopy_policy::Role;
use canopy_protocol::{
    CanopyError, Document, ErrorCode, Value,
    ejson::{iso_string, stringify},
};
use ring::{
    hkdf,
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};

use crate::schema::{Schema, optional, string};
use crate::{AdminRole, BoxFuture, Call, Clock, Delegate, Permission, Reply};

/// The inspection data requested by an authorized admin route.
pub enum InspectionQuery {
    /// Engine counters and lag history.
    Stats,
    /// Current sessions and subscriptions.
    Connections,
    /// Shared observers.
    Observers,
    /// Recent events.
    Events,
    /// A trace, with field policy masking for viewers.
    Trace {
        /// The event identifier.
        id: String,
        /// Whether DLS explanations over hidden fields must be masked.
        viewer: bool,
    },
    /// Ensures the engine can serve a tail.
    Tail,
}

/// Reads the engine on its owning thread.
pub trait Inspector: Send + Sync {
    /// Returns the requested inspection data. A missing trace is represented by `None`.
    fn read(&self, query: InspectionQuery) -> BoxFuture<'_, Result<Option<Value>, CanopyError>>;
}

struct SeedLength;
impl hkdf::KeyType for SeedLength {
    fn len(&self) -> usize {
        32
    }
}

/// Signs tokens the realtime authenticator accepts as read only.
pub struct ViewSigner(Ed25519KeyPair);

impl ViewSigner {
    /// Derives the cluster key from the master key or generates a key for this process.
    pub fn new(master_key: Option<&str>) -> Result<Self, CanopyError> {
        let failed = || CanopyError::new(ErrorCode::Internal, "Could not initialize view tokens");
        let mut seed = [0; 32];
        if let Some(key) = master_key.filter(|key| !key.is_empty()) {
            let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"canopy");
            let prk = salt.extract(key.as_bytes());
            let info = [b"canopy view tokens v1".as_slice()];
            prk.expand(&info, SeedLength).map_err(|_| failed())?.fill(&mut seed).map_err(|_| failed())?;
        } else {
            SystemRandom::new().fill(&mut seed).map_err(|_| failed())?;
        }
        Ed25519KeyPair::from_seed_unchecked(&seed).map(Self).map_err(|_| failed())
    }

    /// The raw Ed25519 verification key.
    pub fn public_key(&self) -> &[u8] {
        self.0.public_key().as_ref()
    }

    fn sign(&self, identity: Document, now: i64, expires: i64) -> Result<String, CanopyError> {
        let sub = match identity.get("claims") {
            Some(Value::Document(claims)) => claims.get("sub").and_then(Value::as_str).map(str::to_owned),
            _ => None,
        };
        let mut payload = Document::new();
        payload.insert("canopy_view", Value::Document(identity));
        payload.insert("iss", text("urn:canopy:studio"));
        payload.insert("aud", text("urn:canopy:view-as"));
        payload.insert("iat", Value::Double(now as f64));
        payload.insert("exp", Value::Double(expires as f64));
        if let Some(sub) = sub {
            payload.insert("sub", text(sub));
        }
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(stringify(&Value::Document(payload))?);
        let signed = format!("{header}.{payload}");
        Ok(format!("{signed}.{}", URL_SAFE_NO_PAD.encode(self.0.sign(signed.as_bytes()).as_ref())))
    }
}

fn text(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

fn invalid(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::ValidationFailed, message)
}

fn identity(as_input: Option<&Value>) -> Result<Document, CanopyError> {
    let mut roles = Vec::new();
    let mut claims = None;
    if let Some(Value::Document(input)) = as_input {
        roles.extend(input.get("role").and_then(Value::as_str));
        if let Some(Value::Array(values)) = input.get("roles") {
            for role in values.iter().filter_map(Value::as_str) {
                if !roles.contains(&role) {
                    roles.push(role);
                }
            }
        }
        if let Some(Value::Document(value)) = input.get("claims") {
            claims = Some(value.clone());
        }
        if let Some(user) = input.get("user").and_then(Value::as_str) {
            claims.get_or_insert_with(Document::new).insert("sub", text(user));
        }
        if claims.is_some() && !roles.contains(&Role::AUTHENTICATED) {
            roles.push(Role::AUTHENTICATED);
        }
        if roles.is_empty() {
            return Err(invalid("as needs a role, a user or claims"));
        }
        if roles.contains(&Role::SERVICE) {
            return Err(invalid("Impersonating service is not allowed; act as service directly"));
        }
        if roles.contains(&Role::ANON) && roles.len() > 1 {
            return Err(invalid("anon cannot be combined with other roles"));
        }
    } else {
        roles.push(Role::SERVICE);
    }
    let mut identity = Document::new();
    identity.insert("roles", Value::Array(roles.into_iter().map(text).collect()));
    identity.insert("claims", claims.map_or(Value::Null, Value::Document));
    Ok(identity)
}

/// The admin delegate for engine inspection and view token issuance.
pub struct RealtimeRoutes {
    inspector: Arc<dyn Inspector>,
    signer: Option<Arc<ViewSigner>>,
    publishable: Option<String>,
    meta: Database,
    clock: Clock,
}

impl RealtimeRoutes {
    /// Connects the inspector and optional signer to the admin API.
    pub fn new(
        inspector: Arc<dyn Inspector>,
        signer: Option<Arc<ViewSigner>>,
        publishable: Option<String>,
        meta: Database,
        clock: Clock,
    ) -> Self {
        Self { inspector, signer, publishable, meta, clock }
    }

    async fn token(&self, call: &Call) -> Result<Reply, CanopyError> {
        let signer = self
            .signer
            .as_ref()
            .ok_or_else(|| CanopyError::new(ErrorCode::NotFound, "View tokens are not available"))?;
        let empty = Value::Document(Document::new());
        let body = call.body.as_ref().filter(|value| **value != Value::Null).unwrap_or(&empty);
        let as_schema = Schema::Object(vec![
            ("role", optional(string(1, 200))),
            ("roles", optional(Schema::Array(Box::new(string(1, 200)), 32))),
            ("user", optional(string(1, 500))),
            ("claims", optional(Schema::Document)),
        ]);
        Schema::Object(vec![("as", optional(as_schema))]).check(Some(body), "body")?;
        let as_input = match body {
            Value::Document(body) => body.get("as"),
            _ => None,
        };
        if as_input.is_some() {
            call.require(Permission::DocumentsViewAs)?;
        } else if call.role == AdminRole::Viewer {
            return Err(CanopyError::new(
                ErrorCode::Forbidden,
                "Viewers follow live data only as another caller",
            ));
        }
        let identity = identity(as_input)?;
        let key = if let Some(key) = &self.publishable {
            key.clone()
        } else {
            self.meta.collection::<BsonDocument>("api_keys")
                .find_one(doc! { "kind": "publishable", "revokedAt": { "$exists": false }, "key": { "$type": "string" } })
                .sort(doc! { "createdAt": -1 })
                .await.map_err(|error| CanopyError::new(ErrorCode::Unavailable, error.to_string()))?
                .and_then(|key| key.get_str("key").ok().map(str::to_owned))
                .ok_or_else(|| CanopyError::new(ErrorCode::NotFound, "No publishable key: create one to follow data live"))?
        };
        let now = (self.clock)().div_euclid(1000);
        let expires = now + 300;
        let expires_at = iso_string(expires * 1000);
        let token = signer.sign(identity, now, expires)?;
        let mut response = Document::new();
        response.insert("token", text(token));
        response.insert("publishableKey", text(key));
        response.insert("expiresAt", text(&expires_at));
        let audit_as = match as_input {
            Some(Value::Document(input)) => canopy_mongo::to_bson(input)?,
            _ => doc! { "role": Role::SERVICE },
        };
        Ok(Reply::json(200, Value::Document(response)).audited(doc! {
            "action": "realtime.token", "details": { "as": audit_as, "expiresAt": expires_at }
        }))
    }
}

impl Delegate for RealtimeRoutes {
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>> {
        Box::pin(async move {
            let query = match call.route.as_str() {
                "GET realtime/stats" => InspectionQuery::Stats,
                "GET realtime/connections" => InspectionQuery::Connections,
                "GET realtime/observers" => InspectionQuery::Observers,
                "GET realtime/events" => InspectionQuery::Events,
                "GET realtime/trace/:eventId" => InspectionQuery::Trace {
                    id: call.param("eventId").to_owned(),
                    viewer: call.role == AdminRole::Viewer,
                },
                "GET realtime/tail" => InspectionQuery::Tail,
                "POST realtime/token" => return self.token(call).await,
                _ => return Err(CanopyError::new(ErrorCode::NotFound, "Not found")),
            };
            let tail = matches!(query, InspectionQuery::Tail);
            let data = self.inspector.read(query).await?;
            if tail {
                return Ok(Reply::event_stream(b": canopy realtime tail\n\n"));
            }
            let data = data.ok_or_else(|| {
                CanopyError::new(ErrorCode::NotFound, "The event is no longer in the trace buffer")
            })?;
            match data {
                Value::Array(_) => {
                    let mut out = Document::new();
                    out.insert("data", data);
                    Ok(Reply::json(200, Value::Document(out)))
                }
                other => Ok(Reply::json(200, other)),
            }
        })
    }
}
