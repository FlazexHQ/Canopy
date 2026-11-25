//! The admin route groups that other parts of Canopy serve: policy publishing, email templates, the data
//! routes, the realtime inspector, app users and the signing keys of built in auth. Each is a [`Delegate`]
//! that the admin API calls after authentication, CSRF, RBAC and the token rules, and whose audit entries
//! it records with the caller's actor and origin.

use std::future::Future;
use std::pin::Pin;

use canopy_mongo::mongodb::bson::Document;
use canopy_protocol::{CanopyError, ErrorCode, Value};

use crate::rbac::{AdminRole, Permission, can};

/// A boxed future, as delegates return them.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One admin request as a delegate sees it.
#[derive(Debug, Clone)]
pub struct Call {
    /// The route as registered, such as `POST policies/:collection/publish`.
    pub route: String,
    /// The path parameters, such as `collection`.
    pub params: Vec<(String, String)>,
    /// The query parameters, decoded, in request order.
    pub query: Vec<(String, String)>,
    /// The request headers.
    pub headers: Vec<(String, String)>,
    /// The body read as relaxed EJSON, absent when the request had none.
    pub body: Option<Value>,
    /// The caller's role (for an admin API token, the lower of the token's and the admin's).
    pub role: AdminRole,
    /// Whether the server runs in production.
    pub production: bool,
    /// The audit actor of the caller.
    pub actor: Document,
    /// The audit origin of the request.
    pub origin: Document,
}

impl Call {
    /// A path parameter, empty when absent.
    pub fn param(&self, name: &str) -> &str {
        self.params.iter().find(|(key, _)| key == name).map_or("", |(_, value)| value.as_str())
    }

    /// The first value of a query parameter.
    pub fn query(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// Whether the caller may do what `permission` covers.
    pub fn can(&self, permission: Permission) -> bool {
        can(self.role, permission, self.production)
    }

    /// Refuses the call unless the caller may do what `permission` covers.
    pub fn require(&self, permission: Permission) -> Result<(), CanopyError> {
        if self.can(permission) {
            Ok(())
        } else {
            Err(CanopyError::new(
                ErrorCode::Forbidden,
                format!("The {} role may not do this", self.role.as_str()),
            ))
        }
    }
}

/// What a delegate answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    /// The status.
    pub status: u16,
    /// The JSON body, or none for `204`.
    pub body: Option<Value>,
    /// Extra response headers.
    pub headers: Vec<(String, String)>,
    /// Audit entries to record, each without actor and origin, which the admin API appends.
    pub audit: Vec<Document>,
}

impl Reply {
    /// A JSON reply.
    pub fn json(status: u16, body: Value) -> Reply {
        Reply { status, body: Some(body), headers: Vec::new(), audit: Vec::new() }
    }

    /// Adds an audit entry.
    #[must_use]
    pub fn audited(mut self, entry: Document) -> Reply {
        self.audit.push(entry);
        self
    }
}

/// A group of admin routes served elsewhere.
pub trait Delegate: Send + Sync {
    /// Serves one call. A `CANOPY_FORBIDDEN` error of a state changing call is audited as denied.
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>>;
}

/// The policy information the doctor reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyStatus {
    /// The version of the policy bundle in force.
    pub bundle: String,
    /// How many collections it defines.
    pub collections: usize,
}

/// The realtime figures the doctor reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeStatus {
    /// Open connections.
    pub connections: u64,
    /// The change stream position.
    pub stream_position: String,
}

/// What the admin API reads from the rest of the server for its own routes.
pub trait Status: Send + Sync {
    /// The policies in force.
    fn policies(&self) -> BoxFuture<'_, Option<PolicyStatus>>;
    /// The realtime engine, when this process runs one.
    fn realtime(&self) -> Option<RealtimeStatus>;
    /// Whether sign outs and bans written by other nodes reach this one, with built in auth.
    fn revocations_following(&self) -> Option<bool>;
    /// Ends every app user session of built in auth and returns how many ended.
    fn revoke_all_user_sessions(&self) -> BoxFuture<'_, Result<u64, CanopyError>>;
}

/// A [`Status`] that knows nothing: no policies, no realtime, no built in auth.
pub struct NoStatus;

impl Status for NoStatus {
    fn policies(&self) -> BoxFuture<'_, Option<PolicyStatus>> {
        Box::pin(async { None })
    }

    fn realtime(&self) -> Option<RealtimeStatus> {
        None
    }

    fn revocations_following(&self) -> Option<bool> {
        None
    }

    fn revoke_all_user_sessions(&self) -> BoxFuture<'_, Result<u64, CanopyError>> {
        Box::pin(async { Ok(0) })
    }
}

/// A [`Status`] of a control plane process: the policies published in the meta database, no realtime engine,
/// and no app user sessions of its own.
pub struct MetaStatus {
    meta: canopy_mongo::mongodb::Database,
}

impl MetaStatus {
    /// The status read from a meta database.
    pub fn new(meta: &canopy_mongo::mongodb::Database) -> MetaStatus {
        MetaStatus { meta: meta.clone() }
    }
}

impl Status for MetaStatus {
    fn policies(&self) -> BoxFuture<'_, Option<PolicyStatus>> {
        Box::pin(async move {
            let set = canopy_mongo::load_policies(&self.meta).await.ok()?;
            Some(PolicyStatus { bundle: set.version().to_owned(), collections: set.collections().len() })
        })
    }

    fn realtime(&self) -> Option<RealtimeStatus> {
        None
    }

    fn revocations_following(&self) -> Option<bool> {
        None
    }

    fn revoke_all_user_sessions(&self) -> BoxFuture<'_, Result<u64, CanopyError>> {
        Box::pin(async { Ok(0) })
    }
}
