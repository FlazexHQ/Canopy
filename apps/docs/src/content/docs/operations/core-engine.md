---
title: Core engine
description: Run policy evaluation and change event matching on the TypeScript core, the native Rust core or its WebAssembly build.
---

Canopy evaluates Document Level Security policies and matches change events against subscriptions in its
core. The core exists twice: in TypeScript, and in Rust as `@canopy/native`. `server.engine`
(`CANOPY_ENGINE`) chooses which one a server or a `canopy-realtime` sidecar runs:

| Engine   | What runs                                                         | When to use it                                    |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `auto`   | the addon, else its WebAssembly build, else TypeScript (the default) | everywhere                                     |
| `ts`     | the TypeScript packages                                           | everywhere, and the reference for the others      |
| `native` | the prebuilt Node-API addon of `@canopy/native`                   | Linux, Windows and macOS on x64 and arm64         |
| `wasm`   | the same Rust code built for WebAssembly (`wasm32-wasip1-threads`) | a platform without a prebuilt addon, Deno without `--allow-ffi` |

All three give the same answers: the same compiled MongoDB filters byte for byte, the same matcher decisions
and the same bundle version for a policy set. A server on `native` or `wasm` refuses to start when it computes
a different bundle version than TypeScript would, and when its build cannot load it stops with
`CANOPY_UNAVAILABLE` instead of quietly running another engine. `auto` runs the first of the addon, its
WebAssembly build and the TypeScript packages that loads. The startup log line `canopy listening` names the
engine that runs in its `engine` field.

```ts
// canopy.config.ts
import { defineConfig } from "@canopy/server"

export default defineConfig({
  server: { engine: "native" },
})
```

## Installing

Nothing needs a Rust toolchain. `@canopy/native` lists one package per platform as an optional dependency
(`@canopy/native-linux-x64-gnu`, `@canopy/native-win32-arm64-msvc` and so on, plus
`@canopy/native-wasm32-wasi`), and Bun, pnpm, Yarn and npm install only the one that matches the machine. If
the package of your platform is missing, `native` refuses to start, `wasm` still works and `auto` runs `wasm`.

Installing with `--omit=optional` (npm) or from a `node_modules` folder copied from another platform can leave
the addon out. Install on the platform that runs Canopy.

## Runtimes

- **Bun and Node.js** load the addon directly.
- **Deno** needs `--allow-ffi` for the addon. Without it the loader takes the WebAssembly build and never asks
  for the permission, so an interactive terminal shows no prompt.
- **The standalone executables** (`canopy`, `canopy-server`) embed the addon of their target when it is
  built with them, so `native` works without `node_modules`. One built without it refuses `native` with
  `CANOPY_UNAVAILABLE`.

## Choosing

`auto` is the default, so the Rust core runs wherever `@canopy/native` installed a build. Set `ts` to keep the
TypeScript core, or `native` to make a missing addon stop the server rather than fall back. CI runs the test
suites, including the policy bypass corpus and the security invariants, on all three engines, and compares the
Rust and TypeScript cores against MongoDB in the differential suites. Switching engines is a restart; nothing
is stored differently.
