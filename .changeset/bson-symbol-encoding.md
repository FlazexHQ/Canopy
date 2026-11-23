---
"@canopy/protocol": patch
---

The Extended JSON encoder writes a BSON symbol, the deprecated string type that MongoDB sorts and compares with strings, as a plain string in both the relaxed and the canonical encoding. It used to refuse it with `Cannot encode BSON type BSONSymbol`, so a response, a cursor or an event that held a symbol failed with a 400. Decoding is unchanged. The Rust codec in `canopy-protocol` does the same.
