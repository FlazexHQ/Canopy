import { createHash, timingSafeEqual } from "node:crypto"
import { createServer, type Server } from "node:http"

/** Options of {@link serveMetrics}. */
export interface MetricsServerOptions {
  readonly port: number
  /** The address to bind. Use a loopback address unless a scraper on another host needs it. */
  readonly host: string
  /**
   * A bearer token scrapers must send as `Authorization: Bearer <token>`. Without one, the endpoint answers
   * anyone who can reach the port.
   */
  readonly token?: string | undefined
  /** The Prometheus text exposition of the metrics. */
  readonly render: () => string
}

/**
 * Serves `GET /metrics` in the Prometheus text format on its own port. Other paths answer `404`; a missing
 * or wrong bearer token answers `401` with `WWW-Authenticate: Bearer`.
 */
export async function serveMetrics(options: MetricsServerOptions): Promise<Server> {
  const expected = options.token === undefined ? undefined : digest(options.token)
  const server = createServer((request, response) => {
    if (pathOf(request.url) !== "/metrics") {
      response.statusCode = 404
      response.end()
      return
    }
    if (expected !== undefined && !authorized(request.headers.authorization, expected)) {
      response.statusCode = 401
      response.setHeader("www-authenticate", 'Bearer realm="metrics"')
      response.end()
      return
    }
    response.setHeader("content-type", "text/plain; version=0.0.4")
    response.end(options.render())
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return server
}

function pathOf(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? "/", "http://localhost").pathname
  } catch {
    return undefined
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")
  if (match?.[1] === undefined) return false
  return timingSafeEqual(digest(match[1]), expected)
}

/** Whether `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare)
}
