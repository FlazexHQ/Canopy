//! The sampled request log of the Data API routes the gateway answers, in `request_log` of the meta database,
//! as the TypeScript server keeps it for the requests it answers. The share of requests kept is the
//! `requestLogSampleRate` of the admin settings, read again every ten seconds.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use canopy_mongo::mongodb::Database;
use canopy_mongo::mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use ring::rand::{SecureRandom, SystemRandom};

use crate::log::Log;

/// How often the sampling settings are read again.
const REFRESH: Duration = Duration::from_secs(10);
/// The share of requests kept when the settings do not set one.
const DEFAULT_SAMPLE_RATE: f64 = 0.01;
const MAX_PATH: usize = 512;

/// What is known about a request when its response is ready.
pub(crate) struct Logged<'a> {
    pub(crate) surface: &'a str,
    pub(crate) method: &'a str,
    pub(crate) path: &'a str,
    pub(crate) status: u16,
    pub(crate) started: Instant,
    pub(crate) ip: &'a str,
    pub(crate) request_id: Option<&'a str>,
}

pub(crate) struct RequestLog {
    meta: Database,
    log: Log,
    /// The sample rate, as the bits of an `f64`. Nothing is kept until the settings are first read.
    rate: AtomicU64,
    random: SystemRandom,
    last_warning: Mutex<Option<Instant>>,
}

/// Cuts `text` to at most `max` UTF-16 code units, as JavaScript's `slice` does, without splitting a character.
fn cut(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// A number as the Node driver stores a JavaScript number: an int32 when it is a whole number in range.
fn js_number(number: f64) -> Bson {
    if number.fract() == 0.0 && number >= f64::from(i32::MIN) && number <= f64::from(i32::MAX) {
        #[allow(clippy::cast_possible_truncation)]
        return Bson::Int32(number as i32);
    }
    Bson::Double(number)
}

impl RequestLog {
    pub(crate) fn new(meta: Database, log: Log) -> RequestLog {
        RequestLog {
            meta,
            log,
            rate: AtomicU64::new(0f64.to_bits()),
            random: SystemRandom::new(),
            last_warning: Mutex::new(None),
        }
    }

    pub(crate) async fn start(meta: Database, log: Log) -> std::sync::Arc<Self> {
        let request_log = std::sync::Arc::new(Self::new(meta, log));
        if let Err(error) = request_log.refresh().await {
            log.warn(
                "could not read the settings; the request log keeps nothing",
                &[("err", &error.to_string())],
            );
        }
        let follower = std::sync::Arc::clone(&request_log);
        tokio::spawn(async move { follower.follow().await });
        request_log
    }

    fn rate(&self) -> f64 {
        f64::from_bits(self.rate.load(Ordering::Relaxed))
    }

    /// Reads the sampling settings. A failure keeps the rate in force.
    pub(crate) async fn refresh(&self) -> Result<(), canopy_mongo::mongodb::error::Error> {
        let settings =
            self.meta.collection::<Document>("settings").find_one(doc! { "_id": "settings" }).await?;
        let rate = match settings.as_ref().and_then(|settings| settings.get("requestLogSampleRate")) {
            Some(Bson::Double(rate)) => *rate,
            Some(Bson::Int32(rate)) => f64::from(*rate),
            #[allow(clippy::cast_precision_loss)]
            Some(Bson::Int64(rate)) => *rate as f64,
            _ => DEFAULT_SAMPLE_RATE,
        };
        self.rate.store(rate.to_bits(), Ordering::Relaxed);
        Ok(())
    }

    /// Reads the settings every ten seconds for as long as the process runs.
    pub(crate) async fn follow(&self) {
        loop {
            tokio::time::sleep(REFRESH).await;
            if let Err(error) = self.refresh().await {
                self.log.warn("could not refresh the settings", &[("err", &error.to_string())]);
            }
        }
    }

    /// Whether a request with this status is kept: server errors whenever the rate is above 0, the rest by
    /// chance.
    fn sampled(&self, status: u16) -> bool {
        let rate = self.rate();
        if rate <= 0.0 {
            return false;
        }
        if status >= 500 || rate >= 1.0 {
            return true;
        }
        let mut bytes = [0u8; 8];
        if self.random.fill(&mut bytes).is_err() {
            return false;
        }
        #[allow(clippy::cast_precision_loss)]
        let draw = (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64;
        draw < rate
    }

    /// The document of a request, with the fields of the TypeScript `RequestLogEntry` in its order.
    fn entry(logged: &Logged<'_>, elapsed: Duration) -> Document {
        let duration = (elapsed.as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
        let mut entry = doc! {
            "_id": ObjectId::new(),
            "at": DateTime::now(),
            "surface": logged.surface,
            "method": cut(logged.method, 16),
            "path": cut(logged.path, MAX_PATH),
            "status": i32::from(logged.status),
            "durationMs": js_number(duration),
        };
        if !logged.ip.is_empty() {
            entry.insert("ip", cut(logged.ip, 64));
        }
        if let Some(request_id) = logged.request_id {
            entry.insert("requestId", cut(request_id, 128));
        }
        entry
    }

    /// Records a finished request when it is sampled. The write happens in the background and never fails the
    /// request; a failing write is reported at most once a minute.
    pub(crate) fn record(self: &std::sync::Arc<Self>, logged: &Logged<'_>) {
        if !self.sampled(logged.status) {
            return;
        }
        let entry = RequestLog::entry(logged, logged.started.elapsed());
        let log = std::sync::Arc::clone(self);
        tokio::spawn(async move {
            if log.meta.collection::<Document>("request_log").insert_one(entry).await.is_ok() {
                return;
            }
            let mut last = log.last_warning.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if last.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
                *last = Some(Instant::now());
                log.log.warn("could not write the request log", &[]);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_are_cut_by_utf16_units_without_splitting_characters() {
        assert_eq!(cut("abcdef", 4), "abcd");
        assert_eq!(cut("ab", 4), "ab");
        assert_eq!(cut("a\u{1F600}b", 2), "a");
        assert_eq!(cut("a\u{1F600}b", 3), "a\u{1F600}");
        assert_eq!(cut("é", 1), "é");
    }

    #[test]
    fn numbers_are_stored_as_the_node_driver_stores_them() {
        assert_eq!(js_number(3.0), Bson::Int32(3));
        assert_eq!(js_number(3.4), Bson::Double(3.4));
        assert_eq!(js_number(3e10), Bson::Double(3e10));
    }

    #[test]
    fn an_entry_keeps_the_fields_of_the_typescript_log_and_rounds_the_duration() {
        let logged = Logged {
            surface: "rest",
            method: "POST",
            path: "/rest/v1/todos/_count",
            status: 200,
            started: Instant::now(),
            ip: "127.0.0.1",
            request_id: Some("rid"),
        };
        let entry = RequestLog::entry(&logged, Duration::from_micros(12_345));
        let keys: Vec<&str> = entry.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["_id", "at", "surface", "method", "path", "status", "durationMs", "ip", "requestId"]
        );
        assert_eq!(entry.get("durationMs"), Some(&Bson::Double(12.3)));
        assert_eq!(entry.get("status"), Some(&Bson::Int32(200)));
        let bare =
            RequestLog::entry(&Logged { ip: "", request_id: None, ..logged }, Duration::from_millis(2));
        assert_eq!(bare.get("durationMs"), Some(&Bson::Int32(2)));
        assert!(!bare.contains_key("ip") && !bare.contains_key("requestId"));
    }
}
