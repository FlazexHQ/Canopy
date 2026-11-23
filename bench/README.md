# bench

Benchmark workloads, the committed baselines their gates compare against, and the spike prototypes. This is
code, not documentation; the write ups live in `docs/spikes/`. The folder is the private workspace package
`@canopy/bench`, so workloads import the packages they measure by name (`@canopy/rest`, `@canopy/matcher`,
`@canopy/realtime`, `@canopy/native`) and run on the `@canopy/source` condition without a build.

```
bench/
  workloads/
    d1/         the D1 gate of find: Rust and TypeScript over HTTP, requests per server CPU second
    d0/         the D0 baseline: per request commands, bytes, pool waits, plans, CPU and allocation (REST and fan out)
    matcher/    compiled matcher against hand written predicates, and per change event cost (Rust against TypeScript)
    realtime/   in process fan out, the plain change stream probe, the writer and the comparison of two runs
    rest/       write path cost, read and write scale tiers, base against head comparison, native read codec
    wire/       MongoDB wire protocol probes (S13), with Go, Java and Python driver harnesses
  baselines/    committed baselines: matcher/, realtime/ and rest/, d0/ and d1/ (the recorded D0 and D1 reports)
  spikes/       standalone prototypes of the spikes: S8 (Node), S11 and S12 (Cargo projects with their own workspace)
```

## Running

Run these from the repository root after `bun install`. Every workload that talks to MongoDB needs a replica
set (`bun run db:up`) and reads its address from `CANOPY_BENCH_MONGODB_URI` or `CANOPY_TEST_MONGODB_URI`.
Environment variables such as `CANOPY_BENCH_OUT`, `CANOPY_BENCH_DOCS` and `CANOPY_BENCH_SECONDS` are described
in the header comment of each file.

| Command                                                        | Workload                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bun --filter @canopy/bench matcher`                           | Matcher throughput (no MongoDB)                                      |
| `bun --filter @canopy/bench matcher:events`                    | Matcher cost per change event, Rust against TypeScript (no MongoDB)  |
| `bun --filter @canopy/bench realtime`                          | In process fan out                                                   |
| `bun --filter @canopy/bench rest`                              | REST write path cost                                                 |
| `bun --filter @canopy/bench d0`                                | D0 baseline report (see below)                                       |
| `bun --filter @canopy/bench d1`                                | D1 gate: `find` in Rust against the TypeScript route, per server CPU |
| `bun --filter @canopy/bench rest:scale`                        | REST reads and writes at the document count tiers                    |
| `bun --filter @canopy/bench rest:compare -- --base <checkout>` | Two checkouts measured side by side                                  |
| `bun --filter @canopy/bench wire`                              | MongoDB wire protocol drivers (needs the `s13-wire` example binary)  |

## D0 baseline

`d0` measures the TypeScript REST read and write paths (real `Request` objects into the REST handler) and the
realtime fan out, each next to the plain driver where one exists. Per scenario it records throughput, p50, p95
and p99, MongoDB commands per request by name, bytes in and out per request (corrected for its own
`serverStatus` calls and for idle background traffic), connection pool check out waits, client CPU and
allocation per request, garbage collections, and the winning plan and documents examined of every read
from `explain`. It also records the target: MongoDB version, topology, round trip, runtime, OS and CPU.

```sh
CANOPY_BENCH_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" CANOPY_BENCH_OUT=d0.json bun --filter @canopy/bench d0
```

For Atlas use a `mongodb+srv://` URI and record the cluster with `CANOPY_BENCH_TIER` and `CANOPY_BENCH_REGION`. The
variables are listed in the header comment of `workloads/d0/run.ts`; the pure aggregation helpers have unit tests
(`bun --filter @canopy/bench test`). The recorded reports and their findings are in `baselines/d0/`.

## Gates

A gate compares ratios measured in one run with a baseline, so the speed of the machine does not matter.

```sh
node packages/testing/scripts/bench-gate.ts <results.json>... --baseline bench/baselines/matcher/event-baseline.json
node bench/workloads/rest/check.ts <results.json>           # baseline: bench/baselines/rest/baseline.json
```

Write a new baseline with `--write-baseline <file>` (both scripts). The `Benchmarks` and `Full benchmark`
workflows in `.github/workflows/` run the same commands.

## Spikes

`spikes/S11` and `spikes/S12` are Cargo projects outside the root Cargo workspace (each has its own
`[workspace]` table and `Cargo.lock`); build them with `cargo build --release --manifest-path bench/spikes/S11/Cargo.toml`.
`spikes/S8` is a Node project that is not part of the Bun workspace: run `npm install` there first.
