import { type ChildProcess, spawn } from "node:child_process"
import type { JsonWebKey } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ResolvedConfig } from "@canopy/config"
import { hostTarget, type NativeTarget } from "@canopy/native"
import { type PolicySet, toStored } from "@canopy/policy"
import { toCanonical } from "@canopy/protocol"
import { gatewayExecutable, gatewayPackage, packagedGateway } from "./gateway-package.ts"
import type { Logger } from "./logger.ts"
import { directoryPolicies } from "./policy-source.ts"

const BINARY = gatewayExecutable(process.platform)

/**
 * Finds the `canopyd` executable. `CANOPYD_BIN` (or the legacy `CANOPY_GATEWAY_BIN`) wins; otherwise the
 * prebuilt platform package for `target` (this process's platform, musl or glibc on Linux) as installed with
 * this package, then a release or debug Cargo build in a folder above `from`, a binary beside the running
 * executable, and a binary on `PATH`. Returns `undefined` when there is none.
 */
export function findGatewayBinary(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  from: string = dirname(fileURLToPath(import.meta.url)),
  target: NativeTarget | undefined = hostTarget(),
): string | undefined {
  const configured = env["CANOPYD_BIN"] || env["CANOPY_GATEWAY_BIN"]
  if (configured) return resolve(configured)
  const packaged = packagedGateway(target, from)
  if (packaged !== undefined) return packaged
  let dir = from
  for (let depth = 0; depth < 6; depth += 1) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(dir, "target", profile, BINARY)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const beside = join(dirname(execPath), BINARY)
  if (existsSync(beside)) return beside
  const path = env["PATH"] ?? env["Path"] ?? ""
  for (const entry of path.split(delimiter)) {
    if (entry === "") continue
    const candidate = join(entry, BINARY)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Tells the user how to get `canopyd` when `findGatewayBinary` finds none for `target`, the platform of this
 * process or `undefined` when it has no prebuilt `canopyd`.
 */
export function missingGatewayMessage(target: NativeTarget | undefined): string {
  const build =
    "set CANOPYD_BIN to a canopyd executable or build one with cargo build --release -p canopyd"
  if (target === undefined)
    return `No canopyd executable found, and none is prebuilt for ${process.platform} ${process.arch}: ${build}`
  const platform = `${target.os} ${target.cpu}${target.libc === undefined ? "" : ` (${target.libc})`}`
  return `No canopyd executable found. Install ${gatewayPackage(target)}, the prebuilt canopyd for ${platform} that @canopy/realtime lists as an optional dependency (reinstall without skipping optional dependencies), or ${build}`
}

/** The informational notice when development falls back to the TypeScript server. */
export function gatewayFallbackMessage(): string {
  const target = hostTarget()
  const install =
    target === undefined
      ? "Set CANOPYD_BIN to a canopyd executable"
      : `Install ${gatewayPackage(target)} to use canopyd`
  return `No canopyd executable found. Using the TypeScript server. ${install}.`
}

/** The policies in the stored form the gateway reads: one document per collection plus the context lookups. */
export function storedPolicies(set: PolicySet): { stored: unknown[]; contexts: unknown } {
  return {
    stored: [...set.collections.values()].map((def) => toCanonical(toStored(def, { version: 1 }))),
    contexts: toCanonical(set.contexts),
  }
}

/** JWT verification the gateway uses instead of the config's, for tokens a server issues itself. */
export interface GatewayAuth {
  /** The expected `iss`. */
  readonly issuer: string
  /** The expected `aud`. */
  readonly audience: string
  /** Where the verification keys are, normally the server's own JWKS on loopback. */
  readonly jwksUrl: string
  /** The accepted signature algorithms. */
  readonly algorithms: readonly string[]
  /** The claim holding the caller's roles. */
  readonly rolesClaim: string
}

/** What a server that runs the gateway in front of itself changes in the gateway's configuration. */
export interface GatewayOverrides {
  /** The address the HTTP listener binds. */
  readonly host?: string
  /** The port the gateway listens on. Defaults to `server.port`. */
  readonly port?: number
  /** The gateway's metrics port, `0` for none. Defaults to `server.metricsPort`. */
  readonly metricsPort?: number
  /** The address the metrics port binds. Defaults to `server.metricsHost`. */
  readonly metricsHost?: string
  /** `http://host:port` of the server that answers every path the gateway does not serve. */
  readonly proxyUrl?: string
  /** The REST base URL `mut` frames are forwarded to. Defaults to `CANOPY_GATEWAY_MUTATIONS_URL`. */
  readonly mutationsUrl?: string
  /** JWT verification for built in auth. */
  readonly auth?: GatewayAuth
  /** The public key of Studio's view tokens as a JWK, so the gateway accepts them. */
  readonly viewTokenKey?: JsonWebKey
  /**
   * The HTTP routes the gateway serves itself. An empty list selects no routes. When omitted,
   * `CANOPY_DATA_PLANE_ROUTES` takes a comma separated list or an empty string. When both are omitted,
   * the gateway serves all configured data routes.
   */
  readonly dataPlaneRoutes?: readonly string[]
  /** Settings for a dedicated MongoDB wire listener. The listener is off by default. */
  readonly wire?:
    | false
    | {
        readonly port: number
        readonly host?: string
        readonly maxMessageBytes?: number
        readonly maxConnections?: number
        readonly idleTimeoutMs?: number
        readonly tls?: { readonly certFile: string; readonly keyFile: string }
      }
  /** Resolved GraphQL operations, when supplied by the caller. */
  readonly graphqlPersisted?: {
    readonly operations: Readonly<Record<string, string>>
    readonly only: boolean
  }
}

/** Reads a persisted operations file: a JSON object mapping the hex SHA-256 of each document to it. */
export async function readPersistedGraphqlOperations(input: {
  readonly file: string
  readonly only: boolean
}): Promise<NonNullable<GatewayOverrides["graphqlPersisted"]>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(input.file, "utf8"))
  } catch (error: unknown) {
    throw new TypeError(`The persisted operations file ${input.file} cannot be read as JSON`, {
      cause: error,
    })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError(`The persisted operations file ${input.file} must hold an object`)
  const operations: Record<string, string> = {}
  for (const [hash, document] of Object.entries(parsed)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof document !== "string")
      throw new TypeError(
        `The persisted operations file ${input.file} must map SHA-256 hex hashes to documents`,
      )
    operations[hash] = document
  }
  return { operations, only: input.only }
}

