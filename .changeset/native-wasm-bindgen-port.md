---
"@canopy/native": minor
"@canopy/wasm": minor
---

Add `@canopy/wasm`, the Rust core built for `wasm32-unknown-unknown` through wasm-bindgen, for Cloudflare
Workers and browsers where a Node-API addon cannot load. `instantiate` takes the compiled module (on Workers,
`@canopy/wasm/canopy_wasm_bg.wasm`) or its bytes and returns a binding with the names and shapes of the
Node-API port, and the new `engineFromBinding` of `@canopy/native` wraps either one behind the API of the
TypeScript packages. The port tests decide every policy vector and matcher vector on all three builds
(Node-API, WASI fallback and wasm-bindgen) exactly as the TypeScript engine does.
