---
"@canopy/realtime": minor
---

With `writes` selected, `canopy-gateway` runs the mutations of its realtime connections in its own write path
instead of forwarding them to the TypeScript server: the same policies, transaction and idempotency record as the
forwarded write, without the loopback request. `CANOPY_GATEWAY_MUTATIONS_URL` is no longer needed then.
