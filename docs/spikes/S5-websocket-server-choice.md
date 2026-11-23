# S5: `Bun.serve`, `ws` or uWebSockets.js?

- **Date:** recorded 2026-11-13, after the implementation settled the question
- **Status:** the choice is made and shipped; the fan out cost at 10k to 50k connections over a real network
  was not measured, and the CPU model of [03 §13](../design/03-realtime-engine.md#13-scaling-out) is not
  calibrated.
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes),
  [ADR 0001](../adr/0001-typescript-6-and-bun.md)

## Question

Which WebSocket server should the engine use on each runtime, and what does fan out cost?

## Choice in the code

| Runtime | Server | Where |
|---|---|---|
| Bun (primary) | `Bun.serve` WebSockets | `bunHandlers` in `packages/realtime/src/transports.ts`; tested under Bun by `packages/realtime/test/bun-handlers.test.ts` and by the WebSocket step of the binary smoke test (`deploy/binary/ws-smoke.ts`) |
| Node.js | `ws`, attached to any `node:http` server | `attach` in the same file, used by the sidecar and the Express example; Fastify and Hono run on Node servers too |
| Deno | the Node path through `node:http` | nightly job |
| Edge | Cloudflare Durable Objects | [S8](S8-durable-objects-fan-out.md) |

uWebSockets.js is not used: it is a native module without prebuilt binaries for every supported platform
(Windows, Linux glibc and musl, macOS, x64 and arm64), which the repository rules forbid for the default
install. An optional adapter was planned for the scale phase; the native gateway of Phase 5 ([12 §3.5](../design/12-roadmap.md#35-phase-5-native-core-in-rust--v06-10-weeks)) replaces it unless spike S11 rejects the gateway.

Both transports share one `RealtimeSocket` abstraction with `bufferedAmount` backpressure, a 256 KiB frame
limit and encode once fan out, so the engine's cost does not depend on the server.

## Evidence

- Engine cost without the network: `bench/workloads/realtime/fanout.ts` opens many in process connections on
  a million document collection, drives writes from a separate process and measures write to delivery latency
  against a plain change stream baseline (`stream-probe.ts`). It is gated by the nightly scale job for the
  REST ratios; the fan out numbers are not recorded in the repository.
- Correctness of both transports: `realtime.test.ts` (Node, `ws`) and `bun-handlers.test.ts` (Bun).

## Not done

A per server comparison (memory per connection, messages per second, p99) at 10k to 50k sockets. Do it on
the reference hardware in spike S11 at the start of Phase 5, against the native gateway as well, then update the CPU model.
