import { addAbortListener } from "node:events"
import { type AddressInfo, createServer as createNetServer } from "node:net"
import { amendConfig, type ResolvedConfig } from "@canopy/config"
import {
  type GatewayOverrides,
  type Logger,
  type RunningGateway,
  startGateway,
} from "@canopy/realtime"
import { type Canopy, type CreateCanopyOptions, createCanopy } from "./canopy.ts"
import { type Listening, listenCanopy } from "./listen.ts"

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

/** The gateway's settings when it is the front door of a server listening on loopback at `port`. */
function frontDoor(canopy: Canopy, port: number, metricsPort: number): GatewayOverrides {
  const local = `http://127.0.0.1:${port}`
  const verification = canopy.auth?.verification
  const audience = verification?.audience
  return {
    metricsPort,
    metricsHost: "127.0.0.1",
    proxyUrl: local,
    viewTokenKey: canopy.viewTokenKey,
    ...(canopy.config.rest === false ? {} : { mutationsUrl: `${local}/rest/v1` }),
    ...(verification === undefined
      ? {}
      : {
          auth: {
            issuer: Array.isArray(verification.issuer)
              ? String(verification.issuer[0])
              : String(verification.issuer),
            audience: Array.isArray(audience) ? String(audience[0]) : String(audience),
            jwksUrl: `${local}/auth/v1/jwks`,
            algorithms: verification.algorithms ?? ["EdDSA", "ES256"],
            rolesClaim: verification.rolesClaim ?? "roles",
          },
        }),
  }
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
 * The gateway proxies HTTP to Canopy and serves realtime for clients and GraphQL subscriptions.
 */
export async function startGatewayFrontDoor(
  config: ResolvedConfig,
  logger: Logger,
  options: Pick<CreateCanopyOptions, "onSetupToken"> = {},
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
  let gateway: RunningGateway | undefined
  try {
    signal?.throwIfAborted()
    const upstream = await listenCanopy(canopy, 0, "127.0.0.1")
    http = upstream
    const metricsPort = await freeLoopbackPort()
    signal?.throwIfAborted()
    const running = await startGateway(
      config,
      logger,
      frontDoor(canopy, upstream.port, metricsPort),
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
        stopping ??= stopFrontDoor(canopy, upstream, running)
        return stopping
      },
    }
  } catch (error: unknown) {
    await stopFrontDoor(canopy, http, gateway)
    throw error
  }
}

async function stopFrontDoor(
  canopy: Canopy,
  http: Listening | undefined,
  gateway: RunningGateway | undefined,
): Promise<void> {
  gateway?.stop()
  await gateway?.exited
  try {
    await canopy.close()
  } finally {
    await http?.stop()
  }
}
