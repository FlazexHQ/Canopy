import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { createPolicySet, PolicyEngine } from "@canopy/policy"
import {
  Authenticator,
  attach,
  createHttpTransport,
  createRealtime,
  toNodeHandler,
} from "@canopy/realtime"
import { createRestHandler, toNodeListener } from "@canopy/rest"
import { build } from "esbuild"
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { todos } from "./policies.ts"

/** Settings of the todo server. */
export interface TodoServerOptions {
  readonly mongoUri: string
  /** The app database. */
  readonly database: string
  /** Canopy's own database (idempotency records). */
  readonly metaDatabase: string
  /** The publishable key the app sends. */
  readonly publishableKey: string
  /** Minifies the bundle and drops source maps. */
  readonly production?: boolean
  /**
   * Leaves WebSocket upgrades unanswered, as a proxy that blocks them would, so clients fall back to SSE.
   * For trying the fallback transports.
   */
  readonly disableWebSockets?: boolean
  /** Package export conditions for bundling the app. Defaults to the ones Node was started with. */
  readonly conditions?: readonly string[]
  /**
   * The development issuer's Ed25519 private key as a JWK (JSON), so several servers accept the same
   * tokens. Without it each server generates its own.
   */
  readonly devIssuerKey?: string
}

/** A running todo server. */
export interface TodoServer {
  readonly server: Server
  close(): Promise<void>
}

/** The demo users the development issuer signs tokens for. */
export const USERS = ["alice", "bob"] as const

const ISSUER = "https://todo-react.example/dev-issuer"
const AUDIENCE = "https://todo-react.example/api"
const WEB = new URL("../web/", import.meta.url)

async function bundle(production: boolean, conditions: readonly string[]): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("main.tsx", WEB))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    jsx: "automatic",
    minify: production,
    sourcemap: production ? false : "inline",
    conditions: [...conditions],
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    logLevel: "silent",
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error("esbuild produced no output")
  return output.text
}

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]

async function issuerKeys(
  privateJwk: string | undefined,
): Promise<{ privateKey: SigningKey; publicJwk: JWK }> {
  if (privateJwk === undefined) {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) }
  }
  const { kty, crv, x } = JSON.parse(privateJwk) as JWK
  const privateKey = await importJWK(JSON.parse(privateJwk) as JWK, "EdDSA")
  if (privateKey instanceof Uint8Array || kty === undefined || crv === undefined || x === undefined)
    throw new TypeError("The development issuer key must be an Ed25519 private JWK")
  return { privateKey, publicJwk: { kty, crv, x } }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.statusCode = status
  response.setHeader("content-type", type)
  response.setHeader("cache-control", "no-store")
  response.end(body)
}

async function json(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

/**
 * The whole backend of the example in one Node server: the REST API, realtime over WebSocket with the
 * SSE and long-poll fallbacks, a development token issuer, and the bundled React app. Realtime commits
 * mutations through the REST write path, so both entry points share one idempotency store.
 */
export async function createTodoServer(options: TodoServerOptions): Promise<TodoServer> {
  const mongo = new MongoClient(options.mongoUri, { appName: "todo-react" })
  await mongo.connect()
  const { privateKey, publicJwk } = await issuerKeys(options.devIssuerKey)
  const jwk = { ...publicJwk, kid: "dev", alg: "EdDSA", use: "sig" }
  const jwt = { jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE }
  const keys = { publishable: [options.publishableKey] }
  const set = createPolicySet([todos])
  const rest = createRestHandler({
    client: mongo,
    database: options.database,
    metaDatabase: options.metaDatabase,
    policies: new PolicyEngine(set),
    authenticator: new Authenticator(jwt, keys),
  })
  const realtime = await createRealtime({
    mongo,
    database: options.database,
    metaDatabase: options.metaDatabase,
    auth: jwt,
    keys,
    policies: { set },
    checkpoints: "off",
    mutations: rest.writes,
  })
  const http = createHttpTransport(realtime)
  const fallback = toNodeHandler(http)
  const api = toNodeListener(rest)
  const script = await bundle(
    options.production === true,
    options.conditions ??
      (process.execArgv.some((arg) => arg.includes("@canopy/source")) ? ["@canopy/source"] : []),
  )
  const page = (await readFile(new URL("index.html", WEB), "utf8")).replace(
    "%PUBLISHABLE_KEY%",
    options.publishableKey,
  )
  const styles = await readFile(new URL("styles.css", WEB), "utf8")

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    if (path.startsWith("/rest/v1")) return api(request, response)
    if (path === "/dev/token" && request.method === "POST") {
      void json(request).then(async (body) => {
        const user = (body as { user?: unknown } | undefined)?.user
        if (typeof user !== "string" || !(USERS as readonly string[]).includes(user))
          return send(response, 400, "application/json", '{"error":"unknown user"}')
        const token = await new SignJWT({ name: user })
          .setProtectedHeader({ alg: "EdDSA", kid: "dev" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject(user)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey)
        send(response, 200, "application/json", JSON.stringify({ token }))
      })
      return
    }
    if (path === "/app.js") return send(response, 200, "text/javascript", script)
    if (path === "/styles.css") return send(response, 200, "text/css", styles)
    if (path === "/") return send(response, 200, "text/html; charset=utf-8", page)
    fallback(request, response, () => send(response, 404, "text/plain", "Not found"))
  })
  const attachment =
    options.disableWebSockets === true ? { close: async () => {} } : await attach(realtime, server)
  return {
    server,
    close: async () => {
      http.close()
      await realtime.close()
      await attachment.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await mongo.close()
    },
  }
}