/**
 * The gateway's configuration from the resolved config of `canopy-realtime`. Policies from a directory are
 * passed in stored form, because the gateway cannot evaluate TypeScript; policies in the database are read and
 * watched by the gateway itself. The gateway resolves the route selection from the environment or its
 * default when the document omits it.
 */
export function gatewayConfig(
  config: ResolvedConfig,
  policies: { stored: unknown[]; contexts: unknown } | undefined,
  env: NodeJS.ProcessEnv = process.env,
  overrides: GatewayOverrides = {},
): Record<string, unknown> {
  const realtime = config.realtime === false ? undefined : config.realtime
  const auth = config.auth
  if (auth?.kind === "builtin" && overrides.auth === undefined)
    throw new TypeError(
      "built in auth runs in the canopy server; point the gateway at its JWKS with external() instead",
    )
  const limits = config.rateLimits
  const storage = config.storage
  const graphql = config.graphql
  const { graphqlPersisted } = overrides
  const mutationsUrl = overrides.mutationsUrl ?? env["CANOPY_GATEWAY_MUTATIONS_URL"]
  return {
    mongodb: {
      uri: config.mongodb.uri,
      database: config.mongodb.database,
      metaDatabase: config.mongodb.metaDatabase,
    },
    server: {
      ...(overrides.host === undefined ? {} : { host: overrides.host }),
      port: overrides.port ?? config.server.port,
      metricsPort: overrides.metricsPort ?? config.server.metricsPort,
      metricsHost: overrides.metricsHost ?? config.server.metricsHost,
      ...(config.server.metricsToken === undefined
        ? {}
        : { metricsToken: config.server.metricsToken }),
      nodeId: config.server.nodeId,
      trustedProxies: [
        ...config.server.trustedProxies,
        ...(auth?.kind === "builtin" ? auth.trustedProxies : []),
      ],
    },
    auth:
      overrides.auth !== undefined
        ? {
            issuer: overrides.auth.issuer,
            audience: overrides.auth.audience,
            jwksUrl: overrides.auth.jwksUrl,
            algorithms: overrides.auth.algorithms,
            rolesClaim: overrides.auth.rolesClaim,
            ...(auth?.kind === "builtin" ? { checkRevocations: true } : {}),
          }
        : auth === undefined || auth.kind === "builtin"
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
            requests: { perSecond: limits.requests.perSecond, burst: limits.requests.burst },
            failedAuthentications: {
              perSecond: limits.failedAuthentications.perSecond,
              burst: limits.failedAuthentications.burst,
            },
            anonymousConnectionsPerAddress: limits.anonymousConnectionsPerAddress,
            exemptService: limits.exemptService,
          },
    ...(mutationsUrl === undefined ? {} : { mutations: { url: mutationsUrl } }),
    ...(overrides.proxyUrl === undefined ? {} : { proxy: { url: overrides.proxyUrl } }),
    ...(overrides.viewTokenKey === undefined
      ? {}
      : { viewTokens: { jwk: overrides.viewTokenKey } }),
    rest:
      config.rest === false
        ? false
        : {
            defaultLimit: config.rest.defaultLimit,
            maxLimit: config.rest.maxLimit,
            maxBodyBytes: config.rest.maxBodyBytes,
            search: Object.entries(config.collections)
              .filter(([, collection]) => collection.search === true)
              .map(([name]) => name),
            idTypes: Object.fromEntries(
              Object.entries(config.collections)
                .filter(([, collection]) => collection.idType !== "auto")
                .map(([name, collection]) => [name, collection.idType]),
            ),
            mutationTtlSeconds: Math.round(config.rest.mutationTtlMs / 1000),
            explainDenials: config.environment === "development",
          },
    graphql:
      graphql === false
        ? false
        : {
            path: "/graphql/v1",
            maxDepth: graphql.maxDepth,
            maxComplexity: graphql.maxComplexity,
            maxAliases: graphql.maxAliases,
            maxBatch: graphql.maxBatch,
            introspection: graphql.introspection,
            ...(graphqlPersisted === undefined ? {} : { persisted: graphqlPersisted }),
            collections: Object.fromEntries(
              Object.entries(config.collections)
                .filter(
                  ([, collection]) =>
                    collection.typeName !== undefined || collection.relations !== undefined,
                )
                .map(([name, { typeName, relations }]) => [name, { typeName, relations }]),
            ),
          },
    storage:
      storage === false
        ? false
        : {
            path: "/storage/v1",
            buckets: storage.buckets,
            images: storage.images,
            backend: storage.backend,
            signingMasterKey: config.masterKey,
            partSize: 8 * 1024 * 1024,
            maxUploadSize: storage.maxUploadSize,
            uploadTtlMs: 86_400_000,
            maxSignedUrlSeconds: 7 * 86_400,
          },
    ...(overrides.wire === undefined ? {} : { wire: overrides.wire }),
    ...(overrides.dataPlaneRoutes === undefined
      ? {}
      : { dataPlane: { routes: overrides.dataPlaneRoutes } }),
    log: { level: config.log.level },
    telemetry: { tracing: config.telemetry.tracing },
    audit: { dataWrites: config.audit.dataWrites },
  }
}

