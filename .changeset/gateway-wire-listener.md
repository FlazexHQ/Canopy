---
"@canopy/realtime": minor
---

Enable the dedicated MongoDB wire listener with `GatewayOverrides.wire`. The gateway serves policy enforced
reads and writes on its own TCP port, supports SCRAM and OIDC authentication, and can use a PEM certificate
and private key for TLS. The listener is off by default.
