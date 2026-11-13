---
"@canopy/policy": patch
"@canopy/rest": patch
"@canopy/cli": patch
---

`immutable` now covers fields inside array elements: with `immutable: ["lines.sku"]`, a write to `lines.0.sku`, to `lines.$[].sku` or of a whole element such as `lines.0` is refused, as a write to `lines.sku` already was. The policy test runner and `canopy policies test` apply the same rule. `immutableViolations` moves to `@canopy/policy`; `@canopy/rest` still exports it.
