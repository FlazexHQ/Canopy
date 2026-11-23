//! Spike S12: checks that the official Rust driver gives the native realtime gateway what the snapshot,
//! change stream and echo before ack designs rely on.
//!
//!   cargo run --release -- checks --uri <uri>
//!   cargo run --release -- s2 --uri <uri> --runs 10000 --lanes 4 --seed 1
//!   cargo run --release -- bench --uri <uri>

mod bench;
mod checks;
mod common;
mod s2;

use std::collections::HashMap;
use std::process::ExitCode;

use mongodb::Client;

use crate::common::Res;

fn parse_args() -> Res<(String, HashMap<String, String>)> {
    let mut args = std::env::args().skip(1);
    let command = args.next().map_or_else(|| common::fail("usage: s12 <checks|s2|bench> --uri <uri>"), Ok)?;
    let mut options = HashMap::new();
    while let Some(name) = args.next() {
        let Some(key) = name.strip_prefix("--") else {
            return common::fail(format!("unexpected argument {name}"));
        };
        let value = args.next().map_or_else(|| common::fail(format!("{name} needs a value")), Ok)?;
        options.insert(key.to_owned(), value);
    }
    Ok((command, options))
}

fn number(options: &HashMap<String, String>, key: &str, default: u64) -> Res<u64> {
    options.get(key).map_or(Ok(default), |text| Ok(text.parse()?))
}

async fn run() -> Res<bool> {
    let (command, options) = parse_args()?;
    let uri =
        options.get("uri").cloned().unwrap_or_else(|| "mongodb://localhost:27217/?replicaSet=rs0".to_owned());
    let client = Client::with_uri_str(&uri).await?;
    match command.as_str() {
        "checks" => Ok(checks::run(client).await? == 0),
        "s2" => {
            let summary = s2::run(
                client,
                s2::Options {
                    runs: number(&options, "runs", 100)?,
                    lanes: number(&options, "lanes", 4)? as usize,
                    seed: number(&options, "seed", 1)?,
                    fault: options.get("fault").cloned(),
                },
            )
            .await?;
            Ok(summary)
        }
        "bench" => {
            bench::run(client, number(&options, "events", 5000)? as usize).await?;
            Ok(true)
        }
        other => common::fail(format!("unknown command {other}")),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
