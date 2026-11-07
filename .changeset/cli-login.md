---
"@canopy/cli": minor
---

Add `canopy login <url>` and `canopy logout <url>`. The admin token of a remote project goes into the
macOS Keychain or the Linux Secret Service when available, otherwise into a `0600` credentials file
(`$XDG_CONFIG_HOME/canopy/credentials.json`, or `CANOPY_CREDENTIALS`). Tokens are only sent over HTTPS
outside localhost. The package README documents every command and the fallback.
