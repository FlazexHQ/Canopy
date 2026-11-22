import { amendConfig, ConfigError, type ResolvedConfig } from "@canopy/config"
import type { CreateCanopyOptions } from "./canopy.ts"

/**
 * The part of Canopy one server process runs, chosen with `CANOPY_ROLE`.
 *
 * `all` (the default) runs the whole platform in one process.
 *
 * `api` serves the Data API, GraphQL, built in auth, storage, the admin API and webhooks. Realtime is off, and
 * GraphQL subscriptions follow their live queries through the realtime service at `CANOPY_REALTIME_URL`.
 *
 * `realtime` serves realtime connections. It keeps the transactional write path for realtime mutations, but
 * runs no admin API, no Studio, no file storage and no webhooks, so none of them runs twice.
 *
 * A front door routes each path to the process that owns it, so one failing service leaves the others up.
 */
export type ServerRole = "all" | "api" | "realtime"

const ROLES: readonly ServerRole[] = ["all", "api", "realtime"]

/** Reads `CANOPY_ROLE`, which defaults to `all`. */
export function parseServerRole(value: string | undefined): ServerRole {
  const role = value === undefined || value.trim() === "" ? "all" : value.trim()
  if ((ROLES as readonly string[]).includes(role)) return role as ServerRole
  throw new ConfigError(undefined, [
    {
      path: "CANOPY_ROLE",
      message: `must be one of ${ROLES.join(", ")}, not ${JSON.stringify(role)}`,
      missing: false,
    },
  ])
}

/** What a role changes: the config the process runs with, and options of `createCanopy`. */
export interface RolePlan {
  readonly config: ResolvedConfig
  readonly options: Pick<CreateCanopyOptions, "admin" | "studio" | "realtimeUrl" | "serves">
}

function isRealtimePath(pathname: string): boolean {
  return pathname === "/realtime/v1" || pathname.startsWith("/realtime/v1/")
}

/**
 * Narrows a resolved config to what `role` runs. `realtimeUrl` is the internal URL of the realtime service,
 * used by the `api` role for GraphQL subscriptions.
 */
export function planServerRole(
  config: ResolvedConfig,
  role: ServerRole,
  realtimeUrl?: string,
): RolePlan {
  switch (role) {
    case "all":
      return { config, options: {} }
    case "api":
      return {
        config: amendConfig(config, { realtime: false }),
        options: {
          studio: false,
          serves: (path) =>
            !isRealtimePath(path) && path !== "/studio" && !path.startsWith("/studio/"),
          ...(realtimeUrl === undefined || realtimeUrl === ""
            ? {}
            : { realtimeUrl: () => realtimeUrl }),
        },
      }
    case "realtime":
      if (config.realtime === false)
        throw new ConfigError(config.file, [
          {
            path: "realtime",
            message: "is turned off, so a server with CANOPY_ROLE=realtime has nothing to serve",
            missing: false,
          },
        ])
      return {
        config: amendConfig(config, {
          webhooks: { ...config.webhooks, triggers: {}, schedules: {} },
          storage: false,
        }),
        options: {
          admin: false,
          studio: false,
          serves: (path) => isRealtimePath(path) || path === "/healthz" || path === "/readyz",
        },
      }
  }
}
