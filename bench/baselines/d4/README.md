# D4 gate: file storage in Rust against the TypeScript routes

Stage D4 of [plan 004](../../../docs/plans/004-rust-data-plane.md#5-stages) characterizes file storage in the
Rust data plane against the TypeScript routes, measuring transfer throughput and memory consumption during concurrent
uploads. The Linux runs on GitHub Actions below record the measurements across Node 26 and Bun with MongoDB 8 and 9.

Raw reports of the Linux runs: [`ci-linux-node26-mongo8.json`](ci-linux-node26-mongo8.json),
[`ci-linux-bun-mongo8.json`](ci-linux-bun-mongo8.json), [`ci-linux-node26-mongo9.json`](ci-linux-node26-mongo9.json)
and [`ci-linux-bun-mongo9.json`](ci-linux-bun-mongo9.json), from the `d4` job of the full benchmark workflow
(`.github/workflows/bench-full.yml`, `suite: d4`).

## Method

- **Workload:** [`bench/workloads/d4/storage.ts`](../../workloads/d4/storage.ts) (`bun --filter @canopy/bench d4`).
- **Machine:** Ubuntu 22.04 on GitHub Actions (AMD EPYC 7763 on MongoDB 8 runner, AMD EPYC 9V45 on MongoDB 9 runner, 4 vCPUs), MongoDB 8.0.34 and 9.0.8 in Docker on the runner.
- **Storage configuration:** bucket `files` configured with `maxFileSize: 16 MiB`, allowed MIME type `application/octet-stream`, `local` backend rooted in a temporary folder per run, owner and anonymous policies on `storage.objects` evaluated by MongoDB.
- **Requests:** the three storage scenarios on `/storage/v1/object/files` with a publishable key: upload 1 MiB (`POST`), download 1 MiB (`GET`), and download range 64 KiB (`GET` with `range: bytes=0-65535`), over HTTP with keep alive, closed loop at 8 concurrent requests (`CANOPY_BENCH_CONCURRENCY`), 2 alternating rounds (`CANOPY_BENCH_ROUNDS`) of 14 seconds per round (28 seconds total per scenario, `CANOPY_BENCH_SECONDS`), per scenario and target. Before measuring, both targets verify parity: upload response metadata (timestamps normalized), headers, status codes, and downloaded payloads match byte for byte.
- **Memory workload:** 8 concurrent 16 MiB uploads (`CANOPY_BENCH_MEMORY_UPLOADS`) executed simultaneously, sampling process resident memory (`VmRSS` and `VmHWM` on Linux `/proc/{pid}/status`) every 10 ms to record baseline RSS, peak RSS during transfers, and peak increase per upload.
- **Targets:** the TypeScript storage handler in a process of its own (Node 26 or Bun, the runtime of the run), and the gateway binary with `CANOPY_DATA_PLANE_ROUTES=storage`, which answers storage routes in Rust.
- **Measure:** storage requests per server CPU second, transfer throughput in MiB per second, and peak resident memory of the server process alone; the load generator and MongoDB are left out.

## Linux runs on GitHub Actions

Run 45405749630 of the full benchmark workflow (`suite: d4`, 2026-11-24): Ubuntu 22.04 runners with 4 vCPUs,
MongoDB 8.0.34 and 9.0.8 in Docker on the runner, local disk backend, and default pool of 100 MongoDB connections.

### Scenario: upload 1 MiB

Uploads of 1 MiB binary payloads into `files` bucket, verifying policy authorization and metadata documents in `storage.objects`:

| Configuration      | Metric                  |    TypeScript    |       Rust       | Ratio (Rust / TypeScript) |
| :----------------- | :---------------------- | :--------------: | :--------------: | :-----------------------: |
| Node 26, MongoDB 8 | Requests per CPU second | 115.85 (8.63 ms) | 96.83 (10.33 ms) |           0.84            |
| Node 26, MongoDB 8 | Throughput (MiB/s)      |      156.52      |      181.86      |           1.16            |
| Bun, MongoDB 8     | Requests per CPU second | 181.00 (5.52 ms) | 93.99 (10.64 ms) |           0.52            |
| Bun, MongoDB 8     | Throughput (MiB/s)      |      266.41      |      222.33      |           0.83            |
| Node 26, MongoDB 9 | Requests per CPU second | 189.10 (5.29 ms) | 192.84 (5.19 ms) |           1.02            |
| Node 26, MongoDB 9 | Throughput (MiB/s)      |      157.73      |      178.79      |           1.13            |
| Bun, MongoDB 9     | Requests per CPU second | 355.56 (2.81 ms) | 194.22 (5.15 ms) |           0.55            |
| Bun, MongoDB 9     | Throughput (MiB/s)      |      188.98      |      187.00      |           0.99            |

### Scenario: download 1 MiB

Full object downloads of 1 MiB binary files, streaming from the local backend through HTTP:

| Configuration      | Metric                  |    TypeScript     |       Rust        | Ratio (Rust / TypeScript) |
| :----------------- | :---------------------- | :---------------: | :---------------: | :-----------------------: |
| Node 26, MongoDB 8 | Requests per CPU second | 257.61 (3.88 ms)  | 649.98 (1.54 ms)  |           2.52            |
| Node 26, MongoDB 8 | Throughput (MiB/s)      |      314.67       |      484.08       |           1.54            |
| Bun, MongoDB 8     | Requests per CPU second | 463.21 (2.16 ms)  | 707.26 (1.41 ms)  |           1.53            |
| Bun, MongoDB 8     | Throughput (MiB/s)      |      662.08       |      1276.72      |           1.93            |
| Node 26, MongoDB 9 | Requests per CPU second | 510.62 (1.96 ms)  | 1686.87 (0.59 ms) |           3.30            |
| Node 26, MongoDB 9 | Throughput (MiB/s)      |      663.85       |      1321.48      |           1.99            |
| Bun, MongoDB 9     | Requests per CPU second | 1236.92 (0.81 ms) | 2219.85 (0.45 ms) |           1.79            |
| Bun, MongoDB 9     | Throughput (MiB/s)      |      1728.78      |      3506.92      |           2.03            |

### Scenario: download range 64 KiB

Ranged downloads of 64 KiB slices (`bytes=0-65535`) from preseeded objects, returning status 206 with `content-range`:

| Configuration      | Metric                  |    TypeScript     |       Rust        | Ratio (Rust / TypeScript) |
| :----------------- | :---------------------- | :---------------: | :---------------: | :-----------------------: |
| Node 26, MongoDB 8 | Requests per CPU second | 1442.10 (0.69 ms) | 2210.27 (0.45 ms) |           1.53            |
| Node 26, MongoDB 8 | Throughput (MiB/s)      |       87.99       |      134.52       |           1.53            |
| Bun, MongoDB 8     | Requests per CPU second | 1844.91 (0.54 ms) | 2346.51 (0.43 ms) |           1.27            |
| Bun, MongoDB 8     | Throughput (MiB/s)      |      141.85       |      208.52       |           1.47            |
| Node 26, MongoDB 9 | Requests per CPU second | 3621.30 (0.28 ms) | 6007.84 (0.17 ms) |           1.66            |
| Node 26, MongoDB 9 | Throughput (MiB/s)      |      209.50       |      324.78       |           1.55            |
| Bun, MongoDB 9     | Requests per CPU second | 4809.29 (0.21 ms) | 6996.60 (0.14 ms) |           1.45            |
| Bun, MongoDB 9     | Throughput (MiB/s)      |      359.26       |      597.18       |           1.66            |

### Resident memory during concurrent 16 MiB uploads

Memory measured during 8 simultaneous 16 MiB uploads (128 MiB in flight concurrently):

| Configuration      | Target     |      Baseline RSS      |        Peak RSS        | Increase per Upload  |
| :----------------- | :--------- | :--------------------: | :--------------------: | :------------------: |
| Node 26, MongoDB 8 | TypeScript | 130.30 MiB (136.63 MB) | 380.55 MiB (399.04 MB) | 31.28 MiB (32.80 MB) |
| Node 26, MongoDB 8 | Rust       |  18.21 MiB (19.09 MB)  | 355.31 MiB (372.57 MB) | 42.14 MiB (44.18 MB) |
| Bun, MongoDB 8     | TypeScript | 97.11 MiB (101.83 MB)  | 347.86 MiB (364.75 MB) | 31.34 MiB (32.87 MB) |
| Bun, MongoDB 8     | Rust       |  21.75 MiB (22.81 MB)  | 336.82 MiB (353.18 MB) | 39.38 MiB (41.30 MB) |
| Node 26, MongoDB 9 | TypeScript | 131.63 MiB (138.02 MB) | 412.35 MiB (432.38 MB) | 35.09 MiB (36.79 MB) |
| Node 26, MongoDB 9 | Rust       |  20.83 MiB (21.84 MB)  | 359.91 MiB (377.39 MB) | 42.39 MiB (44.44 MB) |
| Bun, MongoDB 9     | TypeScript | 99.49 MiB (104.33 MB)  | 357.45 MiB (374.81 MB) | 32.24 MiB (33.81 MB) |
| Bun, MongoDB 9     | Rust       |  18.26 MiB (19.14 MB)  | 355.51 MiB (372.78 MB) | 42.16 MiB (44.20 MB) |

## Findings and analysis

### 1. Ranged download throughput and verification

A preliminary debug smoke run previously observed Rust reporting higher requests per CPU second but a much lower
transfer rate in MiB per second than TypeScript (0.77 against 10.57 MiB/s), raising question of whether a measurement
bug existed in the harness or a throughput bottleneck was present in the gateway streaming implementation.

The release benchmark reports settle this question conclusively. The anomaly was an artifact of unoptimized debug builds.
In release mode, Rust is faster on the wall clock across all four test environments:

- On Node 26 with MongoDB 8: Rust delivers 134.52 MiB/s against TypeScript's 87.99 MiB/s (1.53 times higher transfer speed, 2152 vs 1408 requests per second).
- On Bun with MongoDB 8: Rust delivers 208.52 MiB/s against TypeScript's 141.85 MiB/s (1.47 times higher transfer speed, 3336 vs 2270 requests per second).
- On Node 26 with MongoDB 9: Rust delivers 324.78 MiB/s against TypeScript's 209.50 MiB/s (1.55 times higher transfer speed, 5196 vs 3352 requests per second).
- On Bun with MongoDB 9: Rust delivers 597.18 MiB/s against TypeScript's 359.26 MiB/s (1.66 times higher transfer speed, 9555 vs 5748 requests per second).

Rust is not slower on the wall clock in release mode. It delivers 1.47 to 1.66 times higher transfer throughput in
every configuration.

### 2. Efficiency per server CPU second (1.5 times bar)

Evaluating the 1.5 times ratio standard used across stages D1 to D3:

- **Download 1 MiB:** passes the 1.5 times bar on all four configurations (2.52 on Node 26 with MongoDB 8, 1.53 on Bun with MongoDB 8, 3.30 on Node 26 with MongoDB 9, and 1.79 on Bun with MongoDB 9). Server CPU per request in Rust is 0.45 to 1.54 ms compared to 0.81 to 3.88 ms in TypeScript.
- **Download range 64 KiB:** passes the 1.5 times bar on Node 26 (1.53 on MongoDB 8 and 1.66 on MongoDB 9). On Bun, it falls slightly short of the 1.5 times bar (1.27 on MongoDB 8 and 1.45 on MongoDB 9) because Bun's sliced Buffer streaming over loopback is unusually lean in CPU usage, even though Rust serves significantly more total requests per wall clock second (9555 vs 5748 req/s on MongoDB 9).
- **Upload 1 MiB:** does not reach the 1.5 times bar (0.52 to 1.02 across the configurations). In upload scenarios, requests are constrained by payload streaming and transaction commits in MongoDB. Bun's native body reader consumes very little CPU (down to 2.81 ms per request), while Rust takes 5.15 to 10.64 ms of server CPU per request. On the wall clock, Rust reaches 178.79 to 222.33 MiB/s, comparable to TypeScript's 156.52 to 266.41 MiB/s.

### 3. Memory consumption per upload

- **Baseline resident memory:** Rust starts at 18.21 to 21.75 MiB RSS across all environments, whereas TypeScript occupies 97.11 to 131.63 MiB RSS at idle (4.5 to 7.2 times higher baseline footprint).
- **Peak resident memory:** under 8 concurrent 16 MiB uploads (128 MiB active upload payloads), Rust maintains a lower peak RSS than TypeScript in all four configurations: 336.82 to 359.91 MiB in Rust compared to 347.86 to 412.35 MiB in TypeScript.
- **Peak increase per upload:** calculated as `(peak RSS - baseline RSS) / concurrent uploads`, Rust increases by 39.38 to 42.39 MiB per upload, compared to TypeScript's 31.28 to 36.79 MiB. Because TypeScript starts from a much larger preallocated runtime baseline, its incremental delta is smaller, but its overall peak memory ceiling remains higher than Rust.

## Gate verdict

Stage D4 gate criteria from Plan 004 require that transfer throughput and memory per upload be measured and characterized.
The gate criteria are satisfied:

1. Parity between TypeScript and Rust storage handlers is verified before benchmarking.
2. Full object downloads demonstrate 1.53 to 3.30 times higher request throughput per CPU second, and 1.54 to 2.03 times higher transfer speed in MiB per second.
3. Ranged downloads in release mode reach 1.47 to 1.66 times higher transfer throughput in MiB per second without the wall clock degradation seen in debug builds.
4. Peak resident memory during concurrent heavy uploads is lower in Rust across all runtimes and MongoDB versions.

## Follow up

Uploads still copy the whole body twice in Rust: the gateway turns the collected body into a `Vec`, and the
storage handler clones it before handing it to the backend. That is why the peak increase per upload is higher
than in TypeScript, and part of why 1 MiB uploads cost more server CPU. Removing both copies, then rerunning this
suite, is tracked in the plan 004 context.
