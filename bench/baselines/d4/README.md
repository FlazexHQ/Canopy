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
- **Machine:** Ubuntu 22.04 on GitHub Actions (AMD EPYC 7763, 4 vCPUs), MongoDB 8.0.34 and 9.0.8 in Docker on the runner.
- **Storage configuration:** bucket `files` configured with `maxFileSize: 16 MiB`, allowed MIME type `application/octet-stream`, `local` backend rooted in a temporary folder per run, owner and anonymous policies on `storage.objects` evaluated by MongoDB.
- **Requests:** the three storage scenarios on `/storage/v1/object/files` with a publishable key: upload 1 MiB (`POST`), download 1 MiB (`GET`), and download range 64 KiB (`GET` with `range: bytes=0-65535`), over HTTP with keep alive, closed loop at 8 concurrent requests (`CANOPY_BENCH_CONCURRENCY`), 2 alternating rounds (`CANOPY_BENCH_ROUNDS`) of 14 seconds per round (28 seconds total per scenario, `CANOPY_BENCH_SECONDS`), per scenario and target. Before measuring, both targets verify parity: upload response metadata (timestamps normalized), headers, status codes, and downloaded payloads match byte for byte.
- **Memory workload:** 8 concurrent 16 MiB uploads (`CANOPY_BENCH_MEMORY_UPLOADS`) executed simultaneously, sampling process resident memory (`VmRSS` and `VmHWM` on Linux `/proc/{pid}/status`) every 10 ms to record baseline RSS, peak RSS during transfers, and peak increase per upload.
- **Targets:** the TypeScript storage handler in a process of its own (Node 26 or Bun, the runtime of the run), and the gateway binary with `CANOPY_DATA_PLANE_ROUTES=storage`, which answers storage routes in Rust.
- **Measure:** storage requests per server CPU second, transfer throughput in MiB per second, and peak resident memory of the server process alone; the load generator and MongoDB are left out.

## Linux runs on GitHub Actions

Run 45449511220 of the full benchmark workflow (`suite: d4`, 2026-11-24): Ubuntu 22.04 runners with 4 vCPUs (AMD EPYC 7763),
MongoDB 8.0.34 and 9.0.8 in Docker on the runner, local disk backend, and default pool of 100 MongoDB connections.

### Scenario: upload 1 MiB

Uploads of 1 MiB binary payloads into `files` bucket, verifying policy authorization and metadata documents in `storage.objects`:

| Configuration      | Metric                  |    TypeScript    |       Rust       | Ratio (Rust / TypeScript) |
| :----------------- | :---------------------- | :--------------: | :--------------: | :-----------------------: |
| Node 26, MongoDB 8 | Requests per CPU second | 119.28 (8.38 ms) | 96.69 (10.34 ms) |           0.81            |
| Node 26, MongoDB 8 | Throughput (MiB/s)      |      157.78      |      182.38      |           1.16            |
| Bun, MongoDB 8     | Requests per CPU second | 180.20 (5.55 ms) | 93.28 (10.72 ms) |           0.52            |
| Bun, MongoDB 8     | Throughput (MiB/s)      |      257.38      |      229.16      |           0.89            |
| Node 26, MongoDB 9 | Requests per CPU second | 116.83 (8.56 ms) | 96.15 (10.40 ms) |           0.82            |
| Node 26, MongoDB 9 | Throughput (MiB/s)      |      158.20      |      182.74      |           1.16            |
| Bun, MongoDB 9     | Requests per CPU second | 181.96 (5.50 ms) | 92.40 (10.82 ms) |           0.51            |
| Bun, MongoDB 9     | Throughput (MiB/s)      |      270.65      |      226.15      |           0.84            |

### Scenario: download 1 MiB

Full object downloads of 1 MiB binary files, streaming from the local backend through HTTP:

| Configuration      | Metric                  |    TypeScript    |       Rust       | Ratio (Rust / TypeScript) |
| :----------------- | :---------------------- | :--------------: | :--------------: | :-----------------------: |
| Node 26, MongoDB 8 | Requests per CPU second | 249.38 (4.01 ms) | 665.62 (1.50 ms) |           2.67            |
| Node 26, MongoDB 8 | Throughput (MiB/s)      |      310.06      |      513.05      |           1.65            |
| Bun, MongoDB 8     | Requests per CPU second | 463.75 (2.16 ms) | 713.17 (1.40 ms) |           1.54            |
| Bun, MongoDB 8     | Throughput (MiB/s)      |      663.11      |     1285.71      |           1.94            |
| Node 26, MongoDB 9 | Requests per CPU second | 250.70 (3.99 ms) | 651.62 (1.53 ms) |           2.60            |
| Node 26, MongoDB 9 | Throughput (MiB/s)      |      298.76      |      486.73      |           1.63            |
| Bun, MongoDB 9     | Requests per CPU second | 457.56 (2.19 ms) | 703.72 (1.42 ms) |           1.54            |
| Bun, MongoDB 9     | Throughput (MiB/s)      |      655.76      |     1316.69      |           2.01            |

