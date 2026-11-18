import { NotFoundError, ValidationError } from "@canopy/protocol"
import type { Webhooks } from "../../webhooks/webhooks.ts"
import { json } from "../http.ts"
import type { AdminDeps, RouteFn } from "./core.ts"

/** Registers the trigger, schedule and dead letter routes. */
export function registerWebhooks(route: RouteFn, deps: AdminDeps): void {
  const hooks = (): Webhooks => {
    const webhooks = deps.options.webhooks
    if (webhooks === undefined) throw new NotFoundError("No trigger or schedule is configured")
    return webhooks
  }
  route("GET", "webhooks", "webhooks.read", async () => json({ data: await hooks().hooks() }))
  route("GET", "webhooks/dead-letters", "webhooks.read", async (context) => {
    const search = context.url.searchParams
    const limit = search.get("limit")
    if (limit !== null && !/^\d{1,3}$/.test(limit))
      throw new ValidationError("limit must be a number from 1 to 500")
    const hook = search.get("hook")
    return json({
      data: await hooks().deadLetters({
        ...(hook === null ? {} : { hook }),
        ...(limit === null ? {} : { limit: Number(limit) }),
      }),
    })
  })
  route(
    "POST",
    "webhooks/dead-letters/:id/retry",
    "webhooks.manage",
    async (context) => {
      const id = context.params["id"] ?? ""
      if (!(await hooks().retry(id))) throw new NotFoundError("No such dead letter")
      await context.audit({ action: "webhooks.retry", target: { delivery: id } })
      return json({ id, requeued: true })
    },
    "webhooks.retry",
  )
  route(
    "DELETE",
    "webhooks/dead-letters/:id",
    "webhooks.manage",
    async (context) => {
      const id = context.params["id"] ?? ""
      if (!(await hooks().discard(id))) throw new NotFoundError("No such dead letter")
      await context.audit({ action: "webhooks.discard", target: { delivery: id } })
      return json({ id, deleted: true })
    },
    "webhooks.discard",
  )
  route(
    "POST",
    "webhooks/:name/run",
    "webhooks.manage",
    async (context) => {
      const name = context.params["name"] ?? ""
      const id = await hooks().run(name)
      if (id === undefined) throw new NotFoundError(`No schedule is named ${name}`)
      await context.audit({ action: "webhooks.run", target: { schedule: name }, details: { id } })
      return json({ id }, 202)
    },
    "webhooks.run",
  )
}
