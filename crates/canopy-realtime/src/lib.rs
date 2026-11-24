//! Native realtime sessions over WebSockets, SSE and long polling, driven by a MongoDB change stream.

mod core;
mod http;
mod ingest;
mod server;

pub use core::{Deliver, EngineOptions, EngineSender, LocalConnection, LocalFrame};
pub use http::{Body, Cors, full};
pub use ingest::{FullDocument, Ingest};
pub use server::{HttpRoutes, Running, Server, TransportOptions};

/// Severity of a diagnostic emitted by the session engine or the change stream.
#[derive(Debug, Clone, Copy)]
pub enum LogLevel {
    /// A normal lifecycle event.
    Info,
    /// A recoverable failure.
    Warn,
    /// A failure that requires recovery or resynchronization.
    Error,
}
