---
"@canopy/config": minor
"@canopy/server": patch
"@canopy/realtime": patch
---

`@canopy/config/process` holds the JSON logger, the shutdown hook and the argument parser that `canopy-server` and `canopy-realtime` share. The logger refuses an unknown level instead of falling back to `debug`, and logged fields can no longer overwrite `level`, `time` or `msg`. `canopy-realtime` now refuses unknown options, prints `--help`, redacts secrets in its logs and logs `stopped` after a clean shutdown, like `canopy-server`.
