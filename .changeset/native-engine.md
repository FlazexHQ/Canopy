---
"@canopy/native": minor
"@canopy/realtime": minor
"@canopy/config": minor
"@canopy/server": minor
---

New package `@canopy/native`: the Rust core (policy engine, event matcher, query canonicalization and the
EJSON codec) as a prebuilt Node-API addon for Bun, Node and Deno, with a WebAssembly fallback for platforms
without a prebuilt build and for Deno without `--allow-ffi`. Its policy engine keeps the API of
`PolicyEngine` and refuses to start when it computes another bundle version than TypeScript.

The realtime engine, the `canopy-realtime` sidecar and the server take an `engine` option (`server.engine`
in the config, or `CANOPY_ENGINE`): `ts` (the default) keeps the TypeScript packages, `native` and `wasm`
evaluate policies and match change events in Rust. Both give equal results; `native` and `wasm` refuse to
start when their build cannot load instead of running another implementation.

Studio's policy simulation of a draft definition evaluates it on the configured engine too, so "view as user"
answers exactly as the server will once the draft is saved.

The `canopy-server` startup log names the engine, and the standalone executables embed the addon of their
target when it is built, so `engine: "native"` works without `node_modules`.
