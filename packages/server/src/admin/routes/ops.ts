import { addressAllowed } from "@canopy/auth"
import { NotFoundError, ValidationError } from "@canopy/protocol"
import { fromDriverError, probeSearch, searchDiagnostics } from "@canopy/rest"
import { migrationStatus } from "../../migrations.ts"
import type { RequestSurface } from "../../request-log.ts"
import { json } from "../http.ts"
import { settingsPatch } from "../settings.ts"
import type { AdminDeps, Context, RouteFn } from "./core.ts"

/** Registers the doctor, audit, logs, settings and danger zone routes. */
export function registerOps(route: RouteFn, deps: AdminDeps): void {
  const { options, config, accounts, audit, settings, realtime, environment, production, app } =
    deps
  route("GET", "doctor", "ops.doctor", async (context) => {
    const checks: { name: string; status: "ok" | "warn" | "fail"; message: string }[] = []
    const add = (name: string, status: "ok" | "warn" | "fail", message: string): void => {
      checks.push({ name, status, message })
    }
    try {
      const hello = await app.command({ hello: 1 })
      const build = await app.command({ buildInfo: 1 })
      add("mongodb", "ok", `MongoDB ${String(build["version"])}`)
      if (typeof hello["setName"] === "string")
        add("replica-set", "ok", `Replica set ${hello["setName"]}`)
      else add("replica-set", "fail", "Change streams and transactions need a replica set")
    } catch (error: unknown) {
      add("mongodb", "fail", error instanceof Error ? error.message : "MongoDB is unreachable")
    }
    const migrations = await migrationStatus(options.client.db(config.mongodb.metaDatabase))
    const pending = migrations.filter((m) => m.appliedAt === undefined)
    add(
      "meta-migrations",
      pending.length === 0 ? "ok" : "fail",
      pending.length === 0
        ? "The meta database is up to date"
        : `${pending.length} migration(s) pending`,
    )
    add(
      "master-key",
      config.masterKey === undefined ? (production ? "fail" : "warn") : "ok",
      config.masterKey === undefined
        ? "No master key: stored secrets are not encrypted"
        : "Stored secrets are encrypted",
    )
    add(
      "admin-listener",
      config.server.adminListen === undefined ? (production ? "warn" : "ok") : "ok",
      config.server.adminListen === undefined
        ? "/admin is served on the public listener; set CANOPY_ADMIN_LISTEN to keep it private"
        : `/admin is served only on ${config.server.adminListen}`,
    )
    add(
      "policies",
      "ok",
      `Bundle ${options.engine().version}, ${options.engine().set.collections.size} collection(s)`,
    )
    if (realtime !== undefined) {
      const stats = realtime.stats()
      add("realtime", "ok", `${stats.connections} connection(s), stream at ${stats.streamPosition}`)
    }
    if (options.auth?.revocationsFollowing !== undefined)
      add(
        "revocations",
        options.auth.revocationsFollowing ? "ok" : "fail",
        options.auth.revocationsFollowing
          ? "Sign outs and bans on other nodes apply here at once"
          : "Not following other nodes' revocations: their sign outs and bans apply here only once following resumes",
      )
    const search = Object.keys(config.collections).filter(
      (name) => config.collections[name]?.search === true,
    )
    try {
      const capability = await probeSearch(app, search, { signal: context.request.signal })
      for (const [index, check] of searchDiagnostics(capability, search.length).entries())
        add(index === 0 ? "search" : "search-index", check.status, check.message)
    } catch (error: unknown) {
      add(
        "search",
        "warn",
        `search: could not be checked: ${fromDriverError(error, false).message}`,
      )
    }
    const status = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "warn")
        ? "warn"
        : "ok"
    return json({ status, environment, checks })
  })

  route("GET", "audit", "ops.audit", async (context) => {
    const search = context.url.searchParams
    const action = search.get("action")
    const actor = search.get("actor")
    const before = search.get("before")
    const limit = Number(search.get("limit") ?? "100")
    const entries = await audit.list({
      ...(action === null ? {} : { action }),
      ...(actor === null ? {} : { actorId: actor }),
      ...(before === null ? {} : { before }),
      limit: Number.isFinite(limit) ? limit : 100,
    })
    return json({ data: entries, next: entries.length === 0 ? null : String(entries.at(-1)?._id) })
  })

  const SURFACES: readonly RequestSurface[] = ["rest", "graphql", "auth", "admin", "realtime"]
  /**
   * `GET /admin/v1/logs`: sampled requests, newest first, as `{ data, next }`. Filters: `surface` (rest,
   * auth, admin, realtime), `status` (an exact code or a class such as `5xx`), `before` (the `next` of the
   * previous page) and `limit` (1 to 1000, default 100). Entries hold the method, path, status, duration,
   * peer address and request id, never query strings, headers or bodies.
   */
  route("GET", "logs", "ops.audit", async (context) => {
    const log = options.requestLog
    if (log === undefined) throw new NotFoundError("Request logging is not available")
    const search = context.url.searchParams
    const surface = search.get("surface")
    if (surface !== null && !SURFACES.includes(surface as RequestSurface))
      throw new ValidationError(`surface must be one of ${SURFACES.join(", ")}`)
    const statusText = search.get("status")
    let status: number | `${1 | 2 | 3 | 4 | 5}xx` | undefined
    if (statusText !== null) {
      if (/^[1-5]xx$/.test(statusText)) status = statusText as `${1 | 2 | 3 | 4 | 5}xx`
      else if (/^[1-5]\d\d$/.test(statusText)) status = Number(statusText)
      else throw new ValidationError("status must be a code such as 404 or a class such as 5xx")
    }
    const before = search.get("before")
    const limit = Number(search.get("limit") ?? "100")
    const entries = await log.list({
      ...(surface === null ? {} : { surface: surface as RequestSurface }),
      ...(status === undefined ? {} : { status }),
      ...(before === null ? {} : { before }),
      limit: Number.isFinite(limit) ? limit : 100,
    })
    return json({
      data: entries,
      next: entries.length === 0 ? null : String(entries.at(-1)?._id),
      sampleRate: settings.current.requestLogSampleRate,
      retentionDays: settings.current.requestLogRetentionDays,
    })
  })

  route("GET", "settings", "settings.read", async () => json(await settings.get()))

  route(
    "PATCH",
    "settings",
    "settings.write",
    async (context) => {
      const patch = settingsPatch.parse(await context.body())
      const allowlist = patch.adminAllowlist
      if (
        allowlist !== undefined &&
        allowlist.length > 0 &&
        !addressAllowed(context.origin.ip, allowlist)
      )
        throw new ValidationError(
          `The allowlist does not include your address (${context.origin.ip ?? "unknown"}), so saving it would lock you out`,
          { details: { path: "adminAllowlist", reason: "lockout" } },
        )
      return json(await settings.update(patch, context.actor, context.origin))
    },
    "settings.update",
  )

  const confirmPhrase = (context: Context, phrase: string): void => {
    if (context.request.headers.get("x-canopy-confirm") !== phrase)
      throw new ValidationError(`Confirm with the phrase "${phrase}" in x-canopy-confirm`, {
        details: { reason: "confirmation" },
      })
  }

  /**
   * `POST /admin/v1/settings/revoke-all-sessions`: ends every admin session (the caller's included) and,
   * with built in auth, every app user session, revoking the access tokens issued until now so their
   * realtime connections close. Admin API tokens stay valid.
   */
  route(
    "POST",
    "settings/revoke-all-sessions",
    "admins.manageOwners",
    async (context) => {
      confirmPhrase(context, "revoke all sessions")
      const users = options.auth === undefined ? 0 : await options.auth.users.revokeAllSessions()
      const admins = await accounts.endAllSessions()
      await context.audit({
        action: "danger.revoke_all_sessions",
        details: { userSessions: users, adminSessions: admins },
      })
      return new Response(null, { status: 204 })
    },
    "danger.revoke_all_sessions",
  )

  /**
   * `POST /admin/v1/settings/rotate-master-key`: seals every stored secret again with the current master
   * key. Rotate by setting the new key in `CANOPY_MASTER_KEY` and the old one in
   * `CANOPY_MASTER_KEY_PREVIOUS` on every node, calling this, then removing `CANOPY_MASTER_KEY_PREVIOUS`.
   */
  route(
    "POST",
    "settings/rotate-master-key",
    "admins.manageOwners",
    async (context) => {
      confirmPhrase(context, "rotate master key")
      if (config.masterKey === undefined)
        throw new ValidationError("There is no master key: set CANOPY_MASTER_KEY first")
      const resealed = await accounts.resealSecrets()
      await context.audit({ action: "danger.rotate_master_key", details: { resealed } })
      return new Response(null, { status: 204 })
    },
    "danger.rotate_master_key",
  )
}
