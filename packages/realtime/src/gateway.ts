import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ResolvedConfig } from "@canopy/config"
import { type PolicySet, toStored } from "@canopy/policy"
import { toCanonical } from "@canopy/protocol"
import type { Logger } from "./logger.ts"
import { directoryPolicies } from "./policy-source.ts"

const BINARY = process.platform === "win32" ? "canopy-gateway.exe" : "canopy-gateway"

/**
 * Finds the `canopy-gateway` executable: `CANOPY_GATEWAY_BIN`, else a release or debug build of the Cargo
 * workspace this package lives in. Returns `undefined` when there is none.
 */
export function findGatewayBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env["CANOPY_GATEWAY_BIN"]
  if (configured !== undefined && configured !== "") return resolve(configured)
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(dir, "target", profile, BINARY)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** The policies in the stored form the gateway reads: one document per collection plus the context lookups. */
export function storedPolicies(set: PolicySet): { stored: unknown[]; contexts: unknown } {
  return {
    stored: [...set.collections.values()].map((def) => toCanonical(toStored(def, { version: 1 }))),
    contexts: toCanonical(set.contexts),
  }
}

/**
 * The gateway's configuration from the resolved config of `canopy-realtime`. Policies from a directory are
 * passed in stored form, because the gateway cannot evaluate TypeScript; policies in the database are read and
 * watched by the gateway itself.
 */
export function gatewayConfig(
  config: ResolvedConfig,
  policies: { stored: unknown[]; contexts: unknown } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const realtime = config.realtime === false ? undefined : config.realtime
  const auth = config.auth
  if (auth?.kind === "builtin")
    throw new TypeError(
      "built in auth runs in the canopy server; point the gateway at its JWKS with external() instead",
    )
  const limits = config.rateLimits
  return {
    mongodb: {
      uri: config.mongodb.uri,
      database: config.mongodb.database,
      metaDatabase: config.mongodb.metaDatabase,
    },
    server: {
      port: config.server.port,
      metricsPort: config.server.metricsPort,
      metricsHost: config.server.metricsHost,
      ...(config.server.metricsToken === undefined
        ? {}
        : { metricsToken: config.server.metricsToken }),
      nodeId: config.server.nodeId,
    },
    auth:
      auth === undefined
        ? null
        : {
            issuer: auth.issuer,
            ...(auth.audience === undefined ? {} : { audience: auth.audience }),
            ...(auth.jwks === undefined ? {} : { jwks: auth.jwks }),
            ...(auth.jwksUrl === undefined ? {} : { jwksUrl: auth.jwksUrl }),
            ...(auth.algorithms === undefined ? {} : { algorithms: auth.algorithms }),
            ...(auth.rolesClaim === undefined ? {} : { rolesClaim: auth.rolesClaim }),
            allowServiceRoleFromJwt: auth.allowServiceRoleFromJwt === true,
            ...(auth.clockToleranceSeconds === undefined
              ? {}
              : { clockToleranceSeconds: auth.clockToleranceSeconds }),
          },
    keys: {
      ...(config.keys.publishable === undefined ? {} : { publishable: config.keys.publishable }),
      secret: config.keys.secret ?? [],
    },
    policies:
      policies === undefined
        ? { source: "database", watch: "dir" in config.policies ? false : config.policies.watch }
        : policies,
    realtime: {
      fullDocument: realtime?.fullDocument ?? "auto",
      checkpoints: realtime?.checkpoints ?? "meta",
      resumeWindowMs: realtime?.resumeWindowMs ?? 120_000,
      drainWindowMs: realtime?.drainWindowMs ?? 30_000,
      transports: realtime?.transports ?? ["websocket", "sse", "long-poll"],
    },
    ...(config.cors === undefined ? {} : { cors: { origins: config.cors.origins } }),
    rateLimits:
      limits === false
        ? false
        : {
            messages: { perSecond: limits.messages.perSecond, burst: limits.messages.burst },
            anonymousConnectionsPerAddress: limits.anonymousConnectionsPerAddress,
            exemptService: limits.exemptService,
          },
    ...(env["CANOPY_GATEWAY_MUTATIONS_URL"] === undefined
      ? {}
      : { mutations: { url: env["CANOPY_GATEWAY_MUTATIONS_URL"] } }),
    log: { level: config.log.level },
  }
}

/**
 * Runs `canopy-realtime` on the native gateway: resolves the policies, starts the gateway with its
 * configuration on standard input, sends it reloaded policies from a policy directory, and drains it on
 * shutdown by closing its standard input. Resolves with the gateway's exit code.
 */
export async function runGateway(
  config: ResolvedConfig,
  logger: Logger,
  onStop: (stop: () => void) => void,
): Promise<number> {
  const binary = findGatewayBinary()
  if (binary === undefined)
    throw new TypeError(
      "CANOPY_REALTIME_SERVER=gateway needs the canopy-gateway executable: set CANOPY_GATEWAY_BIN or build it with cargo build --release -p canopy-gateway",
    )
  const source = "dir" in config.policies ? directoryPolicies(config.policies.dir) : undefined
  const initial = source === undefined ? undefined : storedPolicies(await source.load())
  const child: ChildProcess = spawn(binary, ["--config", "-"], {
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  })
  child.stdin?.write(`${JSON.stringify(gatewayConfig(config, initial))}\n`)
  const stopWatching =
    source?.watch !== undefined && "dir" in config.policies && config.policies.watch !== false
      ? source.watch(
          (set) => {
            child.stdin?.write(`${JSON.stringify({ t: "policies", ...storedPolicies(set) })}\n`)
          },
          (error) =>
            logger.error({ err: error }, "policy reload rejected, keeping the previous policies"),
        )
      : undefined
  onStop(() => {
    stopWatching?.()
    child.stdin?.end()
  })
  return new Promise((done) => {
    child.on("exit", (code) => {
      stopWatching?.()
      done(code ?? 1)
    })
    child.on("error", (error) => {
      logger.error({ err: error }, "canopy-gateway could not start")
      done(1)
    })
  })
}