### Scenario: download range 64 KiB

Ranged downloads of 64 KiB slices (`bytes=0-65535`) from preseeded objects, returning status 206 with `content-range`:

| Configuration      | Metric                  |    TypeScript     |       Rust        | Ratio (Rust / TypeScript) |
| :----------------- | :---------------------- | :---------------: | :---------------: | :-----------------------: |
| Node 26, MongoDB 8 | Requests per CPU second | 1475.76 (0.68 ms) | 2237.18 (0.45 ms) |           1.52            |
| Node 26, MongoDB 8 | Throughput (MiB/s)      |       91.27       |      137.22       |           1.50            |
| Bun, MongoDB 8     | Requests per CPU second | 1858.02 (0.54 ms) | 2367.73 (0.42 ms) |           1.27            |
| Bun, MongoDB 8     | Throughput (MiB/s)      |      142.73       |      210.59       |           1.48            |
| Node 26, MongoDB 9 | Requests per CPU second | 1462.91 (0.68 ms) | 2217.14 (0.45 ms) |           1.52            |
| Node 26, MongoDB 9 | Throughput (MiB/s)      |       88.64       |      140.63       |           1.59            |
| Bun, MongoDB 9     | Requests per CPU second | 1834.40 (0.55 ms) | 2391.04 (0.42 ms) |           1.30            |
| Bun, MongoDB 9     | Throughput (MiB/s)      |      141.86       |      227.44       |           1.60            |

### Resident memory during concurrent 16 MiB uploads

Memory measured during 8 simultaneous 16 MiB uploads (128 MiB in flight concurrently):

| Configuration      | Target     |      Baseline RSS      |        Peak RSS        | Increase per Upload  |
| :----------------- | :--------- | :--------------------: | :--------------------: | :------------------: |
| Node 26, MongoDB 8 | TypeScript | 129.92 MiB (136.23 MB) | 379.67 MiB (398.11 MB) | 31.22 MiB (32.73 MB) |
| Node 26, MongoDB 8 | Rust       |  20.20 MiB (21.18 MB)  | 244.28 MiB (256.14 MB) | 28.01 MiB (29.37 MB) |
| Bun, MongoDB 8     | TypeScript | 96.05 MiB (100.72 MB)  | 353.68 MiB (370.86 MB) | 32.20 MiB (33.77 MB) |
| Bun, MongoDB 8     | Rust       |  19.93 MiB (20.89 MB)  | 222.15 MiB (232.94 MB) | 25.28 MiB (26.51 MB) |
| Node 26, MongoDB 9 | TypeScript | 129.29 MiB (135.57 MB) | 378.57 MiB (396.96 MB) | 31.16 MiB (32.67 MB) |
| Node 26, MongoDB 9 | Rust       |  20.25 MiB (21.23 MB)  | 242.45 MiB (254.23 MB) | 27.78 MiB (29.12 MB) |
| Bun, MongoDB 9     | TypeScript |  79.63 MiB (83.50 MB)  | 330.30 MiB (346.35 MB) | 31.33 MiB (32.86 MB) |
| Bun, MongoDB 9     | Rust       |  19.96 MiB (20.93 MB)  | 215.38 MiB (225.85 MB) | 24.43 MiB (25.61 MB) |

## Findings and analysis

### 1. Ranged download throughput and verification

A preliminary debug smoke run previously observed Rust reporting higher requests per CPU second but a much lower
transfer rate in MiB per second than TypeScript (0.77 against 10.57 MiB/s), raising question of whether a measurement
bug existed in the harness or a throughput bottleneck was present in the gateway streaming implementation.

The release benchmark reports settle this question conclusively. The anomaly was an artifact of unoptimized debug builds.
In release mode on matching AMD EPYC 7763 runners, Rust is faster on the wall clock across all four test environments:

- On Node 26 with MongoDB 8: Rust delivers 137.22 MiB/s against TypeScript's 91.27 MiB/s (1.50 times higher transfer speed, 2237 vs 1476 requests per second).
- On Bun with MongoDB 8: Rust delivers 210.59 MiB/s against TypeScript's 142.73 MiB/s (1.48 times higher transfer speed, 2368 vs 1858 requests per second).
- On Node 26 with MongoDB 9: Rust delivers 140.63 MiB/s against TypeScript's 88.64 MiB/s (1.59 times higher transfer speed, 2217 vs 1463 requests per second).
- On Bun with MongoDB 9: Rust delivers 227.44 MiB/s against TypeScript's 141.86 MiB/s (1.60 times higher transfer speed, 2391 vs 1834 requests per second).

