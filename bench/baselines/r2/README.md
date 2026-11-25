# R2 Wasm baseline

The standalone client exceeds the **80 KB Brotli** limit. Its Chromium startup median is under
30 ms in both cold runs. The p95 was 28.20 ms in the final run and 32.30 ms in the earlier run.
The size gate failed and the startup tail crossed the threshold in one run.
[Gate and thresholds](../../../docs/plans/005-all-server-code-in-rust.md#7-the-wasm-core-in-canopyjs-bundle-and-startup-gate)

## Build and replay

Install the workspace dependencies with Bun. Put `wasm-opt` and `wasm2js` from Binaryen version 133
on PATH, or set `CANOPY_WASM_OPT` and `CANOPY_WASM2JS` to their absolute paths. CI can download the
platform archive from the pinned official release, check its SHA-256 against the release asset
digest, extract it and add its `bin` directory to PATH before invoking the split build. Binaryen
is an Apache 2.0 build tool. The generated client and authoring modules have no Binaryen runtime dependency.
[Binaryen version 133 release](https://github.com/WebAssembly/binaryen/releases/tag/version_133)

```sh
bun --filter @canopy/wasm build:native --split
bun bench/baselines/r2/conformance.mjs
fnm exec --using=26 -- node bench/baselines/r2/conformance.mjs
fnm exec --using=26 -- node bench/baselines/r2/measure.mjs --chromium
bun bench/baselines/r2/measure.mjs
```

The script uses Rust's `wasm32-unknown-unknown` target and the wasm-bindgen CLI version from
`Cargo.lock`. Artifacts go under `packages/wasm/generated/client` and
`packages/wasm/generated/authoring`. Each directory contains a Wasm binary, its web loader,
a JavaScript entry named `canopy_client_js.js` or `canopy_authoring_js.js`, the Binaryen translation,
and declarations. The JavaScript entry initializes on import. The existing combined build remains
available without `--split` for the embedded binding.

Both standalone artifacts built in a scratch checkout with the shared `CARGO_TARGET_DIR` because
the shared checkout had an incomplete concurrent workspace member. The replay passed on
Bun 1.4.5 and Node 26.12.1 with both formats. It compares the MongoDB matcher decisions for 1,991
valid filters and checks the nine refused filters, compares all 200 sorts and 200 projections,
and checks the 1,995 update results or refusals handled by the Rust updater. Five updates report
unsupported operations. It also checks atomic failure on a retained page, the typed protocol
fixture's EJSON payloads, canonical query and hash vectors, policy set versions and compiled
decisions, 15 canonical policy bundle hashes, and the 35 inference, 27 validator and six
restriction cases. The JavaScript replay runs with `globalThis.WebAssembly` absent.
The extracted schema crate and the native schema vectors passed as well. `cargo deny check
licenses` passed with the existing `jsonpath-rust` manifest warning.
The existing combined build passed all four binding tests in `bunx vitest run --project wasm`.
Vitest skipped the placeholder for a missing generated build.

Generated frame types, policy lint diagnostics, canonical unresolved config resolution,
collection schema bundle validation and the remaining query and policy authoring vectors are
still open. Chromium was used for startup measurements. Browser conformance, Deno, Hermes and
enforced CSP replay are pending. The launcher config export validates the existing Rust launcher
format. The Canopy.js integration, root bundle growth, first live query and optimistic update
latency measurements await a client design that meets the size budget.

## Size

Windows 11 on an AMD Ryzen 5 5600H. Sizes are bytes, with gzip level 9 and Brotli quality 11.
The JavaScript fallback includes both glue and translation.

| Artifact                      |       Raw |    Gzip |  Brotli |
| ----------------------------- | --------: | ------: | ------: |
| Client Wasm                   |   283,617 | 129,593 | 109,247 |
| Client Wasm glue              |    30,454 |   5,326 |   4,697 |
| Client JavaScript fallback    | 1,857,390 | 263,640 | 194,293 |
| Authoring Wasm                |   565,478 | 241,625 | 195,255 |
| Authoring Wasm glue           |    41,926 |   6,021 |   5,237 |
| Authoring JavaScript fallback | 3,663,328 | 507,209 | 352,433 |

The client code section accounts for 240,151 raw bytes (84.7%). The data section accounts for
40,504 bytes (14.3%). In an export removal experiment, a second `wasm-opt -Oz` pass on the
unchanged client produced 108,662 Brotli bytes. Removing both update exports brought that to
96,626. Removing sort and projection as well brought it to 89,171. These are size probes, with
no corresponding standalone bindings. Moving document transforms to a lazy artifact is a
measured first option. The remaining gap calls for measuring the full regex engine and separating
it from the lite client profile while preserving decisions for supported filters and refusing
unsupported filters explicitly. The Rust EJSON codec remains part of the requested client.

## Startup

Twenty samples per module. Each Wasm sample has a distinct custom section to bypass reuse of
compiled bytes. Node 26 starts the clock after reading the binary. Headless Chromium
156.0.8078.4 uses streaming compilation from a local response with 4x CPU throttling, with
timing starting when the response headers arrive. Wasm loader import happens before timing.

| Module    | Node 26 median / p95 (ms) | Chromium median / p95 (ms) | Node 26 fallback import median / p95 (ms) |
| --------- | ------------------------: | -------------------------: | ----------------------------------------: |
| Client    |               1.92 / 5.97 |              20.55 / 28.20 |                               3.14 / 8.02 |
| Authoring |              3.79 / 18.75 |              21.90 / 29.90 |                              5.48 / 28.57 |

The JavaScript import times include creation of a fresh module instance. The runtime can cache
the translated dependency after the first import, so these figures do not represent a cold
Hermes load.

## Matcher and EJSON throughput

The benchmark uses the six 1,000 document [R0 scenarios](../r0/README.md#standard-scenarios-1000-documents).
BSON serialization, loading the retained page and compiling the filter are outside the timer.
Each timed pass includes the call boundary and reads its decision bytes in JavaScript.
All results are checked against the corresponding handwritten predicate. The table reports
nanoseconds per document over the fastest of seven passes after warmup.

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
The JavaScript fallback results are host runtime observations. The 3x gate calls for Hermes
and CSP measurements.

The EJSON benchmark parses and canonicalizes the complete JSON text of the typed protocol
fixture's server frames and checks identical output against the TypeScript codec. The numbers
include encoding the canonical result across the Wasm boundary and exclude frame validation.

| Runtime | TypeScript (µs/frame) | Wasm (µs/frame) | wasm2js (µs/frame) |
| ------- | --------------------: | --------------: | -----------------: |
| Node 26 |                  9.41 |           12.28 |              45.13 |
| Bun     |                  4.20 |            8.80 |              18.84 |
