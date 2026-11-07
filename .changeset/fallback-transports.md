---
"@canopy/realtime": minor
"@canopy/client": minor
"@canopy/rest": minor
---

Add fallback transports for networks that block WebSockets. `createHttpTransport(realtime)` serves the
`canopy.v1` HTTP endpoints: `POST /realtime/v1/sessions` (the `hello` payload, with the key in `apikey`
and the token in `Authorization`), SSE on `…/events` with sequence numbers as event IDs and
`Last-Event-ID` resume, long-polling on `…/poll?after=&wait=`, client frames on `…/messages`, `DELETE`
as `bye`, single use tickets for `EventSource`, `409 CANOPY_SESSION_MOVED` for sessions of another node
and optional CORS. Mount it with `bunHandlers(realtime, { http })` or `toNodeHandler(http)`; the
`canopy-realtime` sidecar serves it, with `CANOPY_CORS_ORIGINS`. A resume from a new connection now takes
over a session whose old connection is still attached, so switching transports keeps the session.

The client gains a transport ladder: with `fallback: () => import("@canopy/client/fallback")` it moves to
SSE and then long-polling after two failed WebSocket handshakes within 10 s, reports the `fallback`
connection status, and probes WebSocket every 60 s to move back up. `@canopy/client/rest-polling` adds
fallback syncing over REST: queries refetch on an interval with `If-None-Match` and stay `stale`, and
mutations go through `_batch` with their mutation IDs. `GET /rest/v1/{collection}` now sends a content
based `ETag` and answers `304` to a matching `If-None-Match`. Queries return to `ready` after a resumed
reconnect instead of staying `stale`.
