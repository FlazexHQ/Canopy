---
"@canopy/server": patch
"@canopy/realtime": patch
"@canopy/cli": patch
---

Windows support. `canopy-server` and `canopy-realtime` drain and stop cleanly on Windows: besides SIGTERM
and SIGINT they handle SIGBREAK (Ctrl+Break) and a `"shutdown"` IPC message, which process managers such as
PM2 send on Windows, where SIGTERM does not exist. The `canopy` CLI keeps its credentials and environments
files in `%APPDATA%\canopy` on Windows (still `$XDG_CONFIG_HOME/canopy` when that is set, and
`~/.config/canopy` on Linux and macOS), and `canopy init` lists the files it writes with `/` on every
platform.
