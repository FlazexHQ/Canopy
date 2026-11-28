//! Connection identity and dispatch for MongoDB wire commands.

use std::net::IpAddr;
use std::sync::Arc;

use canopy_auth::{Authenticator, RateLimits};
use canopy_data::{ReadPath, writes::WritePath};
use canopy_engine::Principal;
use canopy_mongo::mongodb::bson::{DateTime, Document, doc};

use crate::auth::{self, Conversation, Failure};
use crate::frame::{Compressor, Message, WireError, encode_reply};
use crate::handshake;
use crate::reads::Reads;
use crate::writes;

/// The authentication and command state of one MongoDB connection.
///
/// Speculative authentication is omitted so drivers run the normal SASL exchange.
/// SCRAM accepts configured keys as `service` and provisioned secret API keys by key ID.
pub struct Session {
    authenticator: Authenticator,
    limits: Option<Arc<RateLimits>>,
    address: String,
    connection_id: i64,
    compressors: Vec<Compressor>,
    conversation_id: i32,
    conversation: Option<Conversation>,
    principal: Option<Principal>,
    reads: Option<Reads>,
    writes: Option<Arc<WritePath>>,
}

impl Session {
    /// Creates a session with the gateway's connection ID and optional shared address limiter.
    pub fn new(
        authenticator: Authenticator,
        limits: Option<Arc<RateLimits>>,
        address: IpAddr,
        connection_id: i64,
    ) -> Self {
        Self {
            authenticator,
            limits,
            address: address.to_string(),
            connection_id,
            compressors: Vec::new(),
            conversation_id: 0,
            conversation: None,
            principal: None,
            reads: None,
            writes: None,
        }
    }

    /// Enables bounded, policy enforced reads on the read path's application database.
    ///
    /// The endpoint refuses hints, custom collation and unlisted command options. It accepts
    /// comments as metadata and applies the Data API snapshot and time limits even when the
    /// driver supplies read preferences or read concern. A positive maxTimeMS can shorten that limit.
    ///
    /// A find with no positive limit returns at most the configured maximum. Cursors hold one
    /// bounded snapshot and belong to the connection that created them. Unexposed collections
    /// return Unauthorized without revealing whether the collection exists.
    #[must_use]
    pub fn with_read_path(mut self, path: Arc<ReadPath>) -> Self {
        self.reads = Some(Reads::new(path));
        self
    }

    /// Enables writes over the same application database as the read path.
    ///
    /// The read path must also be configured to resolve caller context. Each write statement
    /// has its own majority acknowledged transaction. Drivers must set `retryWrites=false`.
    #[must_use]
    pub fn with_write_path(mut self, path: Arc<WritePath>) -> Self {
        self.writes = Some(path);
        self
    }

    /// Enables change streams through the gateway's realtime engine.
    #[must_use]
    pub fn with_realtime(mut self, engine: canopy_realtime::EngineSender) -> Self {
        if let Some(reads) = &mut self.reads {
            reads.enable_watch(engine, self.address.clone());
        }
        self
    }

    /// Returns the authenticated identity while its credential is current.
    pub fn principal(&self) -> Option<&Principal> {
        self.principal.as_ref().filter(|principal| !self.expired(principal) && !self.revoked(principal))
    }

    /// Returns the compressors accepted on this connection.
    pub fn compressors(&self) -> &[Compressor] {
        &self.compressors
    }

