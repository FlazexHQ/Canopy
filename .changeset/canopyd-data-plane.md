---
"@canopy/config": patch
"@canopy/realtime": patch
"@canopy/server": patch
---

Use `canopyd` as the native data plane executable on all platforms. The launcher prefers `CANOPYD_BIN` and still accepts `CANOPY_GATEWAY_BIN`. Update native metrics queries to use the `canopyd_` prefix.