function listeningPorts(line: string): { port: number; wirePort?: number } | undefined {
  if (!line.startsWith('{"t":"listening"')) return undefined
  try {
    const parsed = JSON.parse(line) as { t?: unknown; port?: unknown; wirePort?: unknown }
    if (parsed.t !== "listening" || typeof parsed.port !== "number") return undefined
    return {
      port: parsed.port,
      ...(typeof parsed.wirePort === "number" ? { wirePort: parsed.wirePort } : {}),
    }
  } catch {
    return undefined
  }
}

/** A gateway running as a child process. */
export interface RunningGateway {
  /** The gateway process ID, or undefined if the process could not be spawned. */
  readonly pid: number | undefined
  /** Resolves with the gateway's exit code. */
  readonly exited: Promise<number>
  /** Resolves with the port the gateway listens on, or with `undefined` when it exits first. */
  readonly listening: Promise<number | undefined>
  /** Resolves with the MongoDB wire port when enabled, or with `undefined` if absent or the gateway exits first. */
  readonly wireListening: Promise<number | undefined>
  /** Drains the gateway and stops it, by closing its standard input. */
  stop(): void
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
  const gateway = await startGateway(
    config,
    logger,
    process.env["CANOPY_DATA_PLANE_ROUTES"] === undefined ? { dataPlaneRoutes: [] } : {},
  )
  onStop(() => gateway.stop())
  const port = await gateway.listening
  if (port !== undefined) logger.info({ port }, "canopy-realtime listening")
  return gateway.exited
}

/**
 * Starts the native gateway for a resolved config: policies from a directory are sent in stored form and again
 * whenever they change, policies in the database are read by the gateway itself.
 */
export async function startGateway(
  config: ResolvedConfig,
  logger: Logger,
  overrides: GatewayOverrides = {},
): Promise<RunningGateway> {
  const binary = findGatewayBinary()
  if (binary === undefined) throw new TypeError(missingGatewayMessage(hostTarget()))
  const source = "dir" in config.policies ? directoryPolicies(config.policies.dir) : undefined
  const initial = source === undefined ? undefined : storedPolicies(await source.load())
  const persisted = config.graphql === false ? undefined : config.graphql.persisted
  const graphqlPersisted =
    overrides.graphqlPersisted ??
    (persisted === undefined ? undefined : await readPersistedGraphqlOperations(persisted))
  const document = gatewayConfig(config, initial, process.env, {
    ...overrides,
    ...(graphqlPersisted === undefined ? {} : { graphqlPersisted }),
  })
  const child: ChildProcess = spawn(binary, ["--config", "-"], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  })
  child.stdin?.write(`${JSON.stringify(document)}\n`)
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
  type Ports = ReturnType<typeof listeningPorts>
  let reported: (ports: Ports) => void = () => {}
  const listening = new Promise<Ports>((resolve) => {
    reported = resolve
  })
  let pending = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString()
    let end = pending.indexOf("\n")
    while (end >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, "")
      pending = pending.slice(end + 1)
      end = pending.indexOf("\n")
      const ports = listeningPorts(line)
      if (ports === undefined) process.stdout.write(`${line}\n`)
      else reported(ports)
    }
  })
  const exited = new Promise<number>((done) => {
    child.on("exit", (code) => {
      stopWatching?.()
      reported(undefined)
      done(code ?? 1)
    })
    child.on("error", (error) => {
      logger.error({ err: error }, "canopyd could not start")
      reported(undefined)
      done(1)
    })
  })
  return {
    pid: child.pid,
    exited,
    listening: listening.then((ports) => ports?.port),
    wireListening: listening.then((ports) => ports?.wirePort),
    stop() {
      stopWatching?.()
      child.stdin?.end()
    },
  }
}