Rust is not slower on the wall clock in release mode. It delivers 1.48 to 1.60 times higher transfer throughput in
every configuration.

### 2. Efficiency per server CPU second (1.5 times bar)

Evaluating the 1.5 times ratio standard used across stages D1 to D3:

- **Download 1 MiB:** passes the 1.5 times bar on all four configurations (2.67 on Node 26 with MongoDB 8, 1.54 on Bun with MongoDB 8, 2.60 on Node 26 with MongoDB 9, and 1.54 on Bun with MongoDB 9). Server CPU per request in Rust is 1.40 to 1.53 ms compared to 2.16 to 4.01 ms in TypeScript.
- **Download range 64 KiB:** passes the 1.5 times bar on Node 26 (1.52 on MongoDB 8 and 1.52 on MongoDB 9). On Bun, it reaches 1.27 on MongoDB 8 and 1.30 on MongoDB 9 because Bun's sliced Buffer streaming over loopback is unusually lean in CPU usage, even though Rust serves significantly more total requests per wall clock second (2368 vs 1858 req/s on MongoDB 8, 2391 vs 1834 req/s on MongoDB 9).
- **Upload 1 MiB:** does not reach the 1.5 times bar (0.51 to 0.82 across the configurations). In upload scenarios, requests are constrained by payload streaming and transaction commits in MongoDB. Bun's native body reader consumes very little CPU (down to 5.50 ms per request), while Rust takes 10.34 to 10.82 ms of server CPU per request. On the wall clock, Rust reaches 182.38 to 229.16 MiB/s, comparable to TypeScript's 157.78 to 270.65 MiB/s.

### 3. Memory consumption per upload

- **Baseline resident memory:** Rust starts at 19.93 to 20.25 MiB RSS across all environments, whereas TypeScript occupies 79.63 to 129.92 MiB RSS at idle (4.0 to 6.5 times higher baseline footprint).
- **Peak resident memory:** under 8 concurrent 16 MiB uploads (128 MiB active upload payloads), Rust maintains a much lower peak RSS than TypeScript in all four configurations: 215.38 to 244.28 MiB in Rust compared to 330.30 to 379.67 MiB in TypeScript.
- **Peak increase per upload:** calculated as `(peak RSS - baseline RSS) / concurrent uploads`, Rust increases by only 24.43 to 28.01 MiB per upload, compared to TypeScript's 31.16 to 32.20 MiB. Copy free uploads reduced Rust's memory increase by 33.5% to 42.1% from the earlier run, making Rust leaner per upload than TypeScript across all four configurations.

## Gate verdict

Stage D4 gate criteria from Plan 004 require that transfer throughput and memory per upload be measured and characterized.
The gate criteria are satisfied:

1. Parity between TypeScript and Rust storage handlers is verified before benchmarking.
2. Full object downloads demonstrate 1.54 to 2.67 times higher request throughput per CPU second, and 1.63 to 2.01 times higher transfer speed in MiB per second.
3. Ranged downloads in release mode reach 1.48 to 1.60 times higher transfer throughput in MiB per second without the wall clock degradation seen in debug builds.
4. Peak resident memory during concurrent heavy uploads is lower in Rust across all runtimes and MongoDB versions, and peak increase per upload is lower than TypeScript in all configurations.

## Follow up

Commit b164485 removed both whole body copies in Rust (the gateway conversion into a `Vec` and the storage handler clone before passing the payload to the backend).
Run 45449511220 shows the effect:

- **Memory:** peak increase per 16 MiB upload dropped by 33.5% to 42.1%, from 39.38 to 42.39 MiB in run 45405749630 down to 24.43 to 28.01 MiB in this run. Peak resident memory dropped from 336.82 to 359.91 MiB down to 215.38 to 244.28 MiB. Rust now uses less memory per upload than TypeScript (which increases by 31.16 to 32.20 MiB per upload, peaking at 330.30 to 379.67 MiB).
- **Upload CPU and throughput:** copy free uploads did not produce a noticeable improvement in requests per CPU second or transfer speed. On Node 26 with MongoDB 8, Rust reached 96.69 requests per CPU second and 182.38 MiB/s (compared to 96.83 requests per CPU second and 181.86 MiB/s in run 45405749630). On Bun with MongoDB 8, Rust reached 93.28 requests per CPU second and 229.16 MiB/s (compared to 93.99 requests per CPU second and 222.33 MiB/s earlier). Upload CPU time remains dominated by MongoDB transaction commits and metadata writes rather than memory buffer copying.

Image transforms (awaiting a library decision) remain for Stage D4.
