//! Spike S11 load driver. Seeds the collection of the TypeScript fan out benchmark, starts one server (the Rust
//! gateway prototype or the `canopy-realtime` sidecar on Bun or Node), opens real WebSocket connections over
//! loopback, drives writes with `packages/realtime/bench/writer.ts`, and reports delivery latency, server CPU per
//! event and server memory per connection.
//!
//! Scenarios: `idle:<connections>`, `owners:<connections>:<subs per connection>:<writes/s>` and
//! `hot:<connections>:<writes/s>`.

mod load;
mod server;
mod setup;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use mongodb::bson::{Document, doc};
use tokio::sync::{Mutex, watch};

use crate::load::{Outcome, Plan};
use crate::server::{Launch, Sample, Server};
use crate::setup::{Keys, Shape};

pub type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

const OWNER_SUBS: [&str; 5] = [
    r#"{}"#,
    r#"{"status":"open"}"#,
    r#"{"score":{"$gte":5000}}"#,
    r#"{"score":{"$lt":1000}}"#,
    r#"{"status":"done","score":{"$lt":3000}}"#,
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Idle,
    Owners,
    Hot,
}

#[derive(Clone)]
struct Scenario {
    name: String,
    mode: Mode,
    connections: usize,
    subs: usize,
    rate: u32,
}

fn scenario(text: &str) -> Res<Scenario> {
    let parts: Vec<&str> = text.split(':').collect();
    let number = |i: usize| -> Res<usize> { Ok(parts.get(i).ok_or("missing number")?.parse::<usize>()?) };
    Ok(match parts.first().copied() {
        Some("idle") => Scenario { name: text.to_owned(), mode: Mode::Idle, connections: number(1)?, subs: 0, rate: 0 },
        Some("owners") => Scenario {
            name: text.to_owned(),
            mode: Mode::Owners,
            connections: number(1)?,
            subs: number(2)?.clamp(1, OWNER_SUBS.len()),
            rate: u32::try_from(number(3)?)?,
        },
        Some("hot") => Scenario {
            name: text.to_owned(),
            mode: Mode::Hot,
            connections: number(1)?,
            subs: 1,
            rate: u32::try_from(number(2)?)?,
        },
        _ => return Err(format!("unknown scenario {text}").into()),
    })
}

struct Args {
    server: String,
    engine: String,
    node: Option<String>,
    scenarios: Vec<Scenario>,
    uri: String,
    database: String,
    port: u16,
    seconds: u32,
    shape: Shape,
    read_buffer: usize,
    workers: Option<usize>,
    shards: Option<usize>,
    out: Option<PathBuf>,
}

fn args() -> Res<Args> {
    let mut args = Args {
        server: "rust".to_owned(),
        engine: "ts".to_owned(),
        node: None,
        scenarios: Vec::new(),
        uri: "mongodb://localhost:27017/?replicaSet=rs0".to_owned(),
        database: "canopy_s11".to_owned(),
        port: 8090,
        seconds: 10,
        shape: Shape { docs: 200_000, owners: 10_000, hot: 200 },
        read_buffer: 4096,
        workers: None,
        shards: None,
        out: None,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--server" => args.server = value,
            "--engine" => args.engine = value,
            "--node" => args.node = Some(value),
            "--scenarios" => {
                for item in value.split(',') {
                    args.scenarios.push(scenario(item.trim())?);
                }
            }
            "--uri" => args.uri = value,
            "--db" => args.database = value,
            "--port" => args.port = value.parse()?,
            "--seconds" => args.seconds = value.parse()?,
            "--docs" => args.shape.docs = value.parse()?,
            "--owners" => args.shape.owners = value.parse()?,
            "--read-buffer" => args.read_buffer = value.parse()?,
            "--workers" => args.workers = Some(value.parse()?),
            "--shards" => args.shards = Some(value.parse()?),
            "--out" => args.out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown flag {flag}").into()),
        }
    }
    if args.scenarios.is_empty() {
        args.scenarios.push(scenario("idle:1000")?);
    }
    Ok(args)
}

