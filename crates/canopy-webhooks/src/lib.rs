//! Durable triggers, UTC schedules and Standard Webhooks delivery.

mod capture;
mod cron;
mod dispatch;
mod queue;

use std::collections::BTreeMap;
use std::future::IntoFuture;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use canopy_matcher::{CompiledFilter, compile_filter};
use canopy_mongo::mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
};
use canopy_protocol::{CanopyError, ErrorCode, Value, bson::decode_document};
use cron::Cron;
use futures_util::TryStreamExt;
use queue::Queue;
use ring::{hmac, rand::SecureRandom};
use time::{OffsetDateTime, macros::format_description};
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
};
use uuid::Uuid;

/// Runtime settings and injectable sources for a webhook worker.
pub struct Options {
    /// Standard Webhooks signing secret.
    pub secret: String,
    /// Identifies the process holding the delivery lease.
    pub node: String,
    /// Maximum number of attempts per delivery.
    pub max_attempts: i32,
    /// Request timeout in milliseconds.
    pub timeout_ms: i64,
    /// Initial retry delay in milliseconds.
    pub retry_base_ms: i64,
    /// Maximum retry delay in milliseconds, including Retry-After.
    pub retry_max_ms: i64,
    /// Time between queue and schedule checks when idle.
    pub poll: Duration,
    /// Concurrent delivery workers.
    pub concurrency: usize,
    /// Require pre and post images from the change stream.
    pub images: bool,
    /// Current Unix time in milliseconds.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Independent samples in the range zero inclusive to one exclusive.
    pub random: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// Generates the unique suffix of a manual run.
    pub id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Options {
    /// Creates settings with default dispatch timing and system sources.
    pub fn new(secret: String, node: String) -> Self {
        Self {
            secret,
            node,
            max_attempts: 8,
            timeout_ms: 10_000,
            retry_base_ms: 10_000,
            retry_max_ms: 3_600_000,
            poll: Duration::from_secs(1),
            concurrency: 4,
            images: false,
            now: Arc::new(|| DateTime::now().timestamp_millis()),
            random: Arc::new(|| {
                let mut bytes = [0; 4];
                if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
                    return 0.5;
                }
                f64::from(u32::from_le_bytes(bytes)) / 4_294_967_296.0
            }),
            id: Arc::new(|| Uuid::new_v4().to_string()),
        }
    }
}

enum Kind {
    Trigger { collection: String, operations: Vec<String>, filter: Option<CompiledFilter> },
    Schedule { cron: Cron, body: Option<Bson> },
}

struct Hook {
    url: reqwest::Url,
    kind: Kind,
}

