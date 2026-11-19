//! Canopy's realtime engine in Rust, without I/O. Connections, client frames, snapshot reads and change events
//! go in; sequenced `canopy.v1` frames and requests for reads, lookups, authentication and writes come out. It
//! mirrors the engine of the TypeScript `@canopy/realtime` package: shared observers indexed by equality value,
//! membership and path, merge boxes that send a document once per connection, resume buffers, resync when gap
//! free delivery cannot be promised, and echo before ack for writes forwarded to the write path.
//!
//! The engine is single threaded and deterministic: the transport (`canopy-gateway`) owns the sockets, the
//! MongoDB driver and the clock, and calls [`Engine`] with what happened and the current time.

mod auth;
mod ct;
mod echo;
mod engine;
mod event;
mod metrics;
mod observer;
mod output;
mod plan;
mod registry;
mod session;
mod wire;

pub use auth::Principal;
pub use ct::Ct;
pub use echo::{EchoWaiter, Settled};
pub use engine::{Config, Engine, Limits, MessageRate, MutationOutcome};
pub use event::{
    Control, ControlKind, Diff, Event, Image, Normalized, Op, Post, doc_key, merge_fragments, normalize,
};
pub use metrics::Metrics;
pub use observer::{Kind, ObserverLimits};
pub use output::{ConnId, Frame, MutationRequest, Output, ReadRequest, ReadResult};
pub use plan::{Plan, plan};
pub use registry::{IndexKey, indexable_conjunct};
pub use wire::{ClientMessage, MutOp, Mutation, PROTOCOL_VERSION, SubQuery, close, decode_client};
