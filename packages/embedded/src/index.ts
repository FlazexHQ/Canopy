import type { Server } from "node:http"
import { amendConfig, ConfigError, type ResolvedConfig } from "@canopy/config"
import { type NodeListener, type PeerInfo, toNodeListener } from "@canopy/node-http"
import { type CreateCanopyOptions, createCanopy } from "@canopy/server"

export { type ResolvedConfig, resolveConfig } from "@canopy/config"

/** Options for starting Canopy inside an application. */
export type EmbeddedCanopyOptions = Pick<
  CreateCanopyOptions,
  "logger" | "migrate" | "mongo" | "policies"
>

/** The embedded data routes and their lifecycle. */
export interface EmbeddedCanopy extends AsyncDisposable {
  /** Serves the configured data routes and passes the peer address to their rate limits. */
  fetch(request: Request, info?: PeerInfo): Promise<Response>
  /** A listener for Node HTTP or Express. Mount it before request body parsers. */
  readonly node: NodeListener
  /** Accepts realtime and GraphQL WebSocket upgrades on the host server. */
  attach(server: Server): Promise<void>
  /** Closes Canopy's resources. A MongoDB client supplied by the host stays open. */
  close(): Promise<void>
}

function serves(path: string): boolean {
  return (
    path === "/graphql/v1" ||
    path === "/graphql/v1/" ||
    ["/rest/v1", "/realtime/v1", "/storage/v1"].some(
      (base) => path === base || path.startsWith(`${base}/`),
    )
  )
}

/**
 * Mounts the configured REST, GraphQL, realtime and storage routes in the host application.
 * Embedded mode is the frozen TypeScript equivalence reference for the Rust data plane.
 * Deployed stacks use `canopyd`. For JWT verification, configure an external issuer and JWKS.
 */
export async function createEmbeddedCanopy(
  config: ResolvedConfig,
  options: EmbeddedCanopyOptions = {},
): Promise<EmbeddedCanopy> {
  if (config.auth?.kind === "builtin") {
    throw new ConfigError(config.file, [
      {
        path: "auth",
        message: "Embedded Canopy requires external JWT verification when auth is configured",
        missing: false,
      },
    ])
  }

  const canopy = await createCanopy(
    amendConfig(config, {
      realtime: config.realtime === false ? false : { ...config.realtime, server: "ts" },
      server: { ...config.server, engine: "ts" },
      webhooks: { ...config.webhooks, triggers: {}, schedules: {} },
    }),
    { ...options, admin: false, studio: false, serves },
  )
  const fetch = (request: Request, info?: PeerInfo) => canopy.fetch(request, undefined, info)
  return {
    fetch,
    node: toNodeListener(fetch, { matches: (url) => serves(url.pathname) }),
    attach: (server) => canopy.attach(server),
    close: () => canopy.close(),
    [Symbol.asyncDispose]: () => canopy[Symbol.asyncDispose](),
  }
}
