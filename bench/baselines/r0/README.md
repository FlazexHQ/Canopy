# R0 Baselines: TypeScript Core in Canopy.js

Stage R0 of [plan 005](../../../docs/plans/005-all-server-code-in-rust.md#7-the-wasm-core-in-canopyjs-bundle-and-startup-gate) records bundle size, browser startup, and matcher throughput baselines for the TypeScript core in `canopy.js`. The Rust WebAssembly core in stage R2 will be evaluated against these measurements.

Raw values are recorded in [`baseline.json`](./baseline.json).

## Environment

| Component  | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| OS         | Windows 11 (10.0.26300)                                      |
| CPU        | AMD Ryzen 5 5600H with Radeon Graphics (6 cores, 12 threads) |
| Bun        | 1.4.5                                                        |
| Node.js    | v26.12.1                                                     |
| Playwright | 1.64.1                                                       |
| Chromium   | 156.0.8078.4                                                 |
| MongoDB    | 8.0.34 single member replica set on port 37017               |

## 1. Root Entry Size

A production build of a minimal browser application that imports `canopy.js` and runs one live query against the `notes` collection (`bench/baselines/r0/app/main.ts`), bundled using `bun build --minify --target=browser`.

| Bundle                                      | Raw (bytes) | Gzip (bytes) | Brotli (bytes) | Raw (KB) | Gzip (KB) | Brotli (KB) |
| ------------------------------------------- | ----------: | -----------: | -------------: | -------: | --------: | ----------: |
| `canopy.js` live query app (instrumented)   |      92,194 |       29,483 |         26,357 |    92.19 |     29.48 |       26.36 |
| `canopy.js` live query app (uninstrumented) |      91,890 |       29,413 |         26,299 |    91.89 |     29.41 |       26.30 |

The stage R2 gate allows at most 60 KB Brotli growth over this baseline for the client root entry.

## 2. Core Module Sizes

Each entry point was bundled with `bun build --minify --target=browser`. Sizes are reported raw, gzip level 9, and brotli max quality.

| Entry Point                | Source / Target                          | Raw (bytes) | Gzip (bytes) | Brotli (bytes) |
| -------------------------- | ---------------------------------------- | ----------: | -----------: | -------------: |
| `canopy.js/policy`         | Policy builders, DSL, compiler           |     102,512 |       32,935 |         29,081 |
| `canopy.js/schema`         | Schema definitions and builders          |      17,640 |        6,415 |          5,665 |
| `canopy.js/config`         | Config definition and resolution helpers |      46,805 |       16,118 |         14,331 |
| `canopy.js/matcher` (full) | Complete in memory matcher with regex    |      55,890 |       18,507 |         16,536 |
| `canopy.js/matcher` (lite) | Browser client matcher without regex     |      28,323 |        9,670 |          8,658 |
| `canopy.js/query`          | Canonical query utilities                |      52,552 |       17,441 |         15,461 |
| `canopy.js/ejson`          | EJSON codec                              |      14,764 |        5,309 |          4,692 |
| `canopy.js/protocol`       | Wire protocol, diagnostic types, EJSON   |      35,701 |       12,810 |         11,314 |

## 3. Browser Startup

Measured in headless Chromium through Playwright with 4x CPU slowdown applied via the Chrome DevTools Protocol (`Emulation.setCPUThrottlingRate: 4`), simulating a mid range mobile device profile. The Canopy server was started via `bun run dev` pointing at the replica set on port 37017. 20 consecutive runs were recorded.

The module evaluation metric measures elapsed time from inline script execution start to the entry module body starting execution. In the TypeScript baseline below, the first snapshot and the first `ready` state coincide. The current app records both times from script start, and the [R2 startup benchmark](../r2/README.md#canopyjs-adoption) uses the first snapshot for the gate.

| Metric                                  | Median (ms) | p95 (ms) | Min (ms) | Max (ms) |
| --------------------------------------- | ----------: | -------: | -------: | -------: |
| Script start to module evaluated        |       12.90 |    75.20 |     8.30 |    75.20 |
| Script start to first live query result |      172.80 |   341.40 |   155.70 |   341.40 |

### Individual Run Details

| Run | Module Evaluated (ms) | First Live Query Result (ms) |
| --- | --------------------: | ---------------------------: |
| 1   |                 55.00 |                       341.40 |
| 2   |                 15.80 |                       287.60 |
| 3   |                 13.10 |                       199.30 |
| 4   |                 66.90 |                       169.50 |
| 5   |                 10.80 |                       173.10 |
| 6   |                  8.30 |                       175.20 |
| 7   |                 12.70 |                       161.30 |
| 8   |                 57.30 |                       155.70 |
| 9   |                 11.90 |                       171.90 |
| 10  |                  9.40 |                       168.00 |
| 11  |                 10.50 |                       175.50 |
| 12  |                 56.60 |                       158.90 |
| 13  |                 12.60 |                       182.50 |
| 14  |                  9.80 |                       165.00 |
| 15  |                  9.60 |                       172.50 |
| 16  |                 60.10 |                       159.50 |
| 17  |                 60.50 |                       159.90 |
| 18  |                 11.10 |                       180.10 |
| 19  |                 64.20 |                       193.30 |
| 20  |                 75.20 |                       208.00 |

## 4. Matcher Throughput

### Conformance Filters

Measured over all valid filter cases in `conformance/matcher/filters.json` against the 300 conformance documents (597,300 document evaluations per pass for the 1,991 full filters; 351,900 document evaluations per pass for the 1,173 lite filters). Evaluated in Node 26 (`fnm exec --using=26`) and Bun.

| Suite        | Runtime | Filter Cases | Evaluations / Pass | Matched Documents | Documents / sec | ns / doc |
| ------------ | ------- | -----------: | -----------------: | ----------------: | --------------: | -------: |
| Full matcher | Node 26 |        1,991 |            597,300 |           102,816 |       7,860,845 |   127.21 |
| Full matcher | Bun     |        1,991 |            597,300 |           102,816 |       5,777,484 |   173.09 |
| Lite matcher | Node 26 |        1,173 |            351,900 |            50,923 |       9,430,347 |   106.04 |
| Lite matcher | Bun     |        1,173 |            351,900 |            50,923 |       7,898,476 |   126.61 |

### Standard Scenarios (1,000 Documents)

Measured over the six benchmark filter scenarios defined in `bench/workloads/matcher/scenarios.ts` against 1,000 documents, matching the profile specified in plan 005 §7.

| Scenario               | Node 26 docs/s | Node 26 ns/doc | Bun docs/s | Bun ns/doc |
| ---------------------- | -------------: | -------------: | ---------: | ---------: |
| `equality (DLS owner)` |     13,440,860 |          74.40 | 10,638,298 |      94.00 |
| `range and $in`        |      2,154,244 |         464.20 |  1,127,269 |     887.10 |
| `$or of 3 branches`    |      2,269,632 |         440.60 |  2,377,556 |     420.60 |
| `dotted path`          |      5,780,347 |         173.00 |  3,448,276 |     290.00 |
| `$elemMatch`           |      3,837,299 |         260.60 |  2,838,490 |     352.30 |
| `DLS and user filter`  |     14,164,306 |          70.60 | 11,454,754 |      87.30 |

## Method and Reproducibility

1. Bundle sizes were measured by compiling entry points with `bun build --minify --target=browser`, compressing outputs with zlib gzip (level 9) and brotli (maximum quality 11).
2. Startup times were collected by serving the bundled app over local HTTP, launching headless Chromium with 4x CPU slowdown via Chrome DevTools Protocol, connecting to the Canopy dev server on port 3000 backed by MongoDB replica set on port 37017, and recording timestamps via `performance.now()`.
3. Matcher throughput was measured by pre compiling filters, warming JIT tiers, and executing timed passes over all document sets.