    /// Dispatches a parsed request and encodes a reply in the request's wire format.
    /// Requests with moreToCome receive no reply.
    pub async fn handle(&mut self, message: Message) -> Result<Option<Vec<u8>>, WireError> {
        if message.more_to_come {
            return Ok(None);
        }
        if let Some(reads) = &mut self.reads {
            reads.expire();
        }
        let command = message.body.keys().next().map_or("", String::as_str);
        let response = match command {
            "hello" | "isMaster" | "ismaster" => {
                let negotiated = handshake::negotiate(&message.body);
                let response = handshake::hello(
                    command,
                    &message.body,
                    self.connection_id,
                    !self.authenticator.configured_service_keys().is_empty(),
                    self.authenticator.api_keys.is_some(),
                    negotiated.as_deref(),
                );
                if let Some(negotiated) = negotiated {
                    self.compressors = negotiated;
                }
                response
            }
            "ping" | "endSessions" => {
                if self.reads.as_ref().is_none_or(|reads| reads.accepts_database(&message.body)) {
                    doc! { "ok": 1.0 }
                } else {
                    error(13, "Unauthorized", "Unauthorized")
                }
            }
            "buildInfo" => handshake::build_info(),
            "saslStart" | "saslContinue" => self.authenticate(command, &message.body).await,
            _ if writes::is_write(command) && self.principal().is_some() => {
                match (self.principal.as_ref(), &self.reads, &self.writes) {
                    (Some(principal), Some(reads), Some(path)) => {
                        writes::handle(&reads.path, path, principal, command, &message.body).await
                    }
                    _ => error(59, "CommandNotFound", format!("no such command: '{command}'")),
                }
            }
            _ if self.principal().is_some() => match (self.principal.clone(), &mut self.reads) {
                (Some(principal), Some(reads)) => reads.handle(&principal, command, &message.body).await,
                _ => error(59, "CommandNotFound", format!("no such command: '{command}'")),
            },
            _ if self.principal.as_ref().is_some_and(|principal| self.expired(principal)) => {
                reauthentication_required()
            }
            _ => error(13, "Unauthorized", format!("Command {command} requires authentication")),
        };
        let response = if command == "getMore" && self.principal.is_some() && self.principal().is_none() {
            if let Some(reads) = &mut self.reads {
                reads.clear();
            }
            if self.principal.as_ref().is_some_and(|principal| self.expired(principal)) {
                reauthentication_required()
            } else {
                error(13, "Unauthorized", "Unauthorized")
            }
        } else {
            response
        };
        encode_reply(message.header, &response).map(Some)
    }

    fn expired(&self, principal: &Principal) -> bool {
        let now = u64::try_from(DateTime::now().timestamp_millis()).unwrap_or_default();
        principal.expires_at_ms.is_some_and(|expires| expires < now)
    }

    fn revoked(&self, principal: &Principal) -> bool {
        self.authenticator.revocations.as_ref().is_some_and(|store| store.has(principal))
    }

    async fn authenticate(&mut self, command: &str, body: &Document) -> Document {
        let previous = self.conversation.take();
        self.principal = None;
        if let Some(reads) = &mut self.reads {
            reads.clear();
        }
        if self.limits.as_ref().is_some_and(|limits| limits.authentication_blocked(&self.address) > 0) {
            return error(18, "AuthenticationFailed", "Authentication failed.");
        }
        let result = if command == "saslStart" {
            self.conversation_id = self.conversation_id.checked_add(1).unwrap_or(1);
            auth::start(&self.authenticator, self.conversation_id, body).await
        } else if let Some(conversation) = previous {
            auth::continue_exchange(&self.authenticator, self.conversation_id, conversation, body).await
        } else {
            Err(Failure::Invalid)
        };
        match result {
            Ok(exchange) => {
                self.principal = exchange.principal;
                self.conversation = exchange.next;
                exchange.response
            }
            Err(failure) => {
                if let Some(limits) = &self.limits {
                    limits.authentication_failed(&self.address);
                }
                match failure {
                    Failure::Invalid => error(18, "AuthenticationFailed", "Authentication failed."),
                    Failure::Expired => reauthentication_required(),
                }
            }
        }
    }
}

pub(crate) fn error(code: i32, code_name: &str, message: impl Into<String>) -> Document {
    doc! { "ok": 0.0, "errmsg": message.into(), "code": code, "codeName": code_name }
}

fn reauthentication_required() -> Document {
    error(391, "ReauthenticationRequired", "Reauthentication required.")
}
