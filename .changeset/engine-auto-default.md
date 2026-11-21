---
"@canopy/config": minor
"@canopy/native": minor
"@canopy/realtime": minor
"@canopy/server": minor
---

`server.engine` defaults to `auto`: the server and the sidecar run the Rust core through the `@canopy/native`
addon when it loads, else its WebAssembly build, else the TypeScript packages. `selectEngine("auto")` makes the
same choice and its `kind` names the result. `native` and `wasm` still refuse to start without their build, and
`ts` keeps the TypeScript core.
