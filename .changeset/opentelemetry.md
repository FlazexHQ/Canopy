---
"@canopy/server": minor
"@canopy/config": minor
"@canopy/realtime": minor
---

OpenTelemetry tracing: with `telemetry.tracing` (`CANOPY_TRACING`) and `@opentelemetry/api` installed, the server records spans for HTTP requests (continuing `traceparent`), MongoDB commands, realtime fan out and policy loads. The realtime engine takes a `span` option for its own spans.
