import type { IncomingMessage, ServerResponse } from "node:http"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import type * as Otel from "@opentelemetry/api"
import type { MongoClient } from "mongodb"

/** Span attributes. */
type TraceAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Canopy's spans, recorded through the OpenTelemetry API. Spans go nowhere until the app registers an SDK
 * (for example `node --import ./otel.mjs`), which also picks the exporter and the sampler.
 */
export interface Tracing {
  /** Runs `run` inside a span, ending it when the returned value (or promise) settles. */
  span<T>(name: string, attributes: TraceAttributes, run: () => T): T
  /** Serves a fetch request inside a server span that continues the caller's `traceparent`. */
  fetch(request: Request, run: () => Promise<Response>): Promise<Response>
  /** Serves a `node:http` request inside a server span that ends when the response is sent. */
  node(request: IncomingMessage, response: ServerResponse, run: () => void): void
  /** Records a client span for every MongoDB command of `client` (it needs `monitorCommands: true`). */
  instrument(client: MongoClient): void
}

/** The low cardinality route of a path, so span names do not carry collection names or ids. */
function routeOf(path: string): string {
  const match = /^\/(rest|graphql|realtime|auth|admin)\/v1(?:\/|$)/.exec(path)
  if (match !== null) return `/${match[1]}/v1`
  if (path === "/healthz" || path === "/readyz" || path === "/.well-known/jwks.json") return path
  if (path === "/studio" || path.startsWith("/studio/")) return "/studio"
  return "other"
}

const QUIET_COMMANDS = new Set([
  "hello",
  "ismaster",
  "isMaster",
  "ping",
  "saslStart",
  "saslContinue",
  "buildInfo",
  "endSessions",
])

/** Loads the OpenTelemetry API, which is an optional peer dependency of `@canopy/server`. */
export async function loadTracing(): Promise<Tracing> {
  let api: typeof Otel
  try {
    api = await import("@opentelemetry/api")
  } catch (error: unknown) {
    throw new CanopyError(
      ErrorCode.Internal,
      "Tracing needs the @opentelemetry/api package: install it next to @canopy/server, or turn tracing off",
      { cause: error },
    )
  }
  const tracer = api.trace.getTracer("canopy")
  const { context, propagation, SpanKind, SpanStatusCode } = api

  const fail = (span: Otel.Span, error: unknown): void => {
    span.setStatus({ code: SpanStatusCode.ERROR })
    if (error instanceof Error) span.recordException(error)
  }

  const finishHttp = (span: Otel.Span, status: number): void => {
    span.setAttribute("http.response.status_code", status)
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  }

  const serverSpan = (method: string, path: string, carrier: Record<string, string>) => {
    const parent = propagation.extract(context.active(), carrier)
    const route = routeOf(path)
    const span = tracer.startSpan(
      `${method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": method, "http.route": route, "url.path": path },
      },
      parent,
    )
    return { span, active: api.trace.setSpan(parent, span) }
  }

  return {
    span(name, attributes, run) {
      return tracer.startActiveSpan(name, { attributes }, (span) => {
        let result: ReturnType<typeof run>
        try {
          result = run()
        } catch (error: unknown) {
          fail(span, error)
          span.end()
          throw error
        }
        if (result instanceof Promise) {
          result.then(
            () => span.end(),
            (error: unknown) => {
              fail(span, error)
              span.end()
            },
          )
        } else span.end()
        return result
      })
    },

    async fetch(request, run) {
      const carrier: Record<string, string> = {}
      for (const name of ["traceparent", "tracestate", "baggage"]) {
        const value = request.headers.get(name)
        if (value !== null) carrier[name] = value
      }
      const { span, active } = serverSpan(request.method, new URL(request.url).pathname, carrier)
      try {
        const response = await context.with(active, run)
        finishHttp(span, response.status)
        return response
      } catch (error: unknown) {
        fail(span, error)
        span.end()
        throw error
      }
    },

    node(request, response, run) {
      const carrier: Record<string, string> = {}
      for (const name of ["traceparent", "tracestate", "baggage"]) {
        const value = request.headers[name]
        if (typeof value === "string") carrier[name] = value
      }
      const path = (request.url ?? "/").split("?")[0] ?? "/"
      const { span, active } = serverSpan(request.method ?? "GET", path, carrier)
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        finishHttp(span, response.statusCode)
      }
      response.once("finish", end)
      response.once("close", end)
      context.with(active, run)
    },

    instrument(client) {
      const spans = new Map<string, Otel.Span>()
      const key = (event: { connectionId?: unknown; requestId: number }) =>
        `${String(event.connectionId)}:${event.requestId}`
      client.on("commandStarted", (event) => {
        if (QUIET_COMMANDS.has(event.commandName)) return
        const target = event.command[event.commandName]
        const span = tracer.startSpan(
          `${event.commandName} ${event.databaseName}${typeof target === "string" ? `.${target}` : ""}`,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              "db.system.name": "mongodb",
              "db.namespace": event.databaseName,
              "db.operation.name": event.commandName,
              ...(typeof target === "string" ? { "db.collection.name": target } : {}),
            },
          },
          context.active(),
        )
        spans.set(key(event), span)
      })
      client.on("commandSucceeded", (event) => {
        const span = spans.get(key(event))
        if (span === undefined) return
        spans.delete(key(event))
        span.end()
      })
      client.on("commandFailed", (event) => {
        const span = spans.get(key(event))
        if (span === undefined) return
        spans.delete(key(event))
        fail(span, event.failure)
        span.end()
      })
    },
  }
}
