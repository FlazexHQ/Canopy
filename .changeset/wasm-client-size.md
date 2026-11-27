---
"@canopy/wasm": patch
---

The client module is 3,786 Brotli bytes smaller (78,049 bytes): number and Decimal128 formatting split strings without the slicing panic path, and array index keys sort without a stable sort.
