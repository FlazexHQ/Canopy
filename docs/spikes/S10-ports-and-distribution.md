# S10: Ports and distribution of the Rust core

- **Date:** recorded 2026-11-18
- **Status:** done on Windows x64. **Go** for `@canopy/native` as planned, with the batch shaped API and the
  release pipeline below. Linux (glibc and musl), macOS and the arm64 targets were not run here: Windows arm64
  was cross built and checked, the others are covered by the pipeline sketch and its install test.
- **Roadmap:** [12 §4](../plan/12-roadmap.md#4-technical-spikes) (spike S10),
  [14 §4.2](../plan/14-native-core.md#42-ports), [14 §6](../plan/14-native-core.md#6-platforms-toolchain-and-distribution),
  [14 §7](../plan/14-native-core.md#7-engineering-changes), [01 §8](../plan/01-architecture.md#8-runtime-strategy)

## Question

Can a Node-API port of the Rust core ship to every supported platform, runtime and package manager without
asking users for a Rust toolchain, and what does a call across the boundary cost? Success criterion: loads
everywhere or falls back to WebAssembly; per call overhead measured for single and batched calls; release
pipeline sketched.

## Decision

Go. On this machine the addon loads under Bun, Node 24, Node 26 and Deno, every package manager installs
exactly the right platform package, the WebAssembly fallback takes over whenever the native package is
missing (or Deno runs without `--allow-ffi`), and `bun build --compile` embeds the addon. Every run replays the
1,991 filters MongoDB recorded in `crates/canopy-matcher/tests/vectors/filters.json` against 300 documents
with 0 failures.

The measurements set three rules for the real `@canopy/native`:

1. **Batch, and pass one buffer per batch.** A call costs about 0.7 to 1 µs more than the matching itself, so the
   per event entry points of the realtime engine must take a batch of documents laid end to end in one
   buffer (`matchConcatenated`) or one document against every candidate filter (`FilterSet`). From batches
   of about 100 documents the cost per event is the cost of the Rust matcher alone.
2. **Never pass one `Uint8Array` per document to WebAssembly.** Every buffer handed to the fallback
   has to reach its linear memory: 6.7 µs per buffer under Bun, 18 µs under Node 26 and 21 µs under Deno, 53 µs under
   Node 24, against 0.3 µs natively. With one concatenated buffer per batch the fallback runs within 1.0 to
   1.9 times the native speed on every runtime, so the same batch API serves both.
3. **Feed it raw BSON.** Against the TypeScript matcher on documents the driver already decoded, the native
   matcher is slower (a call costs more than most TypeScript predicates). It wins by 4 to 12 times only when
   the bytes are never turned into JavaScript objects, which is the shape of the change stream path in
   [14 §2](../plan/14-native-core.md#2-what-the-measurements-say-today) (raw BSON, lazy field access).

## Method

`docs/spikes/S10-prototype/` is outside both workspaces: a standalone Cargo project (empty `[workspace]`
section, its own `Cargo.lock`) and its own `package.json` (the root `bun.lock` does not change). Nothing under
`crates/` needed a change: the wrapper uses `canopy_matcher::compile_filter`, `CompiledFilter::matches_raw`,
`canopy_protocol::RawDocument` and the EJSON and BSON codecs as they are.

| Piece | What it does |
|---|---|
| `src/lib.rs` (napi 3.16, napi-derive 3.7, `napi4`) | `Filter.fromEjson(text)` and `Filter.fromBson(bytes)`; `matches(document)` for one raw BSON document; `matchMany(documents[])` and `matchConcatenated(buffer)` for a batch, one result byte per document (0 no match, 1 match, 2 undecided, treated as a refusal); `FilterSet.matchDocument(document)` for one document against several filters; `noop` and `noopBytes` to measure the bare boundary. Errors carry the stable `CANOPY_*` codes; every entry point uses `catch_unwind`, so a panic becomes an error instead of aborting the process. |
| `wasm32-wasip1-threads` build | The same crate, built by `napi build --target wasm32-wasip1-threads`. |
| `wasi.cjs` | Loads the WebAssembly module through the WASI shim of `@napi-rs/wasm-runtime` (`asyncWorkPoolSize: 0`, so no worker threads start). The `node:wasi` module is not used: Bun does not implement it for reactor modules. |
| `index.js` | The loader. In order: a binding registered under `Symbol.for("canopy.native.binding")` (the compiled executable case), the local `.node` file, the platform package `@canopy-s10/native-<target>`, then the WebAssembly package. `CANOPY_NATIVE_ENGINE=native` or `wasm` forces one. Linux libc comes from `process.report` with `/usr/bin/ldd` as the fallback. When nothing loads it throws an error with code `CANOPY_UNAVAILABLE` and every attempt as its `cause`. |
| `scripts/build.ts` | Builds the host target and WebAssembly, then packs what a release would publish: one package per native target with `os`, `cpu` and (Linux) `libc`, the WebAssembly package without a `cpu` field (so every manager installs it as the fallback), and the root package naming them all as `optionalDependencies`. `--placeholders` adds empty packages for the targets this host cannot build, so the install test can check that managers skip them. |
| `scripts/smoke.mjs` | Replays the MongoDB filter vectors in all three call shapes and checks the error paths. |
| `scripts/install-test.ts` | Installs the packed packages from a local registry (Verdaccio 7) into a fresh project with one manager, lists the platform packages it got, and runs the smoke script on each runtime. `--platform freebsd` installs for a platform without a prebuilt package. |
| `scripts/compile-test.ts` | Builds a `bun build --compile` executable and runs it from an empty folder. |
| `scripts/bench.ts`, `examples/raw_cost.rs` | The boundary benchmark against the TypeScript matcher, and the Rust matcher alone. |

Machine: Windows 11 x64 (12 logical processors), Rust 1.100.0, Bun 1.4.4, Node 24.22.1 and 26.12.1, Deno
2.9.6, npm 11.20.0, pnpm 12.21, Yarn 4.18 and 1.22.22, 2026-11-18.

## Results

### Runtimes

Every runtime and engine: 1,991 filters x 300 documents agree with MongoDB in all three call shapes, 0 failures.

| Runtime | Native addon | WebAssembly fallback |
|---|---|---|
| Bun 1.4.4 | yes | yes |
| Node 24.22.1 | yes | yes |
| Node 26.12.1 | yes | yes |
| Deno 2.9.6 | yes, with `--allow-ffi` | yes, without `--allow-ffi` (needs `--allow-read` for the `.wasm` file) |

### Package managers

`install-test.ts` against the packed packages, with placeholder packages for the seven targets not built
here. Every manager installed exactly `native-win32-x64-msvc` and `native-wasm32-wasi`, and skipped the other
seven. With the platform forced to FreeBSD x64 it installed only `native-wasm32-wasi`, and the loader fell back
to WebAssembly on every runtime.

| Manager | Install | Node 26 | Bun | Deno | Forced to FreeBSD |
|---|---|---|---|---|---|
| Bun 1.4.4 | 0.7 s | native | native | native | WebAssembly on all three |
| npm 11.20.0 | 2.7 s | native | native | native | WebAssembly on all three |
| pnpm 12.21 | 1.0 s | native | native | native | WebAssembly on all three |
| Yarn 4.18, `node-modules` linker | 1.0 s | native | native | native | WebAssembly on all three |
| Yarn 4.18, Plug'n'Play | 0.8 s | native | not run | not run | not run |
| Yarn 1.22.22 | 0.9 s | native | native | native | not run (no platform override) |

Plug'n'Play resolves through Node's loader only, so Bun and Deno do not apply to it. Yarn unplugs the
platform package by itself (it contains a `.node` file), so no `dependenciesMeta` setting is needed. Install times are warm (the registry is local and the
tarballs are cached).

### Single executable

`bun build --compile` embeds a `.node` file only when it is imported or required by a literal path. The
loader's `require` calls are computed at run time, so an executable built from it alone does not contain the
addon and fails with `CANOPY_UNAVAILABLE` (fail closed, not a crash). `compile-test.ts` generates the entry a
single binary build needs: it imports the target's `.node` file by its literal path and registers it under
the global symbol, and the loader takes it first. The resulting executable runs from an empty folder outside
any `node_modules` and reports `engine native from embedded`. The addon adds 0.7 MB to the 115 MB executable.
For [S9](S9-single-binary.md) this means `deploy/binary/build.ts` must generate one such entry per Bun target.

### Sizes

| Artifact | File | Packed |
|---|---|---|
| `canopy-native.win32-x64-msvc.node` | 697 KB | 303 KB |
| `canopy-native.win32-arm64-msvc.node` (cross built) | 614 KB | not packed |
| `canopy-native.wasm32-wasi.wasm` | 413 KB | 166 KB |
| Root package (`index.js`, `index.d.ts`) | 4 KB | 2 KB |

Release profile: `lto = "thin"`, `codegen-units = 1`, symbols stripped. The WebAssembly package also brings
`@napi-rs/wasm-runtime`, `@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads`, `@tybys/wasm-util` and
`tslib` to every install, since it is installed everywhere.

### Cost of the boundary

`scripts/bench.ts` uses the documents and filters of `packages/matcher/bench/event-cost.ts`: 200,000 change
events of 223 bytes of BSON, six filters. Every mode must count the same matches as the TypeScript matcher or
the run fails. The figures, in ns per event:

- **ts decode+match:** `bson.deserialize` with `promoteValues: false` (as the realtime engine reads events),
  then the TypeScript matcher;
- **ts match:** the TypeScript matcher on documents decoded beforehand;
- **single:** `Filter.matches(bytes)`, one call per document;
- **many:** `matchMany`, an array of 1,000 buffers per call;
- **joined:** `matchConcatenated`, 1,000 documents end to end in one buffer per call;
- **Rust alone:** `examples/raw_cost.rs`, the same documents checked with `RawDocument::new` and matched in
  place, with no boundary.

**The machine was not idle** (other applications held about 70 % of the processor during the runs), so
single figures move by up to 30 % between runs; the ratios between call shapes of one run are stable. The JSON
reports of the first run (same machine, also loaded) agree within that margin.

Node 26.12.1, native:

| Filter | ts decode+match | ts match | single | many | joined | Rust alone |
|---|---|---|---|---|---|---|
| equality (DLS owner) | 4,141 | 55 | 1,461 | 688 | 570 | 700 |
| range and `$in` | 4,940 | 726 | 1,730 | 1,060 | 979 | 1,236 |
| `$or` of 3 branches | 4,759 | 511 | 1,754 | 1,118 | 1,011 | 1,200 |
| dotted path | 5,309 | 216 | 1,818 | 997 | 951 | 1,235 |
| `$elemMatch` | 4,729 | 326 | 1,848 | 1,129 | 1,054 | 1,061 |
| DLS and user filter | 4,067 | 98 | 1,331 | 705 | 584 | 745 |

The joined figures match the Rust matcher alone (within the noise), so a call per 1,000 documents costs
nothing measurable. A call per document costs 0.6 to 1 µs more than the match itself.

Bare boundary and the other runtimes (native, ns):

| | Bun 1.4.4 | Node 24.22.1 | Node 26.12.1 | Deno 2.9.6 |
|---|---|---|---|---|
| Empty call (`noop`) | 82 | 44 | 47 | 48 |
| Call with one 223 byte buffer (`noopBytes`) | 372 | 273 | 264 | 321 |
| equality: single / joined | 1,472 / 1,143 | 2,131 / 640 | 1,461 / 570 | 1,513 / 675 |
| `$or` of 3 branches: single / joined | 1,752 / 989 | 1,833 / 1,038 | 1,754 / 1,011 | 2,370 / 1,191 |
| ts decode+match, range of the six filters | 8,214 to 11,060 | 4,483 to 5,239 | 4,067 to 5,309 | 3,775 to 5,582 |
| One event against all six filters: ts decode once | 10,668 | 6,505 | 6,758 | 6,362 |
| Same, six native `matches` calls | 9,536 | 10,454 | 9,914 | 9,915 |
| Same, one `FilterSet.matchDocument` call | 4,853 | 7,691 | 6,646 | 4,645 |

Batch size sweep, equality filter, ns per event (Node 26 native; the other runtimes have the same shape):

| Documents per call | 1 | 10 | 100 | 1,000 | 10,000 |
|---|---|---|---|---|---|
| `matchMany` | 3,581 | 1,043 | 698 | 712 | 685 |
| `matchConcatenated` | 3,608 | 955 | 606 | 551 | 613 |

WebAssembly fallback (50,000 events, ns per event):

| | Bun 1.4.4 | Node 24.22.1 | Node 26.12.1 | Deno 2.9.6 |
|---|---|---|---|---|
| Empty call | 601 | 981 | 656 | 658 |
| Call with one buffer | 6,666 | 52,789 | 17,856 | 20,914 |
| equality: single / many / joined | 10,533 / 9,871 / 1,142 | 59,253 / 45,842 / 760 | 17,569 / 15,143 / 792 | 23,541 / 19,912 / 716 |
| `$or` of 3 branches: single / many / joined | 12,513 / 10,139 / 1,581 | 57,365 / 45,330 / 1,535 | 18,525 / 15,374 / 1,263 | 24,902 / 20,474 / 1,367 |
| DLS and user filter: single / many / joined | 10,367 / 7,551 / 684 | 53,678 / 46,167 / 904 | 17,834 / 14,860 / 842 | 27,247 / 21,213 / 845 |
| One event against all six filters, `FilterSet` | 22,486 | 66,874 | 28,244 | 85,708 |

What the numbers say:

- **Per call overhead.** An empty call costs 44 to 82 ns natively; passing one buffer adds about 220 to 290 ns;
  a real `matches` call adds about 0.7 to 1 µs over the Rust work (0.3 to 1.9 µs across every run: argument
  conversion, the `catch_unwind` frame, the result). Batching removes it: from about 100 documents per call
  the cost per event is flat.
- **Against the TypeScript matcher.** With decoding counted (the realtime path today), native batches are 4 to
  7.5 times faster on Node and Deno and 7 to 12 times on Bun, whose `bson` decoding is slower. On documents
  already decoded, the TypeScript matcher (46 to 1,100 ns) is faster than the native batch for every filter
  on Node and Deno and all but one on Bun: a port only pays where it replaces decoding, not where it is
  handed JavaScript objects.
- **Many filters, one event.** `FilterSet` (one call, one validation) beats six single calls by 1.4 to 2.1
  times. Against decoding once in TypeScript it ranges from slower (Node 24: 7,691 against 6,505 ns) to 2.2
  times faster (Bun), because six cheap TypeScript predicates on one decoded event cost little. The predicate
  index should hand the port all candidate filters of an event in one call, and the event should never be
  decoded in JavaScript.
- **WebAssembly** pays for every buffer it receives (`many` is barely better than `single`), but a
  concatenated batch costs 1.0 to 1.9 times the native joined figure on every runtime (Bun 1.0 to 1.6, Node 24 1.1 to 1.9, Node 26 1.1 to 1.4, Deno 1.1 to 1.5).

### Licenses

Everything the prototype links or installs, checked against the allowed set of
[11 §5](../plan/11-engineering.md) and `packages/testing/scripts/licenses.ts`:

| Scope | Packages | Licenses | Outside the allowed set |
|---|---|---|---|
| Crates linked into the addon | napi 3.16.2, napi-sys 3.4.1, ctor 1.0.14, libloading 0.9.1, futures 0.3.34 (and its parts), memchr 2.8.3, slab, pin-project-lite, link-section, nohash-hasher, rustc-hash, bitflags, cfg-if, libc, windows-link, semver | MIT, Apache 2.0, ISC (libloading); memchr is "Unlicense OR MIT" | none (memchr is taken under MIT) |
| Build time crates (proc macros, build script) | napi-derive 3.7.1, napi-derive-backend 7.0.1, napi-build 2.6.0, syn 3, quote, proc-macro2, convert_case, unicode-segmentation, unicode-ident | MIT, Apache 2.0; unicode-ident is "(MIT OR Apache-2.0) AND Unicode-3.0" | **unicode-ident: Unicode 3.0**, not linked into the artifact; this is the case of open question Q12 ([12 §7](../plan/12-roadmap.md#7-open-questions)) |
| npm packages a user installs | `@napi-rs/wasm-runtime` 1.2.7, `@emnapi/core` and `@emnapi/runtime` 2.0.0-beta.3, `@emnapi/wasi-threads` 2.2.0, `@tybys/wasm-util` 0.10.5, `tslib` 2.9.1 | MIT; tslib is 0BSD (already allowed by `licenses.ts`) | none |
| npm build tooling (never installed by users) | `@napi-rs/cli` 3.10.12 and its 60 dependencies, `emnapi` 2.0.0-beta.3, `bson` 7.3.3 | MIT, ISC, Apache 2.0, 0BSD | **argparse 2.0.1: PSF 2.0** (through `js-yaml` in `@napi-rs/cli`); needs the maintainer's decision like BlueOak 1.0.0 for Stryker, or a CLI free build |

`canopy-matcher` and `canopy-protocol` carry no `license` field yet, since the project license is still an
open decision.

## Release pipeline sketch

### Toolchain choices

| Targets | Built on | How | Why |
|---|---|---|---|
| `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` | `windows-latest` (x64) | `napi build --target ...`; arm64 is a plain MSVC cross build | Verified here: with the ARM64 libraries of Visual Studio installed, `rustup target add aarch64-pc-windows-msvc` and one `napi build` produced a 614 KB DLL with PE machine type `0xAA64` in 35 s. No extra tool. |
| `aarch64-apple-darwin`, `x86_64-apple-darwin` | `macos-latest` (arm64) | `napi build --target ...` for both | Xcode links both architectures; no extra tool. Not run here. |
| `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` | `ubuntu-latest` (x64) | `napi build --target ... -x` (cargo-zigbuild), with the glibc targets pinned to 2.17 (`x86_64-unknown-linux-gnu.2.17`) | One runner and one tool for all four Linux targets, glibc baseline chosen explicitly, musl without an Alpine container. `cross` needs Docker and QEMU images per target and runs on Linux hosts only; napi-rs's own `--use-napi-cross` toolchain (glibc 2.17) covers only the glibc targets and stays the fallback for them if Zig misbehaves. Zig and cargo-zigbuild are MIT. Not run here. |
| `wasm32-wasip1-threads` | `ubuntu-latest` | `napi build --target wasm32-wasip1-threads` | Built here on Windows. napi-build links `emnapi-napi-rs-mt`, which ships for `wasm32-wasip1-threads` only in the emnapi 2.0 betas (1.11.3 has it under `wasm32-wasi-threads` only), hence the pinned beta. |

`rust-toolchain.toml` pins the compiler for all of them ([14 §6](../plan/14-native-core.md#6-platforms-toolchain-and-distribution)).
musl `cdylib` builds need `-C target-feature=-crt-static`, which napi-rs sets for musl targets; the Alpine
test below is what proves it.

### Packages

The layout `scripts/build.ts` produces, renamed for the real package:

| Package | `os` / `cpu` / `libc` | Contents |
|---|---|---|
| `@canopy/native` | none | `index.js` (loader), `index.d.ts`; `optionalDependencies` on the nine below, all at the exact same version |
| `@canopy/native-win32-x64-msvc`, `-win32-arm64-msvc` | `win32` / `x64`, `arm64` | one `.node` file |
| `@canopy/native-darwin-x64`, `-darwin-arm64` | `darwin` / `x64`, `arm64` | one `.node` file |
| `@canopy/native-linux-x64-gnu`, `-linux-arm64-gnu` | `linux` / `x64`, `arm64` / `glibc` | one `.node` file |
| `@canopy/native-linux-x64-musl`, `-linux-arm64-musl` | `linux` / `x64`, `arm64` / `musl` | one `.node` file |
| `@canopy/native-wasm32-wasi` | none (installed everywhere) | `.wasm`, `wasi.cjs`; depends on `@napi-rs/wasm-runtime` and `@emnapi/*` |

The WebAssembly package deliberately has no `cpu` field (napi-rs's default is `cpu: ["wasm32"]`, which needs
an explicit opt in): the fallback must be present on any platform without a prebuilt package and for Deno
without `--allow-ffi`, at the cost of about 170 KB plus the runtime packages on every install. Changesets
versions the ten packages as one fixed group; publishing goes platform packages first, root last, each with
npm provenance.

### Workflow

```yaml
# .github/workflows/native.yml (sketch): nightly, on release branches, and on pull requests that touch crates/ or packages/native/
jobs:
  build:
    strategy:
      matrix:
        include:
          - { host: windows-latest, target: x86_64-pc-windows-msvc }
          - { host: windows-latest, target: aarch64-pc-windows-msvc }
          - { host: macos-latest, target: aarch64-apple-darwin }
          - { host: macos-latest, target: x86_64-apple-darwin }
          - { host: ubuntu-latest, target: x86_64-unknown-linux-gnu.2.17, zig: true }
          - { host: ubuntu-latest, target: aarch64-unknown-linux-gnu.2.17, zig: true }
          - { host: ubuntu-latest, target: x86_64-unknown-linux-musl, zig: true }
          - { host: ubuntu-latest, target: aarch64-unknown-linux-musl, zig: true }
          - { host: ubuntu-latest, target: wasm32-wasip1-threads }
    runs-on: ${{ matrix.host }}
    steps:
      # checkout, rust-toolchain.toml, rustup target add, Swatinem/rust-cache (all pinned to SHAs)
      # zig and cargo-zigbuild when matrix.zig
      # bun packages/native/scripts/build.ts --target ${{ matrix.target }}
      # upload the .node or .wasm file as an artifact
  install:
    needs: build
    strategy:
      matrix:
        include:
          - { host: ubuntu-24.04 }                              # x64 glibc
          - { host: ubuntu-24.04-arm }                          # arm64 glibc
          - { host: ubuntu-24.04, container: "node:24-alpine" }  # x64 musl
          - { host: ubuntu-24.04-arm, container: "node:24-alpine" } # arm64 musl
          - { host: macos-latest }                              # arm64
          - { host: macos-15-intel }                            # x64
          - { host: windows-latest }                            # x64
          - { host: windows-11-arm }                            # arm64
    runs-on: ${{ matrix.host }}
    container: ${{ matrix.container }}
    steps:
      # download every artifact, pack the ten packages, start Verdaccio on localhost
      # for pm in bun npm pnpm yarn: install-test --pm $pm --runtimes node24,node26,bun,deno
      #   (Deno skipped on musl, where it ships no build; Bun where it ships a build for the host)
      # install-test --platform freebsd for each manager: only the WebAssembly package, fallback on every runtime
      # Deno without --allow-ffi: fallback
      # compile-test with Bun: the executable embeds the addon and runs from an empty folder
```

### How the install test (B4) covers it

The B4 test in `packages/testing/scripts/install-test.ts` already packs every published package, installs the
tarballs with the four managers and imports each entry point on Linux, Windows and macOS. For
`@canopy/native` it gains what `install-test.ts` of this prototype does:

- the platform packages installed are exactly the host's and the WebAssembly one (a manager that ignores
  `libc` and installs both glibc and musl packages is reported, since the loader still picks the right one);
- the MongoDB filter vectors replay through the installed package on Node 24, Node 26, Bun and Deno, and
  `engine()` reports `native`;
- with the platform forced to one without a prebuilt package, and with Deno without `--allow-ffi`, the vectors
  replay through WebAssembly;
- the CI job runs on the eight hosts of the matrix above, so each prebuilt binary is loaded on its own
  platform at least once per night, and the Linux x64, Windows x64 and macOS arm64 legs run on every pull
  request that touches the port.

## Open risks

- **Linux and macOS are unverified.** Nothing ran on glibc, musl or macOS. The libc detection in the loader
  (`process.report` under Bun and Deno on Alpine), the musl `cdylib` and the `libc` field support of each
  manager are the likely failure points; the Alpine legs of the matrix are the first thing to run.
- **emnapi beta.** The WebAssembly build depends on `@emnapi/core`, `@emnapi/runtime` and `emnapi`
  2.0.0-beta.3, pinned exactly, because napi-build 2.6 needs the 2.0 archive layout. A stable 2.0 should
  replace it before the first release.
- **WebAssembly is slow per buffer, worst on Node 24.** Each buffer passed costs 18 to 53 µs under Node and
  Deno (6.7 µs under Bun), so a call per document on the fallback is 7 (Bun) to 28 (Node 24) times slower
  than native. Only the batch entry points are fit for it; a deployment that ends up on the fallback should be
  told so (a startup warning naming the platform).
- **Deno permission prompt.** In an interactive terminal, Deno asks for the FFI permission instead of
  refusing it; the loader only falls back after a refusal. The real loader should query
  `Deno.permissions` first and go straight to WebAssembly when FFI is not granted.
- **Single executable needs a generated entry.** A loader cannot make `bun build --compile` embed the addon by
  itself; the binary build of [S9](S9-single-binary.md) must import the target's `.node` file by a literal path
  per Bun target, and its smoke step must check `engine()`.
- **Rust matcher speed.** Checking a 223 byte document with `RawDocument::new` takes about 500 ns, more than
  matching it for the simple filters, and the matcher on its own is slower than the TypeScript matcher on
  decoded documents. The stage 1 gate of [14 §8](../plan/14-native-core.md#8-stages-and-gates) (3 times the
  TypeScript matcher) holds against decode plus match, not against match alone, so the gate should say which
  one it means. A validation that only walks the fields a filter reads would help most.
- **Licenses.** Unicode 3.0 (unicode-ident, build time only) and PSF 2.0 (argparse, in the napi CLI) need the
  decisions listed above before `cargo deny` and `licenses.ts` gate the real package.
