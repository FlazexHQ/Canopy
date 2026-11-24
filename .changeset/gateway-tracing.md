---
"@canopy/realtime": minor
---

`canopy-gateway` records OpenTelemetry traces when `telemetry.tracing` (or `CANOPY_TRACING`) is on, as the
server does: a server span for every request a Rust route answers, continuing the caller's `traceparent`, a client
span for every MongoDB command and `canopy.policy.load`. They are exported over OTLP/HTTP with protobuf as the
standard `OTEL_*` variables say. The launcher now passes `telemetry.tracing` to the gateway.