type Counters = BTreeMap<(String, &'static str), u64>;

/// Configured hooks, the shared delivery queue, and counters for this process.
pub struct Webhooks {
    options: Options,
    meta: Database,
    hooks: BTreeMap<String, Hook>,
    queue: Queue,
    http: reqwest::Client,
    key: hmac::Key,
    counters: Mutex<Counters>,
    wake: Notify,
}

/// Owns the background webhook workers.
pub struct Handle {
    /// Access to manual runs, queue operations and metrics.
    pub webhooks: Arc<Webhooks>,
    stop: watch::Sender<bool>,
    workers: Vec<JoinHandle<()>>,
}

impl Handle {
    /// Stops new work and waits for deliveries and capture writes in progress.
    pub async fn shutdown(mut self) -> Result<(), CanopyError> {
        let _ = self.stop.send(true);
        let mut result = Ok(());
        for worker in self.workers.drain(..) {
            if let Err(error) = worker.await {
                result = Err(unavailable(error));
            }
        }
        result
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

impl Webhooks {
    /// Builds the webhooks of the config's `webhooks` section. Each definition has a string _id, url
    /// and kind. Triggers have collection, operations and an optional BSON filter. Schedules have
    /// cron and an optional BSON body.
    pub fn new(
        meta: Database,
        options: Options,
        definitions: impl IntoIterator<Item = Document>,
    ) -> Result<Self, CanopyError> {
        if options.max_attempts < 1
            || options.timeout_ms < 1
            || options.retry_base_ms < 0
            || options.retry_max_ms < options.retry_base_ms
            || options.concurrency == 0
            || options.poll.is_zero()
        {
            return Err(invalid("Invalid webhook dispatch settings"));
        }
        let mut hooks = BTreeMap::new();
        for definition in definitions {
            hooks.insert(field(&definition, "_id")?.to_owned(), Hook::parse(&definition)?);
        }
        let key = dispatch::key(&options.secret)?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(options.timeout_ms as u64))
            .build()
            .map_err(unavailable)?;
        Ok(Self {
            queue: Queue::new(&meta),
            options,
            meta,
            hooks,
            http,
            key,
            counters: Mutex::default(),
            wake: Notify::new(),
        })
    }

    /// Builds the webhooks of `definitions`, catches up schedules, and starts capture and delivery
    /// workers.
    pub async fn start(
        app: Database,
        meta: Database,
        options: Options,
        definitions: impl IntoIterator<Item = Document>,
    ) -> Result<Handle, CanopyError> {
        let webhooks = Arc::new(Self::new(meta, options, definitions)?);
        webhooks.catch_up().await?;
        let (stop, rx) = watch::channel(false);
        let mut handle = Handle { webhooks: webhooks.clone(), stop, workers: Vec::new() };
        if webhooks.hooks.values().any(|hook| matches!(hook.kind, Kind::Trigger { .. })) {
            let (stream, token) = webhooks.open_capture(&app).await?;
            handle.workers.push(tokio::spawn(webhooks.clone().capture_loop(app, stream, token, rx.clone())));
        }
        for _ in 0..webhooks.options.concurrency {
            handle.workers.push(tokio::spawn(webhooks.clone().dispatch_loop(rx.clone())));
        }
        handle.workers.push(tokio::spawn(webhooks.schedule_loop(rx)));
        Ok(handle)
    }

    fn now(&self) -> DateTime {
        DateTime::from_millis((self.options.now)())
    }

    fn count(&self, hook: &str, outcome: &'static str) {
        if let Ok(mut counters) = self.counters.lock() {
            *counters.entry((hook.to_owned(), outcome)).or_default() += 1;
        }
    }

    /// Prometheus counters for delivery attempts by hook and outcome and for enqueue operations by hook.
    pub fn metrics(&self) -> String {
        use std::fmt::Write;
        let mut output = String::new();
        if let Ok(counters) = self.counters.lock() {
            for (metric, description, enqueued) in [
                (
                    "canopy_webhook_deliveries_total",
                    "Webhook attempts by hook and outcome (delivered, retried, dead_lettered)",
                    false,
                ),
                ("canopy_webhook_enqueued_total", "Webhook deliveries stored by this server, by hook", true),
            ] {
                let _ = writeln!(output, "# HELP {metric} {description}\n# TYPE {metric} counter");
                for ((hook, outcome), count) in
                    counters.iter().filter(|((_, outcome), _)| (*outcome == "enqueued") == enqueued)
                {
                    let hook = hook.replace('\\', "\\\\").replace('\n', "\\n").replace('"', "\\\"");
                    let labels = if enqueued {
                        format!("hook=\"{hook}\"")
                    } else {
                        format!("hook=\"{hook}\",outcome=\"{outcome}\"")
                    };
                    let _ = writeln!(output, "{metric}{{{labels}}} {count}");
                }
            }
        }
        output
    }

    /// Returns the active delivery and dead letter for an id, when present.
    pub async fn find(&self, id: &str) -> Result<(Option<Document>, Option<Document>), CanopyError> {
        tokio::try_join!(
            self.queue.deliveries.find_one(doc! { "_id": id }).into_future(),
            self.queue.dead.find_one(doc! { "_id": id }).into_future(),
        )
        .map_err(unavailable)
    }

    /// Returns the newest dead letters, optionally scoped to one hook.
    pub async fn dead_letters(&self, hook: Option<&str>, limit: i64) -> Result<Vec<Document>, CanopyError> {
        self.queue
            .dead
            .find(hook.map_or_else(Document::new, |hook| doc! { "hook": hook }))
            .sort(doc! { "failedAt": -1 })
            .limit(limit.clamp(1, 500))
            .await
            .map_err(unavailable)?
            .try_collect()
            .await
            .map_err(unavailable)
    }

    /// Moves a dead letter back to the queue with fresh attempts.
    pub async fn retry(&self, id: &str) -> Result<bool, CanopyError> {
        let changed = self.queue.requeue(id, self.now()).await.map_err(unavailable)?;
        if changed {
            self.wake.notify_one();
        }
        Ok(changed)
    }

    /// Removes a dead letter by id.
    pub async fn discard(&self, id: &str) -> Result<bool, CanopyError> {
        Ok(self.queue.dead.delete_one(doc! { "_id": id }).await.map_err(unavailable)?.deleted_count == 1)
    }

    /// Stores a delivery due now and returns whether its id was new.
    pub async fn enqueue(&self, id: &str, hook: &str, kind: &str, body: String) -> Result<bool, CanopyError> {
        let stored = self.queue.enqueue(id, hook, kind, body, self.now()).await.map_err(unavailable)?;
        if stored {
            self.count(hook, "enqueued");
            self.wake.notify_one();
        }
        Ok(stored)
    }

    /// Returns the next scheduled UTC fire time, strictly after now.
    pub fn next_fire(&self, name: &str) -> Option<DateTime> {
        match &self.hooks.get(name)?.kind {
            Kind::Schedule { cron, .. } => {
                cron.search(self.now().timestamp_millis(), true).map(DateTime::from_millis)
            }
            Kind::Trigger { .. } => None,
        }
    }

    /// Initializes new schedules and enqueues the latest missed occurrence of existing schedules.
    pub async fn catch_up(&self) -> Result<(), CanopyError> {
        let states = self.meta.collection::<Document>("webhook_schedules");
        let now = self.now();
        for (name, hook) in &self.hooks {
            let Kind::Schedule { cron, .. } = &hook.kind else { continue };
            let last = DateTime::from_millis(
                cron.search(now.timestamp_millis(), false)
                    .ok_or_else(|| invalid("No previous fire time for webhook schedule"))?,
            );
            let state = states.find_one(doc! { "_id": name }).await.map_err(unavailable)?;
            if let Some(state) = state {
                if state.get_datetime("lastAt").map_err(unavailable)? < &last {
                    self.fire(name, last).await?;
                }
            } else {
                states
                    .update_one(doc! { "_id": name }, doc! { "$setOnInsert": { "lastAt": last } })
                    .upsert(true)
                    .await
                    .map_err(unavailable)?;
            }
        }
        Ok(())
    }

    /// Enqueues a scheduled occurrence, deduplicated by name and occurrence time.
    pub async fn fire(&self, name: &str, at: DateTime) -> Result<bool, CanopyError> {
        let Some(Kind::Schedule { body, .. }) = self.hooks.get(name).map(|hook| &hook.kind) else {
            return Ok(false);
        };
        let at_text = iso(at)?;
        let id = format!("schedule:{name}:{at_text}");
        let stored = self.enqueue(&id, name, "schedule", schedule_body(name, &at_text, body.clone())).await?;
        self.meta
            .collection::<Document>("webhook_schedules")
            .update_one(doc! { "_id": name }, doc! { "$max": { "lastAt": at } })
            .upsert(true)
            .await
            .map_err(unavailable)?;
        Ok(stored)
    }

    /// Runs a schedule immediately without advancing its scheduled occurrence.
    pub async fn run(&self, name: &str) -> Result<Option<String>, CanopyError> {
        let Some(Kind::Schedule { body, .. }) = self.hooks.get(name).map(|hook| &hook.kind) else {
            return Ok(None);
        };
        let at = iso(self.now())?;
        let id = format!("schedule:{name}:run:{at}:{}", (self.options.id)());
        self.enqueue(&id, name, "schedule", schedule_body(name, &at, body.clone())).await?;
        Ok(Some(id))
    }

    async fn schedule_loop(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        while !*stop.borrow() {
            if let Err(error) = self.catch_up().await {
                tracing::error!(error = %error, "Could not store a webhook schedule fire");
            }
            tokio::select! {
                _ = stop.changed() => break,
                _ = tokio::time::sleep(self.options.poll) => {}
            }
        }
    }
}

impl Hook {
    fn parse(definition: &Document) -> Result<Self, CanopyError> {
        let url =
            reqwest::Url::parse(field(definition, "url")?).map_err(|_| invalid("Invalid webhook URL"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(invalid("Webhook URL must use HTTP or HTTPS"));
        }
        let kind = match field(definition, "kind")? {
            "trigger" => {
                let collection = field(definition, "collection")?.to_owned();
                let operations = definition
                    .get_array("operations")
                    .map_err(|_| invalid("Expected webhook operations"))?
                    .iter()
                    .map(|op| match op.as_str() {
                        Some(op @ ("insert" | "update" | "replace" | "delete")) => Ok(op.to_owned()),
                        _ => Err(invalid("Invalid webhook operation")),
                    })
                    .collect::<Result<_, _>>()?;
                let filter = definition
                    .get("filter")
                    .map(|filter| {
                        let filter = filter
                            .as_document()
                            .ok_or_else(|| invalid("Expected a webhook filter document"))?;
                        compile_filter(&Value::Document(decode_document(
                            &filter.to_vec().map_err(unavailable)?,
                        )?))
                    })
                    .transpose()?;
                Kind::Trigger { collection, operations, filter }
            }
            "schedule" => Kind::Schedule {
                cron: Cron::parse(field(definition, "cron")?)?,
                body: definition.get("body").cloned(),
            },
            _ => return Err(invalid("Invalid webhook kind")),
        };
        Ok(Self { kind, url })
    }
}

fn schedule_body(name: &str, at: &str, body: Option<Bson>) -> String {
    let mut payload = doc! { "type": "schedule", "schedule": name, "scheduledAt": at };
    if let Some(body) = body {
        payload.insert("body", body);
    }
    capture::body(payload)
}

fn iso(at: DateTime) -> Result<String, CanopyError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(at.timestamp_millis()) * 1_000_000)
        .map_err(unavailable)?
        .format(format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"))
        .map_err(unavailable)
}

fn field<'a>(document: &'a Document, name: &str) -> Result<&'a str, CanopyError> {
    document.get_str(name).map_err(|_| invalid(format!("Expected a webhook string field: {name}")))
}

fn invalid(message: impl Into<String>) -> CanopyError {
    CanopyError::new(ErrorCode::ValidationFailed, message.into())
}

fn unavailable(error: impl std::fmt::Display) -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, error.to_string())
}
