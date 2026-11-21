---
"@canopy/realtime": minor
---

`canopy-gateway` serves the SSE and long polling transports like the TypeScript engine: sessions opened with
`POST /realtime/v1/sessions`, streams with `Last-Event-ID` resume, polls, messages, single use tickets for
`EventSource`, `DELETE` and CORS for the configured origins. The launcher passes `realtime.transports` and
`cors.origins` to the gateway, so a transport that is switched off is refused on both servers.
