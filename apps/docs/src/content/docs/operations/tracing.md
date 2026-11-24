---
title: Metrics and tracing
description: Prometheus metrics, and OpenTelemetry traces of requests, MongoDB commands and realtime fan out.
---

## Metrics

Each instance serves Prometheus metrics on its own port (9464, `METRICS_PORT`), bound to `127.0.0.1` unless
`METRICS_HOST` says otherwise, and protected by a bearer token when `CANOPY_METRICS_TOKEN` is set. The most
useful series:

| Metric                                         | What it tells you                                       |
| ---------------------------------------------- | ------------------------------------------------------- |
| `canopy_changestream_lag_seconds`              | how far realtime is behind the oplog                    |
| `canopy_changestream_restarts_total{reason}`   | change stream restarts; `history_lost` means a resync   |
| `canopy_http_rate_limited_total{surface}`      | requests refused by the rate limits                     |
| `canopy_realtime_rate_limited_total{kind}`     | realtime frames, connections and handshakes refused     |
| `canopy_policy_variable_errors_total`          | policy variables that failed to resolve (denials)       |

## Tracing

Set `telemetry.tracing: true` (or `CANOPY_TRACING=true`) and install `@opentelemetry/api` next to
`@canopy/server` (it is an optional peer dependency). Canopy then records spans through the OpenTelemetry
API:

| Span                                   | Kind   | When                                                        |
| -------------------------------------- | ------ | ----------------------------------------------------------- |
| `GET /rest/v1`, `POST /graphql/v1`, ... | server | every HTTP request, named by route (no collection or id)    |
| `find app.todos`, `commitTransaction admin`, ... | client | every MongoDB command, as a child of the request that caused it |
| `canopy.realtime.fanout`               | internal | every batch of change events routed to subscribers        |
| `canopy.policy.load`                   | internal | every policy set loaded or reloaded                       |

An incoming `traceparent` (and `tracestate`, `baggage`) header is continued, so a trace that starts in your app
or at your load balancer carries on through Canopy and into MongoDB. Spans never carry document contents,
filters or credentials: MongoDB spans name the command, database and collection only.

The API alone exports nothing. Register an SDK in the process before Canopy starts, for example with the OTLP
exporter:

```js
// otel.mjs
import { NodeSDK } from "@opentelemetry/sdk-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

new NodeSDK({ serviceName: "canopy", traceExporter: new OTLPTraceExporter() }).start()
```

```sh
node --import ./otel.mjs node_modules/@canopy/server/dist/bin/canopy-server.js
```

The SDK reads the standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER` and related variables. Sample in
production (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.05`): a realtime
deployment issues many MongoDB commands.

When you embed Canopy with your own `MongoClient` (`createCanopy(config, { mongo })`), create it with
`monitorCommands: true`, or MongoDB commands are not traced. A client Canopy creates itself has it turned on
whenever tracing is.

### The native gateway

When the native gateway runs (`CANOPY_REALTIME_SERVER=gateway`, or `canopyd` on its own), it records the
same request, MongoDB command and policy load spans for the requests it answers itself, with no package to
install: turn it on with the same `telemetry.tracing` (or `CANOPY_TRACING=true`). It exports them over OTLP/HTTP
with protobuf, configured by the standard variables: `OTEL_EXPORTER_OTLP_ENDPOINT` (or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER` and
`OTEL_TRACES_SAMPLER_ARG`, `OTEL_BSP_SCHEDULE_DELAY` and `OTEL_SERVICE_NAME` (by default `canopy`). It refuses
to start when `OTEL_EXPORTER_OTLP_PROTOCOL` names another protocol, such as `grpc`, and records nothing when
`OTEL_SDK_DISABLED=true`. Requests it passes on to the server get no gateway span; the server continues the
caller's trace.
