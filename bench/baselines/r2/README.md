# R2 Wasm measurements

**The client module size and compile plus instantiate gates pass.** The workspace build is
81,704 Brotli bytes against the 81,920 byte limit. Chromium at 4× CPU slowdown measured
8.85 ms median and 21.60 ms p95 over 50 streaming runs against the 30 ms limit.
The scratch build independently reached 81,873 bytes and 21.70 ms p95.
[Gate and thresholds](../../../docs/plans/005-all-server-code-in-rust.md#7-the-wasm-core-in-canopyjs-bundle-and-startup-gate)

## Build and replay

Install the workspace dependencies with Bun. Put `wasm-opt` and `wasm2js` from Binaryen version 133
on PATH, or set `CANOPY_WASM_OPT` and `CANOPY_WASM2JS` to their absolute paths. CI can download the
platform archive from the pinned official release, check its SHA-256 against the release asset
digest, extract it and add its `bin` directory to PATH before invoking the split build. Binaryen
is an Apache 2.0 build tool. The generated modules have no Binaryen runtime dependency.
[Binaryen version 133 release](https://github.com/WebAssembly/binaryen/releases/tag/version_133)

```sh
bun --filter @canopy/wasm build:native --split
bun bench/baselines/r2/conformance.mjs
fnm exec --using=24 -- node bench/baselines/r2/conformance.mjs
fnm exec --using=26 -- node bench/baselines/r2/conformance.mjs
deno run --no-prompt --allow-read=conformance,packages/wasm/generated --node-modules-dir=manual bench/baselines/r2/conformance.mjs
node apps/studio/node_modules/@playwright/test/cli.js install chromium firefox webkit
fnm exec --using=26 -- node bench/baselines/r2/browser.mjs
fnm exec --using=26 -- node bench/baselines/r2/measure.mjs --chromium
bun bench/baselines/r2/measure.mjs
```

The script uses Rust's `wasm32-unknown-unknown` target and the wasm-bindgen CLI version from
`Cargo.lock`. Artifacts go under `packages/wasm/generated/{client,transforms,authoring}`. Each
directory contains a Wasm binary, its web loader, a JavaScript entry, the Binaryen translation
and declarations. The JavaScript entry initializes on import. The existing combined build
remains available without `--split` for the embedded binding.

Canopy.js can call `loadTransforms()` from the generated `transforms/load.js` on its first
sort, projection or update. The loader shares one initialization promise across callers
and retries failed initialization. It selects the JavaScript translation when WebAssembly
is absent. Pass Wasm bytes or a response on hosts that provide their own asset loading.
The matcher and transforms each own their own document handles. Transfer a page as BSON
and release each handle with its module's generated `free()` method.

The tuning probes used an index snapshot with the repository's `CARGO_TARGET_DIR` while
the workspace had concurrent crate edits. The final build also ran in the workspace on Rust 1.100.0.
The runners live here alongside the split build and measurement instructions. They share one
replay using the same fixtures and load the document transforms on first use. The browser runner
also verifies the request order and that the JavaScript run makes no Wasm requests. The nightly
Linux job builds the modules and runs Deno and all three Playwright browsers.

| Runtime on Windows 11 | Wasm                         | wasm2js              | Wasm with strict CSP |
| --------------------- | ---------------------------- | -------------------- | -------------------- |
| Bun 1.4.5             | Pass                         | Pass                 | N/A                  |
| Node 24.22.1          | Pass                         | Pass                 | N/A                  |
| Node 26.12.1          | Pass                         | Pass                 | N/A                  |
| Deno 2.9.8            | Pass                         | Pass                 | N/A                  |
| Chromium 156.0.8078.4 | Pass with `wasm-unsafe-eval` | Pass with strict CSP | Refused as expected  |
| Firefox 157.0         | Pass with `wasm-unsafe-eval` | Pass with strict CSP | Refused as expected  |
| WebKit 27.2           | Pass with `wasm-unsafe-eval` | Pass with strict CSP | Refused as expected  |
| Hermes                | N/A                          | Pass (desktop CLI)   | N/A                  |

The strict policy is `script-src 'self'`. The JavaScript runner selects the fallback explicitly
and hides the WebAssembly global so the current lazy loader takes its JavaScript branch.
The Wasm refusal check uses the real loader and checks for a CSP compilation error.
Node and Bun also run the JavaScript replay with `globalThis.WebAssembly` absent.

The replay compares the MongoDB matcher decisions for 1,991
valid filters and checks the nine refused filters, compares all 200 sorts and 200 projections,
and checks the 1,995 update results or refusals handled by the Rust updater. Update vectors 163,
596, 893, 1111 and 1949 report `CANOPY_INVALID_QUERY` with
`UnsupportedQueryError: Decimal128 arithmetic is not evaluated in process`.
It checks lazy loading, retry after failed initialization, atomic failure
on a retained page, the typed protocol fixture's EJSON payloads, canonical query and hash vectors,
policy set versions and compiled
decisions, 15 canonical policy bundle hashes, and the 35 inference, 27 validator and six
restriction cases.

## Hermes desktop CLI

Build the split modules first. The runner uses the workspace install for esbuild, TypeScript and
the BSON fixture helper. It bundles the fixtures and the wasm2js entries with UTF8 and base64 host
shims. The transforms initialize on first use. With `--legacy`, TypeScript lowers the BSON helper's
classes to ES5 and the runner enables Hermes's class flag for the remaining native classes.

- **Hermes 0.12.0.** Extract the CLI archive for your platform from the
  [official v0.13.0 release](https://github.com/meta/hermes/releases/tag/v0.13.0).
  The Windows archive reports Hermes 0.12.0 and bytecode version 96. Its measured archive SHA-256
  is `485907ae87f267f7901f45c12979fea9703967ee2fa930bab887d022de9d6478`.
  Use the archive's `hermes` and `hermesc` together.
- **Hermes 1.0.0.** Fetch `hermes-compiler@250829098.0.19` with
  `npm pack hermes-compiler@250829098.0.19 --pack-destination target`.
  Check the [npm tarball](https://registry.npmjs.org/hermes-compiler/-/hermes-compiler-250829098.0.19.tgz)
  SHA-256 `839af099f0926b5ebbd738ba54764a3f40e35dfc3aac91babf56f8eb7c69280e` before extracting it.
  Its `hermesc` directory has platform binaries for Linux, macOS and Windows. The package ships
  the compiler. Build the matching `hermes` CLI from the
  [package source revision](https://github.com/meta/hermes/tree/40b4c8d4e22ed2b9af46aba81aec3ca8aa5e169c)
  using the [Hermes build instructions](https://github.com/meta/hermes/blob/40b4c8d4e22ed2b9af46aba81aec3ca8aa5e169c/doc/BuildingAndRunning.md).
  For example, after checking out that source under `target/hermes-source`, run
  `cmake -S target/hermes-source -B target/hermes-source/out -G Ninja -DCMAKE_BUILD_TYPE=Release`
  followed by `cmake --build target/hermes-source/out --target hermes`. Both executables used here
  report bytecode version 98.

```sh
bun bench/baselines/r2/hermes.mjs --legacy --hermes target/hermes/hermes.exe --hermesc target/hermes/hermesc.exe --bench
bun bench/baselines/r2/hermes.mjs --hermes target/hermes-source/out/bin/hermes.exe --hermesc target/hermes-modern/package/hermesc/win64-bin/hermesc.exe --bench
```

Substitute executable paths for your platform as needed. `CANOPY_HERMES` and `CANOPY_HERMESC` also
accept paths. Omit `--bench` to run conformance alone. The replay
prints each fixture's result and exits nonzero on compilation, runtime or assertion failure.
A replay assertion failure identifies the active fixture and any fixtures still pending.

Both Windows 11 x64 CLI runs passed all 11 sets exercised by the shared R2 replay.

| Vector set                                     | Hermes 0.12.0 | Hermes 1.0.0 |
| ---------------------------------------------- | ------------: | -----------: |
| `matcher/filters`                              |         2,000 |        2,000 |
| `matcher/sorts`                                |           200 |          200 |
| `matcher/projections`                          |           200 |          200 |
| `matcher/updates`                              |         1,995 |        1,995 |
| `policy/policy` (set cases)                    |           761 |          761 |
| `policy/pipeline`                              |         2,242 |        2,242 |
| `query/query` (query cases)                    |         2,972 |        2,972 |
| `schema/schema`                                |            68 |           68 |
| `authoring/policy/vectors`                     |            15 |           15 |
| `authoring/policy/publishing`                  |            15 |           15 |
| `protocol/07-typed-values` (document payloads) |             3 |            3 |

Filter passes include nine expected refusals. Updates also verified the five expected
unsupported Decimal128 arithmetic cases. Pipeline passes include 431 accepts and 1,811
expected refusals. The authoring and publishing fixtures share the same 15 policy bundles.

### Desktop CLI timings

Windows 11 x64 on an AMD Ryzen 5 5600H. Each entry is the median of five samples, alternating
the two implementations. The ratio is wasm2js time divided by TypeScript time. Both implementations
run in the same Hermes CLI. Matcher times are in microseconds per scan of 1,000 documents with
50 scans per sample. Filter compilation and BSON page construction happen before timing. The
shared dotted path scenario is omitted because it includes a regex outside this benchmark's
supported filter subset. Codec times are in microseconds per frame over 1,000 passes of the five
server frames in the typed protocol fixture, with 100 warmup passes. They include the host encoding
shims. React Native device performance is unmeasured.

| Workload                   | 0.12.0 TypeScript / wasm2js / ratio | 1.0.0 TypeScript / wasm2js / ratio |
| -------------------------- | ----------------------------------: | ---------------------------------: |
| equality (DLS owner)       |                 1320 / 3460 / 2.62× |                1160 / 3200 / 2.76× |
| `range and $in`            |               14420 / 34020 / 2.36× |               8360 / 21420 / 2.56× |
| `$or of 3 branches`        |                9280 / 26940 / 2.90× |               4840 / 16140 / 3.33× |
| `$elemMatch`               |                5460 / 18340 / 3.36× |               5080 / 19560 / 3.85× |
| DLS and user filter        |                 1840 / 5660 / 3.08× |                1060 / 3640 / 3.43× |
| canonical EJSON (5 frames) |               46.6 / 868.2 / 18.63× |              38.8 / 946.4 / 24.39× |

The original baseline also verified the extracted schema crate and the native schema vectors.
Its license check passed with the existing `jsonpath-rust` manifest warning.
The combined binding passed all four tests in `bunx vitest run --project wasm`.
Vitest skipped the placeholder for a missing generated build. The matcher and protocol passed
54 Rust unit tests with `cargo test -j 2 -p canopy-protocol -p canopy-matcher --lib`.
The build and benchmark scripts passed `bunx biome check`, and
`cargo clippy -j 2 -p canopy-wasm --all-targets -- -D warnings` passed.

Generated frame types, policy lint diagnostics, canonical unresolved config resolution,
collection schema bundle validation and the remaining query and policy authoring vectors are
still open. The protocol replay exercises the typed EJSON payloads.
The launcher config export validates the existing Rust launcher
format. The Canopy.js integration, root bundle growth, first live query and optimistic update latency
measurements are pending.

## Code section profile

Function body sizes come from the Wasm code section, joined by function index to the name
section. This diagnostic build retained names through wasm-bindgen and `wasm-opt -g -Oz`.
It used the full client surface before the transform split with fat LTO and `opt-level=z`.
A function can include inlined code from other modules.

| Symbol group   | Function body bytes |
| -------------- | ------------------: |
| `core::slice`  |              25,393 |
| Matcher filter |              21,789 |
| `core::fmt`    |              16,910 |
| Matcher update |              15,668 |
| BSON codec     |              12,854 |
| Matcher regex  |              12,691 |
| EJSON codec    |              12,044 |
| `core::iter`   |               9,647 |

The largest individual bodies were float formatting (9,972 bytes), the update walker
(8,250), the EJSON decoder (7,510), an iterator instantiation for batch updates (6,785),
the regex sequence parser (4,817) and the allocator (4,815). The generic quicksort for
regex option letters occupied another 3,150 bytes on its own. That sort now uses a heap
for both owned and raw BSON comparisons. Regex case folding now keeps its two candidates
on the stack, and batch updates use one loop with an atomic assignment after all documents succeed.
In the named split client, regex symbols accounted for 12,460 of 160,002 function body bytes (7.8%),
with another 479 bytes attributed to Unicode helpers. Attribution excludes inlined code and Unicode
data stored outside the code section.

## Size

Windows 11 on an AMD Ryzen 5 5600H. Sizes are bytes, with gzip level 9 and Brotli quality 11.
The JavaScript fallback includes both glue and translation. The original build measured:

| Artifact                      |       Raw |    Gzip |  Brotli |
| ----------------------------- | --------: | ------: | ------: |
| Client Wasm                   |   283,617 | 129,593 | 109,247 |
| Client Wasm glue              |    30,454 |   5,326 |   4,697 |
| Client JavaScript fallback    | 1,857,390 | 263,640 | 194,293 |
| Authoring Wasm                |   565,478 | 241,625 | 195,255 |
| Authoring Wasm glue           |    41,926 |   6,021 |   5,237 |
| Authoring JavaScript fallback | 3,663,328 | 507,209 | 352,433 |

The workspace build now measures:

| Artifact                       |       Raw |    Gzip |  Brotli |
| ------------------------------ | --------: | ------: | ------: |
| Client Wasm                    |   195,551 |  94,480 |  81,704 |
| Client Wasm glue               |    25,567 |   4,825 |   4,261 |
| Client JavaScript fallback     | 1,228,460 | 186,081 | 141,157 |
| Transforms Wasm                |   249,441 | 116,136 |  99,067 |
| Transforms Wasm glue           |    16,570 |   3,647 |   3,213 |
| Transforms JavaScript fallback | 1,616,091 | 234,687 | 174,714 |
| Authoring Wasm                 |   513,374 | 223,748 | 183,758 |
| Authoring Wasm glue            |    41,926 |   6,021 |   5,237 |
| Authoring JavaScript fallback  | 3,383,809 | 459,624 | 322,798 |

The original client code section accounted for 240,151 raw bytes (84.7%). The workspace
build's code section is 159,412 bytes and its data section is 33,627 bytes.
Each row below measures the standalone client at that step. Diagnostic builds retained
names to attribute code. Their production equivalents stripped names and debug data.

| Build change                                                                      | Client Brotli bytes |
| --------------------------------------------------------------------------------- | ------------------: |
| Baseline, size optimization, thin LTO, one codegen unit, stripped, Binaryen `-Oz` |             109,247 |
| Fat LTO, names retained for attribution                                           |             115,732 |
| Fat LTO, names and debug data stripped                                            |             105,903 |
| Binaryen `-Oz --converge`                                                         |             105,338 |
| Error string changes and explicit batch update loop                               |             105,440 |
| Explicit Wasm-only abort strategy                                                 |             105,521 |
| Trial of `opt-level=s` in place of `z`                                            |             116,698 |
| Production split with `opt-level=z`                                               |              83,714 |
| Diagnostic split with heap sorting for option letters                             |              82,235 |
| Diagnostic split with allocation-free case folding                                |              82,158 |
| Diagnostic split with Binaryen data flow optimization                             |              81,675 |
| Final workspace build with Binaryen data flow optimization                        |              81,704 |

The error changes preserved the error strings, moved numeric error formatting off the
successful filter path and removed the Wasm boundary's format macro. No library error
path at that boundary used Debug formatting. Binaryen merge and inline tuning failed
to improve on the converged full client. The Wasm profile inherits one codegen unit from
release. Explicit panic abort is scoped to the split Wasm target.

## Startup

Fifty samples per module in the final build and 20 in the baseline. Each Wasm sample has a
distinct custom section to bypass reuse of compiled bytes. Node 26 starts the clock after reading the binary. Headless Chromium
156.0.8078.4 uses streaming compilation from a local response with 4x CPU throttling, with
timing starting when the response headers arrive. Wasm loader import happens before timing.
The baseline's other client run measured 32.30 ms p95.

| Module    | Node 26 median / p95 (ms) | Chromium median / p95 (ms) | Node 26 fallback import median / p95 (ms) |
| --------- | ------------------------: | -------------------------: | ----------------------------------------: |
| Client    |               1.92 / 5.97 |              20.55 / 28.20 |                               3.14 / 8.02 |
| Authoring |              3.79 / 18.75 |              21.90 / 29.90 |                              5.48 / 28.57 |

Workspace build results:

| Module     | Node 26 median / p95 (ms) | Chromium median / p95 (ms) | Node 26 fallback import median / p95 (ms) |
| ---------- | ------------------------: | -------------------------: | ----------------------------------------: |
| Client     |               0.94 / 1.21 |               8.85 / 21.60 |                               1.46 / 3.51 |
| Transforms |               1.02 / 2.03 |               8.75 / 16.60 |                               1.25 / 3.47 |
| Authoring  |               1.51 / 3.28 |              12.20 / 19.10 |                               1.55 / 2.52 |

The JavaScript import times include creation of a fresh module instance. The runtime can cache
the translated dependency after the first import, so these figures do not represent a cold
Hermes load.

## Matcher and EJSON throughput

The benchmark uses the six 1,000 document [R0 scenarios](../r0/README.md#standard-scenarios-1000-documents).
BSON serialization, loading the retained page and compiling the filter are outside the timer.
Each timed pass includes the call boundary and reads its decision bytes in JavaScript.
All results are checked against the corresponding handwritten predicate. The table reports
nanoseconds per document over the fastest of seven passes after warmup. Baseline timings:

| Scenario                | Node 26 Wasm | Node 26 JS | Bun Wasm | Bun JS |
| ----------------------- | -----------: | ---------: | -------: | -----: |
| Equality (DLS owner)    |       127.40 |     356.00 |   102.69 | 164.64 |
| Range and `$in`         |       358.94 |   1,698.84 |   317.64 | 669.34 |
| `$or` of three branches |       484.02 |   1,604.25 |   288.69 | 766.55 |
| Dotted path             |       337.09 |   1,029.77 |   197.46 | 567.55 |
| `$elemMatch`            |       402.95 |   1,688.92 |   331.05 | 842.75 |
| DLS and user filter     |       120.60 |     444.63 |   105.15 | 181.92 |

Against the R0 timings, Node exceeded the 1.2x budget on equality, dotted paths, `$elemMatch`
and the combined DLS and user filter. Bun's Wasm exceeded 1.2x on the combined filter
(105.15 ns against a budget of 104.76 ns).

Workspace build timings:

| Scenario                | Node 26 Wasm | Node 26 JS | Bun Wasm | Bun JS |
| ----------------------- | -----------: | ---------: | -------: | -----: |
| Equality (DLS owner)    |        57.56 |     147.02 |    77.38 | 127.10 |
| Range and `$in`         |       187.87 |     732.06 |   178.95 | 497.03 |
| `$or` of three branches |       211.01 |     751.85 |   209.78 | 504.58 |
| Dotted path             |       154.63 |     405.39 |   156.90 | 319.31 |
| `$elemMatch`            |       233.64 |     794.66 |   226.21 | 527.40 |
| DLS and user filter     |        68.21 |     225.40 |    73.08 | 149.96 |

The workspace Wasm run was within the 1.2× matcher budget in all six scenarios on both hosts.
The JavaScript fallback results are host runtime observations. The 3x gate calls for Hermes
and CSP measurements.

The EJSON benchmark parses and canonicalizes the complete JSON text of the typed protocol
fixture's server frames and checks identical output against the TypeScript codec. The numbers
include encoding the canonical result across the Wasm boundary and exclude frame validation.

| Runtime | TypeScript (µs/frame) | Wasm (µs/frame) | wasm2js (µs/frame) |
| ------- | --------------------: | --------------: | -----------------: |
| Node 26 |                  9.41 |           12.28 |              45.13 |
| Bun     |                  4.20 |            8.80 |              18.84 |

Workspace build:

| Runtime | TypeScript (µs/frame) | Wasm (µs/frame) | wasm2js (µs/frame) |
| ------- | --------------------: | --------------: | -----------------: |
| Node 26 |                  4.26 |            5.97 |              15.21 |
| Bun     |                  2.93 |            5.88 |              12.97 |

## Canopy.js adoption

Canopy.js vendors the client and transforms builds with `bun scripts/sync-wasm.ts` and loads both at
client creation (see the R2 adoption checkpoint in the plan 005 progress log for every result).
`root-entry.ts` builds the R0 live query app against a Canopy.js `src` folder with code splitting and
reports the entry chunk, the lazy chunks and the Wasm assets. `startup.mjs` serves that output to headless
Chromium at 4x CPU slowdown. Start Canopy on port 3000 with `MONGODB_URI=mongodb://localhost:37017/?replicaSet=rs0`
and `CANOPY_PUBLISHABLE_KEYS=canopy_pk_dev_test123456`. Use `--csp strict` to serve the page without
`'wasm-unsafe-eval'`.

Both builds time the first snapshot and first `ready` from the same inline script start. Each run uses a fresh
browser context and the app uses neither hydration nor document caching. The first `stale` or `ready` state
therefore carries the server snapshot, which may be empty. The TypeScript build emits both events in the same
state. The Rust build can show the snapshot as `stale` while the client core initializes.

The JSON reports median and p95 in `first_live_query_result_ms` (first snapshot),
`first_live_query_ready_ms` (first `ready`), and `live_query_ready_delay_ms` (the difference within each run).
Pass the TypeScript JSON from the same CSP configuration as `--baseline` to include `startup_gate` in the
Rust report. The gate compares first snapshot medians and allows at most 5% over TypeScript.

```sh
bun bench/baselines/r2/root-entry.ts --src <baseline>/src --out target/app-ts
bun bench/baselines/r2/root-entry.ts --src ../Canopy.js/src --out target/app-rust
fnm exec --using=26 -- node bench/baselines/r2/startup.mjs --dir target/app-ts --runs 50 > target/startup-ts.json
fnm exec --using=26 -- node bench/baselines/r2/startup.mjs --dir target/app-rust --runs 50 --baseline target/startup-ts.json
```

| Build of the R0 app   | Eager JavaScript (Brotli) | Loaded at client creation           | First live query median (ms) |
| --------------------- | ------------------------: | ----------------------------------- | ---------------------------: |
| TypeScript core       |                    23,785 | update engine chunk 4,436           |              255.4 and 289.2 |
| Rust core, Wasm       |                    17,723 | glue 4,682, Wasm 79,938 and 102,347 |              334.6 and 348.8 |
| Rust core, strict CSP |                    17,723 | wasm2js 108,783 and 138,713         |                        359.8 |

Each median is one round of 50 runs against `canopyd` from `bun run dev` on MongoDB 8.0.34.

After the BSON crossing and the deferred sort the core loads after first paint, so the first live query no
longer waits for it. The same R0 app, measured again in two interleaved rounds of 50 runs each:

| Build of the R0 app         | Eager JavaScript (Brotli) | Loaded after first paint            | First live query median (ms) |
| --------------------------- | ------------------------: | ----------------------------------- | ---------------------------: |
| TypeScript core             |                    23,787 | update engine chunk 4,437           |              194.8 and 190.2 |
| Rust core, Wasm             |                    21,040 | glue 4,763, Wasm 81,646 and 102,006 |              202.3 and 183.9 |
| TypeScript core, strict CSP |                    23,787 | update engine chunk 4,437           |                        194.9 |
| Rust core, strict CSP       |                    21,040 | wasm2js 110,828 and 137,803         |                        192.9 |

### Canopy.js engine microbenchmark

Install Canopy's workspace dependencies and have a built Canopy.js checkout available with
`dist/client/engine.js` and the Wasm assets under `dist/core/wasm`. To prepare a checkout that
already vendors the desired Wasm build, run `bun install --frozen-lockfile` and `bun run build`
inside Canopy.js. From the Canopy repository root:

```sh
node apps/studio/node_modules/@playwright/test/cli.js install chromium
bun bench/baselines/r2/engine-bench.mjs
fnm exec --using=26 -- node bench/baselines/r2/engine-bench.mjs
fnm exec --using=26 -- node bench/baselines/r2/engine-bench.mjs --chromium
```

The default checkout is the sibling `../Canopy.js`. Use `--canopy-js <checkout>` to select another
build and `--rounds <count>` to change the default of three rounds. Chromium runs headless through
Studio's Playwright install with CDP CPU throttling set to 4x.

Each round alternates TypeScript and Wasm within each workload. Matching times are nanoseconds per
document from the fastest of 15 passes after warmup, with ten scans of 1,000 documents per pass.
Both implementations are checked against the six handwritten predicates. The dotted path fixture
uses the frozen full matcher because the lite matcher refuses its regex. The other five use the
[frozen lite matcher](./reference/README.md). Cold scans use fresh document objects with identical
contents for every scan, prepared before timing. Warm scans reuse the same document objects,
allowing the engine to reuse retained BSON and decoded documents. The 1.2x matching gate uses
the warm number, because the client keeps the documents of a live query retained in the core and
matches them there; the cold number is the cost of a document's first contact with the core (encoding
it and decoding it once), reported beside the gate and not gated, as in the earlier R2 measurements.
Both timings include the engine call and reading the decisions, and exclude
filter compilation and engine startup.

Optimistic update times are microseconds per application, from the median of 30 batches of 200
applications. `single` reuses the same input document and update, `chained` feeds each result into
the next update within its batch, and `fresh` uses new documents and update specs prepared before the
clock starts. JSON output includes each round and the minimum and maximum across rounds for both
implementations and their paired Wasm to TypeScript ratios. Use a quiet machine for gate measurements.

## Measurements (2026-11-26)

Measurements on Windows 11 with an AMD processor under an idle machine state (reported processor load was 5% to 10%). Canopy.js was built from commit `0307378` on `refactor/rust-core`, where a live query reports ready status only after optimistic changes apply and the Rust core finishes initialization.

### Commands

```sh
# Canopy.js build
cd D:\Coding\Canopy.js
bun run build

# Engine microbenchmarks (5 rounds per host)
bun bench/baselines/r2/engine-bench.mjs --rounds 5
fnm exec --using=26 -- node bench/baselines/r2/engine-bench.mjs --rounds 5
fnm exec --using=26 -- node bench/baselines/r2/engine-bench.mjs --chromium --rounds 5

# Root entry builds and startup measurements (2 interleaved rounds of 50 runs, strict CSP too)
# With Canopy server running on port 3000 against MONGODB_URI=mongodb://localhost:37017/?replicaSet=rs0
bun bench/baselines/r2/root-entry.ts --src <baseline>/src --out target/app-ts
bun bench/baselines/r2/root-entry.ts --src ../Canopy.js/src --out target/app-rust
fnm exec --using=26 -- node bench/baselines/r2/startup.mjs --dir target/app-ts --runs 50
fnm exec --using=26 -- node bench/baselines/r2/startup.mjs --dir target/app-rust --runs 50
fnm exec --using=26 -- node bench/baselines/r2/startup.mjs --dir target/app-ts --runs 50 --csp strict
fnm exec --using=26 -- node bench/baselines/r2/startup.mjs --dir target/app-rust --runs 50 --csp strict
```

### Root entry and bundle size

| Build of the R0 app | Eager JavaScript (Brotli) | Lazy assets and Wasm modules                            | Total Brotli |
| ------------------- | ------------------------: | ------------------------------------------------------- | -----------: |
| TypeScript baseline |                    23,582 | update engine chunk 4,430                               |       28,012 |
| Rust core build     |                    21,408 | client Wasm 81,126, transforms Wasm 134,634, glue 4,910 |      545,119 |

The standalone client Wasm module is 81,126 Brotli bytes, meeting the 81,920 byte gate (80 KB). Eager JavaScript is 21,408 Brotli bytes, which is 2,174 bytes smaller than the TypeScript baseline entry.

### Startup first live query

These historical runs timed the first `ready` state. With Canopy.js commit `0307378`, the Rust query reports
ready once the core has loaded. A first snapshot comparison for the startup gate requires running the updated
benchmark. Module evaluation and first ready results over 50 runs per sample:

| Build and configuration | Evaluation median / p95 (ms) | First ready median / p95 (ms) | Wasm requests per run |
| ----------------------- | ---------------------------: | ----------------------------: | --------------------: |
| TypeScript round 1      |                28.80 / 31.60 |                97.30 / 118.40 |                     0 |
| Rust core round 1       |                 6.50 / 27.50 |               144.45 / 158.60 |                     2 |
| TypeScript round 2      |                28.25 / 30.50 |                 94.80 / 99.00 |                     0 |
| Rust core round 2       |                 6.45 / 26.90 |               148.40 / 164.00 |                     2 |
| TypeScript strict CSP   |                28.00 / 30.60 |                94.15 / 106.30 |                     0 |
| Rust core strict CSP    |                 6.30 / 27.00 |               195.95 / 207.10 |                     2 |

Module evaluation is 6.45 ms to 6.50 ms median in the two Rust runs without strict CSP. First ready is
144.45 ms and 148.40 ms in those runs, compared with 97.30 ms and 94.80 ms on the TypeScript baseline.

### Engine matching throughput (nanoseconds per document)

These runs used repeated document objects, the warm number the gate uses. Values are median [spread
min .. max] across 5 interleaved rounds.

| Scenario                |            Bun TypeScript |                  Bun Wasm (ratio) |        Node 26 TypeScript |              Node 26 Wasm (ratio) |    Chromium 4x TypeScript |          Chromium 4x Wasm (ratio) |
| ----------------------- | ------------------------: | --------------------------------: | ------------------------: | --------------------------------: | ------------------------: | --------------------------------: |
| equality (DLS owner)    |    41.45 [30.08 .. 45.03] |    28.61 [28.08 .. 37.26] (0.69x) |    49.42 [27.04 .. 49.62] |    47.51 [45.94 .. 51.09] (1.00x) |  100.00 [90.00 .. 120.00] | 200.00 [190.00 .. 200.00] (1.90x) |
| range and `$in`         | 240.62 [204.98 .. 263.44] | 122.60 [121.11 .. 124.77] (0.51x) | 248.17 [238.14 .. 252.59] | 138.39 [135.82 .. 140.01] (0.56x) | 800.00 [750.00 .. 840.00] | 590.00 [570.00 .. 630.00] (0.74x) |
| `$or` of three branches | 227.73 [217.36 .. 245.24] | 134.17 [132.80 .. 134.71] (0.59x) | 201.84 [200.73 .. 204.38] | 151.64 [150.48 .. 155.55] (0.75x) | 770.00 [710.00 .. 820.00] | 680.00 [650.00 .. 690.00] (0.88x) |
| dotted path             |   94.97 [84.36 .. 118.59] |    77.04 [76.17 .. 77.81] (0.82x) | 111.00 [107.44 .. 112.75] |    96.02 [94.76 .. 99.75] (0.88x) | 400.00 [400.00 .. 410.00] | 400.00 [400.00 .. 420.00] (1.00x) |
| `$elemMatch`            | 148.91 [142.01 .. 178.35] | 136.68 [134.91 .. 137.62] (0.92x) | 169.17 [164.90 .. 171.85] | 156.39 [155.88 .. 160.93] (0.94x) | 590.00 [580.00 .. 610.00] | 660.00 [650.00 .. 670.00] (1.12x) |
| DLS and user filter     |    44.46 [38.20 .. 54.78] |    47.61 [46.11 .. 48.97] (1.05x) |    57.18 [55.05 .. 59.02] |    63.77 [63.48 .. 67.85] (1.14x) | 210.00 [200.00 .. 220.00] | 270.00 [260.00 .. 280.00] (1.30x) |

### Optimistic update latency (microseconds per operation)

Values are median [spread min .. max] across 5 interleaved rounds.

| Mode    |      Bun TypeScript |                Bun Wasm (ratio) |  Node 26 TypeScript |        Node 26 Wasm (ratio) | Chromium 4x TypeScript |       Chromium 4x Wasm (ratio) |
| ------- | ------------------: | ------------------------------: | ------------------: | --------------------------: | ---------------------: | -----------------------------: |
| single  | 1.06 [1.05 .. 1.83] |     4.62 [3.53 .. 7.31] (3.99x) | 1.34 [1.33 .. 2.59] | 4.33 [4.30 .. 4.92] (3.20x) |    7.75 [7.00 .. 8.00] | 22.75 [21.25 .. 23.50] (3.03x) |
| chained | 1.07 [1.05 .. 1.36] |     5.39 [3.74 .. 7.13] (4.99x) | 1.41 [1.33 .. 2.00] | 4.36 [4.13 .. 4.57] (2.93x) |    5.50 [5.00 .. 6.00] | 19.75 [19.00 .. 20.75] (3.59x) |
| fresh   | 1.08 [1.06 .. 1.15] | 16.13 [14.81 .. 16.71] (14.56x) | 1.36 [1.34 .. 1.76] | 8.56 [8.42 .. 9.42] (6.30x) |    5.75 [5.25 .. 6.00] | 41.50 [39.50 .. 42.50] (7.09x) |
