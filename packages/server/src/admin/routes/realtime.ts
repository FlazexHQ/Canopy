import { Role } from "@canopy/policy"
import { encode, ForbiddenError, NotFoundError } from "@canopy/protocol"
import type { Realtime } from "@canopy/realtime"
import { object, optional } from "../../schema.ts"
import type { ViewIdentity } from "../../view-tokens.ts"
import { json } from "../http.ts"
import { maskTrace } from "../trace.ts"
import { type AdminDeps, asInput, type RouteFn, viewIdentity } from "./core.ts"

/** Registers the realtime inspection routes. */
export function registerRealtime(route: RouteFn, deps: AdminDeps): void {
  const { options, realtime, anyPublishableKey, require } = deps
  const engineOf = (): Realtime => {
    if (realtime === undefined) throw new NotFoundError("Realtime is turned off")
    return realtime
  }
  route("GET", "realtime/stats", "realtime.stats", async () => {
    const stats = engineOf().stats()
    const history = options.lag?.history() ?? []
    const last = history.at(-1)
    return json({
      ...stats,
      ...(last === undefined ? {} : { lagMs: last.lagMs, eventsPerSecond: last.eventsPerSecond }),
      ...(options.lag === undefined ? {} : { history }),
    })
  })
  route("GET", "realtime/connections", "realtime.inspect", async () =>
    json({ data: engineOf().connections() }),
  )
  route("GET", "realtime/observers", "realtime.inspect", async () =>
    json({ data: engineOf().observers() }),
  )
  route("GET", "realtime/events", "realtime.inspect", async () =>
    json({ data: engineOf().recentEvents(100) }),
  )
  route("GET", "realtime/trace/:eventId", "realtime.inspect", async (context) => {
    const trace = engineOf().trace(context.params["eventId"] ?? "")
    if (trace === undefined) throw new NotFoundError("The event is no longer in the trace buffer")
    return json(context.session.user.role === "viewer" ? maskTrace(trace, options.engine()) : trace)
  })
  /**
   * `POST /admin/v1/realtime/token`: a read only view token and a publishable key, so Studio can follow
   * documents live. With `as` the token impersonates that caller (needs `documents.viewAs`); without it the
   * token reads as `service`, which viewers may not do since their reads are masked.
   */
  route(
    "POST",
    "realtime/token",
    "documents.read",
    async (context) => {
      engineOf()
      if (options.viewTokens === undefined) throw new NotFoundError("View tokens are not available")
      const body = object({ as: optional(asInput) }).parse((await context.body()) ?? {}, "body")
      let identity: ViewIdentity = { roles: [Role.Service], claims: null }
      if (body.as !== undefined) {
        require(context, "documents.viewAs")
        identity = viewIdentity(body.as)
      } else if (context.session.user.role === "viewer") {
        throw new ForbiddenError("Viewers follow live data only as another caller")
      }
      const publishableKey = await anyPublishableKey()
      const { token, expiresAt } = await options.viewTokens.mint(identity)
      await context.audit({
        action: "realtime.token",
        details: { as: body.as ?? { role: Role.Service }, expiresAt: expiresAt.toISOString() },
      })
      return json({ token, publishableKey, expiresAt: expiresAt.toISOString() })
    },
    "realtime.token",
  )
  route("GET", "realtime/tail", "realtime.inspect", async (context) => {
    const engine = engineOf()
    const encoder = new TextEncoder()
    let stop: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const close = (): void => {
      stop?.()
      if (heartbeat !== undefined) clearInterval(heartbeat)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": canopy realtime tail\n\n"))
        stop = engine.tail((event) => {
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.id}\nevent: change\ndata: ${JSON.stringify(encode(event))}\n\n`,
              ),
            )
          } catch {
            close()
          }
        })
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"))
          } catch {
            close()
          }
        }, 15_000)
        context.request.signal.addEventListener("abort", () => {
          close()
          try {
            controller.close()
          } catch {}
        })
      },
      cancel: close,
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    })
  })
}
