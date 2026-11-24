import { addAbortListener } from "node:events"
import { type AddressInfo, createServer as createNetServer } from "node:net"
import { amendConfig, type ResolvedConfig } from "@canopy/config"
import { toNodeListener } from "@canopy/node-http"
import {
  type GatewayOverrides,
  type Logger,
  type RunningGateway,
  startGateway,
} from "@canopy/realtime"
import { type Canopy, type CreateCanopyOptions, createCanopy } from "./canopy.ts"
import { type Listening, listenCanopy, listenNode } from "./listen.ts"

/**
 * The config this process runs with behind the gateway: requests arrive from loopback with the client in
 * `X-Forwarded-For`, which the rate limits and the admin allowlist must believe.
 */
function behindGateway(config: ResolvedConfig): ResolvedConfig {
  return amendConfig(config, {
    server: {
      ...config.server,
      trustedProxies: [...config.server.trustedProxies, "127.0.0.1", "::1"],
    },
  })
}

function frontDoor(
  canopy: Canopy,
  proxyPort: number,
  internalPort: number,
  metricsPort: number,
): GatewayOverrides {
  const internal = `http://127.0.0.1:${internalPort}`
  const verification = canopy.auth?.verification
  const audience = verification?.audience
  return {
    metricsPort,
    metricsHost: "127.0.0.1",
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    viewTokenKey: canopy.viewTokenKey,
    ...(canopy.config.rest === false ? {} : { mutationsUrl: `${internal}/rest/v1` }),
    ...(verification === undefined
      ? {}
      : {
          auth: {
            issuer: Array.isArray(verification.issuer)
              ? String(verification.issuer[0])
              : String(verification.issuer),
            audience: Array.isArray(audience) ? String(audience[0]) : String(audience),
            jwksUrl: `${internal}/auth/v1/jwks`,
            algorithms: verification.algorithms ?? ["EdDSA", "ES256"],
            rolesClaim: verification.rolesClaim ?? "roles",
          },
        }),
  }
}

function listenGatewayInternal(canopy: Canopy): Promise<Listening> {
  const listener = toNodeListener((request, info) => {
    const path = new URL(request.url).pathname
    if (canopy.rest !== undefined && request.method === "POST" && path === "/rest/v1/_batch")
      return canopy.rest.fetch(request, info)
    if (canopy.auth !== undefined && request.method === "GET" && path === "/auth/v1/jwks")
      return canopy.auth.handler(request, info.ip === undefined ? {} : { clientAddress: info.ip })
    return new Response("Not found", { status: 404 })
  })
  return listenNode(listener, 0, "127.0.0.1")
}

/** A port that was free on loopback a moment ago. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function scrapeMetrics(port: number, token: string | undefined) {
  let metrics = ""
  const scrape = (): void => {
    fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => (response.ok ? response.text() : ""))
      .then(
        (text) => {
          metrics = text
        },
        () => {
          metrics = ""
        },
      )
  }
  scrape()
  const timer = setInterval(scrape, 1000)
  timer.unref()
  return { metrics: () => metrics, stop: () => clearInterval(timer) }
}

/** The Canopy instance and its public gateway listener. */
export interface GatewayFrontDoor {
  readonly canopy: Canopy
  /** The gateway's bound public port. */
  readonly port: number
  /** The Canopy HTTP listener's bound loopback port. */
  readonly upstreamPort: number
  /** Resolves with the gateway's exit code. */
  readonly exited: Promise<number>
  /** The gateway's latest Prometheus metrics, scraped every second. */
  metrics(): string
  /** Drains the gateway before closing Canopy and its loopback listener. */
  stop(): Promise<void>
}

/**
 * Starts Canopy on loopback and puts the native gateway on the configured public port.
 * The gateway serves realtime and the selected HTTP routes, and proxies other requests to Canopy.
 * When `serves` filters proxied paths, gateway mutation and signing key requests use a separate loopback listener.
 */
export async function startGatewayFrontDoor(
  config: ResolvedConfig,
  logger: Logger,
  options: Pick<CreateCanopyOptions, "admin" | "onSetupToken" | "serves" | "studio"> = {},
  signal?: AbortSignal,
): Promise<GatewayFrontDoor> {
  signal?.throwIfAborted()
  let gatewayUrl = ""
  const canopy = await createCanopy(behindGateway(config), {
    ...options,
    logger,
    gatewayUrl: () => gatewayUrl,
  })
  let http: Listening | undefined
  let internal: Listening | undefined
  let gateway: RunningGateway | undefined
  try {
    signal?.throwIfAborted()
    const upstream = await listenCanopy(canopy, 0, "127.0.0.1")
    http = upstream
    if (options.serves !== undefined) internal = await listenGatewayInternal(canopy)
    const metricsPort = await freeLoopbackPort()
    signal?.throwIfAborted()
    const running = await startGateway(
      config,
      logger,
      frontDoor(canopy, upstream.port, internal?.port ?? upstream.port, metricsPort),
    )
    gateway = running
    using _abort = signal === undefined ? undefined : addAbortListener(signal, () => running.stop())
    const port = await running.listening
    signal?.throwIfAborted()
    if (port === undefined)
      throw new Error(`canopy-gateway exited with code ${await running.exited} before it listened`)
    gatewayUrl = `http://127.0.0.1:${port}`
    const scrape = scrapeMetrics(metricsPort, config.server.metricsToken)
    void running.exited.then(scrape.stop)
    let stopping: Promise<void> | undefined
    return {
      canopy,
      port,
      upstreamPort: upstream.port,
      exited: running.exited,
      metrics: scrape.metrics,
      stop() {
        scrape.stop()
        stopping ??= stopFrontDoor(canopy, upstream, internal, running)
        return stopping
      },
    }
  } catch (error: unknown) {
    await stopFrontDoor(canopy, http, internal, gateway)
    throw error
  }
}

async function stopFrontDoor(
  canopy: Canopy,
  http: Listening | undefined,
  internal: Listening | undefined,
  gateway: RunningGateway | undefined,
): Promise<void> {
  gateway?.stop()
  await gateway?.exited
  try {
    await canopy.close()
  } finally {
    await Promise.all([http?.stop(), internal?.stop()])
  }
}