fn percentile(sorted: &[f32], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    f64::from(sorted[rank.saturating_sub(1).min(sorted.len() - 1)])
}

fn summary(mut values: Vec<f32>) -> serde_json::Value {
    values.sort_by(f32::total_cmp);
    serde_json::json!({
        "count": values.len(),
        "p50": percentile(&values, 50.0),
        "p90": percentile(&values, 90.0),
        "p99": percentile(&values, 99.0),
        "max": values.last().map_or(f64::NAN, |v| f64::from(*v)),
    })
}

fn plans(keys: &Keys, scenario: &Scenario) -> Vec<Plan> {
    (0..scenario.connections)
        .map(|i| match scenario.mode {
            Mode::Idle => Plan { token: keys.token(&format!("u{i}"), &[]), subs: Vec::new() },
            Mode::Owners => Plan {
                token: keys.token(&format!("u{i}"), &[]),
                subs: OWNER_SUBS
                    .iter()
                    .take(scenario.subs)
                    .enumerate()
                    .map(|(k, filter)| format!(r#"{{"t":"sub","id":"s{k}","c":"items","q":{{"filter":{filter}}}}}"#))
                    .collect(),
            },
            Mode::Hot => Plan {
                token: keys.token(&format!("v{i}"), &["viewer"]),
                subs: vec![r#"{"t":"sub","id":"s0","c":"items","q":{"filter":{"hot":true}}}"#.to_owned()],
            },
        })
        .collect()
}

/// Watches the collection without Canopy and records write to arrival latency: the part Canopy does not add.
async fn probe(client: mongodb::Client, database: String, stop: watch::Receiver<bool>) -> Res<Vec<f32>> {
    let mut stream = client.database(&database).collection::<Document>("items").watch().await?;
    let mut stop = stop;
    let mut out = Vec::new();
    loop {
        tokio::select! {
            event = stream.next() => {
                let Some(event) = event else { break };
                let event = event?;
                if let Some(ts) = event.update_description.as_ref().and_then(|d| d.updated_fields.get_f64("ts").ok()) {
                    out.push((load::now_ms() - ts) as f32);
                }
            }
            _ = stop.changed() => break,
        }
    }
    Ok(out)
}

async fn writer(args: &Args, repo: &std::path::Path, scenario: &Scenario) -> Res<serde_json::Value> {
    let script = repo.join("packages").join("realtime").join("bench").join("writer.ts");
    let docs_per_owner = args.shape.docs / args.shape.owners;
    let mode_args: Vec<String> = match scenario.mode {
        Mode::Hot => vec!["hot".into(), args.shape.hot.to_string(), "0".into(), "1".into()],
        _ => vec![
            "owners".into(),
            scenario.connections.to_string(),
            docs_per_owner.to_string(),
            args.shape.owners.to_string(),
        ],
    };
    let output = tokio::process::Command::new("bun")
        .arg(script)
        .arg(&args.uri)
        .arg(&args.database)
        .arg(scenario.rate.to_string())
        .arg(args.seconds.to_string())
        .args(mode_args)
        .current_dir(repo)
        .output()
        .await?;
    if !output.status.success() {
        return Err(format!("the writer failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn converged(
    client: &mongodb::Client,
    args: &Args,
    scenario: &Scenario,
    outcomes: &[Outcome],
) -> Res<(u64, u64)> {
    let items = client.database(&args.database).collection::<Document>("items");
    let mut cursor = items.find(doc! { "n": { "$gt": 0 } }).projection(doc! { "ownerId": 1, "hot": 1, "n": 1 }).await?;
    let mut written: Vec<(i64, String, bool, i64)> = Vec::new();
    while let Some(doc) = cursor.next().await {
        let doc = doc?;
        let id = doc.get_i32("_id").map(i64::from)?;
        let n = doc.get_i32("n").map(i64::from).or_else(|_| doc.get_i64("n"))?;
        written.push((id, doc.get_str("ownerId")?.to_owned(), doc.get_bool("hot")?, n));
    }
    let mut checked = 0;
    let mut current = 0;
    for (index, outcome) in outcomes.iter().enumerate() {
        let owner = format!("u{index}");
        for (id, owner_id, hot, n) in &written {
            let visible = match scenario.mode {
                Mode::Hot => *hot,
                _ => *owner_id == owner,
            };
            if !visible {
                continue;
            }
            checked += 1;
            if outcome.counters.get(id) == Some(n) {
                current += 1;
            }
        }
    }
    Ok((checked, current))
}

fn per_connection(before: Sample, after: Sample, connections: usize) -> serde_json::Value {
    let n = connections.max(1) as f64;
    serde_json::json!({
        "rssKiB": (after.rss as f64 - before.rss as f64) / n / 1024.0,
        "privateKiB": (after.private as f64 - before.private as f64) / n / 1024.0,
    })
}

async fn run(
    args: &Args,
    repo: &std::path::Path,
    server: &mut Server,
    keys: &Keys,
    client: &mongodb::Client,
    scenario: &Scenario,
) -> Res<serde_json::Value> {
    eprintln!("scenario {} on {}", scenario.name, server.label);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let before = server.sample();
    let plans = Arc::new(plans(keys, scenario));
    let (stop_tx, stop_rx) = watch::channel(false);
    let cursor = Arc::new(AtomicUsize::new(0));
    let readers = Arc::new(Mutex::new(Vec::new()));
    let ready_ms = Arc::new(Mutex::new(Vec::new()));
    let started = std::time::Instant::now();
    let mut openers = Vec::new();
    for _ in 0..128 {
        let (plans, cursor, readers, ready_ms, stop_rx) =
            (Arc::clone(&plans), Arc::clone(&cursor), Arc::clone(&readers), Arc::clone(&ready_ms), stop_rx.clone());
        let port = args.port;
        openers.push(tokio::spawn(async move {
            loop {
                let index = cursor.fetch_add(1, Ordering::Relaxed);
                let Some(plan) = plans.get(index) else { return Ok::<(), String>(()) };
                let (socket, outcome, ready) = load::open(port, plan).await.map_err(|e| format!("connection {index}: {e}"))?;
                ready_ms.lock().await.push(ready as f32);
                let reader = tokio::spawn(load::read(socket, outcome, stop_rx.clone()));
                readers.lock().await.push((index, reader));
            }
        }));
    }
    for opener in openers {
        opener.await??;
    }
    let open_seconds = started.elapsed().as_secs_f64();
    eprintln!("  opened {} connections in {open_seconds:.1} s", scenario.connections);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let opened = server.sample();
    let mut result = serde_json::json!({
        "scenario": scenario.name,
        "server": server.label,
        "connections": scenario.connections,
        "subscriptions": scenario.connections * scenario.subs,
        "openSeconds": open_seconds,
        "ready": summary(std::mem::take(&mut *ready_ms.lock().await)),
        "memoryPerConnection": per_connection(before, opened, scenario.connections),
        "serverRssMB": opened.rss as f64 / 1024.0 / 1024.0,
        "serverPrivateMB": opened.private as f64 / 1024.0 / 1024.0,
    });
    if scenario.mode != Mode::Idle {
        let (probe_stop_tx, probe_stop_rx) = watch::channel(false);
        let probe = tokio::spawn(probe(client.clone(), args.database.clone(), probe_stop_rx));
        tokio::time::sleep(Duration::from_millis(500)).await;
        let cpu_before = server.sample();
        let wall = std::time::Instant::now();
        let written = writer(args, repo, scenario).await?;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let cpu_after = server.sample();
        let wall = wall.elapsed().as_secs_f64();
        let _ = probe_stop_tx.send(true);
        let stream = probe.await??;
        let _ = stop_tx.send(true);
        let mut outcomes: Vec<(usize, Outcome)> = Vec::new();
        for (index, reader) in std::mem::take(&mut *readers.lock().await) {
            outcomes.push((index, reader.await?));
        }
        outcomes.sort_by_key(|(index, _)| *index);
        let outcomes: Vec<Outcome> = outcomes.into_iter().map(|(_, outcome)| outcome).collect();
        let errors: Vec<&String> = outcomes.iter().filter_map(|o| o.error.as_ref()).collect();
        let latencies: Vec<f32> = outcomes.iter().flat_map(|o| o.latencies.iter().copied()).collect();
        let (checked, current) = converged(client, args, scenario, &outcomes).await?;
        let writes = written.get("issued").and_then(serde_json::Value::as_u64).unwrap_or(0);
        let cpu_ms = cpu_after.cpu_ms.saturating_sub(cpu_before.cpu_ms) as f64;
        let deliveries = latencies.len();
        result["writes"] = serde_json::json!(writes);
        result["deliveries"] = serde_json::json!(deliveries);
        result["delivery"] = summary(latencies);
        result["stream"] = summary(stream);
        result["writerAck"] = written.get("ack").cloned().unwrap_or_default();
        result["convergence"] = serde_json::json!({ "checked": checked, "current": current });
        result["errors"] = serde_json::json!(errors.len());
        if let Some(first) = errors.first() {
            result["firstError"] = serde_json::json!(first);
        }
        result["cpuPercent"] = serde_json::json!(cpu_ms / (wall * 1000.0) * 100.0);
        result["cpuMsPerEvent"] = serde_json::json!(cpu_ms / writes.max(1) as f64);
        result["cpuUsPerDelivery"] = serde_json::json!(cpu_ms * 1000.0 / deliveries.max(1) as f64);
        result["serverRssAfterMB"] = serde_json::json!(cpu_after.rss as f64 / 1024.0 / 1024.0);
    } else {
        let _ = stop_tx.send(true);
        for (_, reader) in std::mem::take(&mut *readers.lock().await) {
            let _ = reader.await?;
        }
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    eprintln!("  {result}");
    Ok(result)
}

async fn main_async() -> Res<()> {
    let args = args()?;
    let prototype = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = prototype.join("..").join("..").join("..").canonicalize()?;
    let repo = PathBuf::from(repo.to_string_lossy().trim_start_matches(r"\\?\"));
    let client = mongodb::Client::with_uri_str(&args.uri).await?;
    setup::seed(&client, &args.database, args.shape).await?;
    let keys = Keys::new();
    let jwks = setup::serve_jwks(keys.jwks()).await?;
    let mut server = Server::start(Launch {
        kind: &args.server,
        engine: &args.engine,
        node: args.node.as_deref(),
        repo: &repo,
        prototype: &prototype,
        uri: &args.uri,
        database: &args.database,
        port: args.port,
        jwks: &jwks,
        read_buffer: args.read_buffer,
        workers: args.workers,
        shards: args.shards,
    })
    .await?;
    let mut results = Vec::new();
    let mut failure = None;
    for scenario in &args.scenarios {
        match run(&args, &repo, &mut server, &keys, &client, scenario).await {
            Ok(result) => {
                println!("{result}");
                results.push(result);
            }
            Err(error) => {
                eprintln!("  scenario {} failed: {error}", scenario.name);
                failure = Some(error);
                break;
            }
        }
        setup::seed(&client, &args.database, args.shape).await?;
    }
    server.stop().await;
    if let Some(out) = &args.out {
        let mut existing: Vec<serde_json::Value> = std::fs::read_to_string(out)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        existing.extend(results);
        std::fs::write(out, serde_json::to_string_pretty(&existing)? + "\n")?;
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn main() -> Res<()> {
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(main_async())
}
