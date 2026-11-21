---
"@canopy/realtime": patch
"@canopy/server": patch
---

Accept stored API keys in the native realtime gateway and end sessions when their key is revoked or
deleted. When the gateway fronts a server with built in auth, reject revoked tokens and end their
realtime sessions. Honor trusted proxy addresses and CIDR ranges for WebSocket and HTTP fallback
connections.
