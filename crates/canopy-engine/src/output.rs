use std::sync::Arc;

use canopy_protocol::Document;

use crate::auth::Principal;
use crate::observer::Read;
use crate::wire::{Mutation, frame_text};

/// A connection, numbered by the transport.
pub type ConnId = u64;

/// A sequenced frame: a head shared between connections, an optional tail for this connection (`,"s":[…]`),
/// and its sequence number. Its text is `head + tail + ,"seq":N}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// The shared part.
    pub head: Arc<str>,
    /// The part of this connection.
    pub tail: Option<Arc<str>>,
    /// The sequence number.
    pub seq: u64,
}

impl Frame {
    /// The frame's JSON text.
    pub fn text(&self) -> String {
        match &self.tail {
            None => frame_text(&self.head, self.seq),
            Some(tail) => {
                let mut head = String::with_capacity(self.head.len() + tail.len());
                head.push_str(&self.head);
                head.push_str(tail);
                frame_text(&head, self.seq)
            }
        }
    }

    /// The bytes the frame counts against buffers.
    pub fn weight(&self) -> usize {
        self.head.len() + self.tail.as_ref().map_or(0, |tail| tail.len()) + 16
    }
}

/// A read the engine needs from MongoDB, answered with [`crate::Engine::read_done`].
#[derive(Debug, Clone)]
pub struct ReadRequest {
    /// The request number.
    pub id: u64,
    /// The query.
    pub read: Read,
}

/// A write to forward to the write path, answered with [`crate::Engine::mutation_done`].
#[derive(Debug, Clone)]
pub struct MutationRequest {
    /// The request number.
    pub id: u64,
    /// The connection's API key.
    pub key: String,
    /// The connection's user token, if any.
    pub token: Option<String>,
    /// Who writes.
    pub principal: Principal,
    /// The `mut` frame.
    pub mutation: Mutation,
}

/// A policy filtered event for a local MongoDB change stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchFrame {
    /// Sequence in the local connection.
    pub seq: u64,
    /// Original operation, or delete when a document leaves the read policy.
    pub op: crate::Op,
    /// MongoDB cluster time.
    pub ct: crate::Ct,
    /// MongoDB wall time in milliseconds, when present.
    pub wall_ms: Option<i64>,
    /// BSON containing the document ID and, when readable, the projected document.
    pub image: Vec<u8>,
}

/// Something the transport must do.
#[derive(Debug, Clone)]
pub enum Output {
    /// Deliver an event to a local change stream.
    Watch {
        /// The connection.
        conn: ConnId,
        /// The change event.
        frame: WatchFrame,
    },
    /// Write a sequenced frame.
    Frame {
        /// The connection.
        conn: ConnId,
        /// The frame.
        frame: Frame,
    },
    /// Write an unsequenced frame (`welcome`, `pong`, an `err` before the session).
    Text {
        /// The connection.
        conn: ConnId,
        /// The JSON text.
        text: String,
    },
    /// A session started on the connection; `batch` says whether queued frames may be sent as one `batch`.
    Session {
        /// The connection.
        conn: ConnId,
        /// Whether the client negotiated `batch`.
        batch: bool,
    },
    /// Close the connection.
    Close {
        /// The connection.
        conn: ConnId,
        /// The WebSocket close code.
        code: u16,
        /// The reason.
        reason: String,
    },
    /// Verify credentials, then call [`crate::Engine::authenticated`].
    Authenticate {
        /// The connection.
        conn: ConnId,
        /// The API key.
        key: String,
        /// The user token.
        token: Option<String>,
        /// Whether this is a re-authentication (`auth`) rather than `hello`.
        refresh: bool,
    },
    /// Read documents from MongoDB.
    Read(ReadRequest),
    /// Look up the current documents of updates without a post image.
    Lookup {
        /// The request number.
        id: u64,
        /// The collection.
        coll: String,
        /// The `_id`s.
        ids: Vec<canopy_protocol::Value>,
    },
    /// Forward a write.
    Mutate(Box<MutationRequest>),
    /// Run context lookups, then call [`crate::Engine::contexts_done`].
    Contexts {
        /// The request number.
        id: u64,
        /// The lookups.
        reads: Vec<ContextRead>,
    },
    /// The collections the stream must cover changed.
    Collections(Vec<String>),
}

/// One context lookup to run: `find(filter).limit(limit)` on `from`.
#[derive(Debug, Clone)]
pub struct ContextRead {
    /// The lookup name.
    pub name: String,
    /// The source collection.
    pub from: String,
    /// The `where` clause with the subject's claims substituted.
    pub filter: Document,
    /// The most documents to read.
    pub limit: u32,
}

/// A document set read for [`Output::Read`].
#[derive(Debug, Clone, Default)]
pub struct ReadResult {
    /// The documents.
    pub documents: Vec<Document>,
    /// The snapshot's cluster time.
    pub ct: crate::ct::Ct,
}
