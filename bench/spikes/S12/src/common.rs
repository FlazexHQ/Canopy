use std::time::Duration;

use futures_util::StreamExt;
use mongodb::bson::{RawDocument, RawDocumentBuf, Timestamp};
use mongodb::change_stream::ChangeStream;
use mongodb::error::{Error, ErrorKind, WriteFailure};
use mongodb::{ClientSession, SessionCursor};

pub type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub fn fail<T>(message: impl Into<String>) -> Res<T> {
    Err(message.into().into())
}

pub fn ensure(condition: bool, message: impl FnOnce() -> String) -> Res<()> {
    if condition { Ok(()) } else { fail(message()) }
}

pub fn show(time: Timestamp) -> String {
    format!("{}.{}", time.time, time.increment)
}

pub fn show_opt(time: Option<Timestamp>) -> String {
    time.map_or_else(|| "none".to_owned(), show)
}

pub fn pack(time: Timestamp) -> u64 {
    (u64::from(time.time) << 32) | u64::from(time.increment)
}

pub fn unpack(value: u64) -> Timestamp {
    Timestamp { time: (value >> 32) as u32, increment: value as u32 }
}

/// The server error code of a command, write or write concern error.
pub fn server_code(error: &Error) -> Option<i32> {
    match error.kind.as_ref() {
        ErrorKind::Command(command) => Some(command.code),
        ErrorKind::Write(WriteFailure::WriteError(write)) => Some(write.code),
        ErrorKind::Write(WriteFailure::WriteConcernError(concern)) => Some(concern.code),
        _ => None,
    }
}

pub fn cluster_time(event: &RawDocument) -> Res<Timestamp> {
    Ok(event.get_timestamp("clusterTime")?)
}

pub fn operation_type(event: &RawDocument) -> Res<&str> {
    Ok(event.get_str("operationType")?)
}

/// Waits for the next event, failing after a timeout instead of hanging the run.
pub async fn next_event<T>(stream: &mut ChangeStream<T>, wait: Duration) -> Res<T>
where
    T: serde::de::DeserializeOwned + Unpin + Send + Sync,
{
    match tokio::time::timeout(wait, stream.next()).await {
        Err(_) => fail("timed out waiting for a change event"),
        Ok(None) => fail("the change stream closed"),
        Ok(Some(result)) => Ok(result?),
    }
}

pub async fn collect_raw(
    mut cursor: SessionCursor<RawDocumentBuf>,
    session: &mut ClientSession,
) -> Res<Vec<RawDocumentBuf>> {
    let mut out = Vec::new();
    while cursor.advance(session).await? {
        out.push(cursor.current().to_owned());
    }
    Ok(out)
}

/// A small deterministic generator (SplitMix64), so every run can be replayed from its seed.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 { 0 } else { self.next_u64() % bound }
    }

    pub fn range(&mut self, low: u64, high: u64) -> u64 {
        low + self.below(high - low + 1)
    }
}
