import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { fileURLToPath } from "node:url"
import { createPolicySet } from "@canopy/policy"
import { builtin, type Canopy, createCanopy, defineConfig } from "@canopy/server"
import { build } from "esbuild"
import { notes } from "./policies.ts"

/** Settings of the notes server. */
export interface NotesServerOptions {
  readonly mongoUri: string
  /** The app database. Canopy keeps its own state in `<database>_meta` and `<database>_auth`. */
  readonly database: string
  /** The address users open, for example `http://localhost:3000`. */
  readonly publicUrl: string
  /** The publishable key the page sends. */
  readonly publishableKey: string
  /**
   * Encrypts the auth signing keys at rest. Without it, a key is generated once and kept in
   * `.canopy/master-key` next to the example, which is fine for development only.
   */
  readonly masterKey?: string
  /** Minifies the bundle and drops source maps. */
  readonly production?: boolean
  /** Package export conditions for bundling the page. Defaults to the ones Node was started with. */
  readonly conditions?: readonly string[]
}

/** A running notes server. */
export interface NotesServer {
  readonly server: Server
  readonly canopy: Canopy
  close(): Promise<void>
}

const WEB = new URL("../web/", import.meta.url)
const LOCAL = new URL("../.canopy/", import.meta.url)

async function developmentMasterKey(): Promise<string> {
  const file = new URL("master-key", LOCAL)
  try {
    return (await readFile(file, "utf8")).trim()
  } catch {
    const key = randomBytes(32).toString("base64url")
    await mkdir(LOCAL, { recursive: true })
    await writeFile(file, `${key}\n`)
    return key
  }
}

async function bundle(production: boolean, conditions: readonly string[]): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("main.ts", WEB))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    minify: production,
    sourcemap: production ? false : "inline",
    conditions: [...conditions],
    logLevel: "silent",
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error("esbuild produced no output")
  return output.text
}

/**
 * The whole example in one Node server: Canopy with built in email and password auth, the Data API and
 * realtime, from `createCanopy`, plus the page and its bundled script.
 */
export async function createNotesServer(options: NotesServerOptions): Promise<NotesServer> {
  if (options.masterKey === undefined && options.production === true)
    throw new Error("Set CANOPY_MASTER_KEY in production")
  const masterKey = options.masterKey ?? (await developmentMasterKey())
  const canopy = await createCanopy(
    defineConfig({
      mongodb: {
        uri: options.mongoUri,
        database: options.database,
        metaDatabase: `${options.database}_meta`,
        authDatabase: `${options.database}_auth`,
      },
      publicUrl: options.publicUrl,
      masterKey,
      auth: builtin({
        emailPassword: { minPasswordLength: 10, requireEmailVerification: false },
        trustedProxies: ["127.0.0.1", "::1"],
      }),
      keys: { publishable: [options.publishableKey] },
      realtime: { checkpoints: "off" },
    }),
    { env: {}, policies: createPolicySet([notes]), admin: false, studio: false },
  )
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
  const assets: Record<string, readonly [string, string]> = {
    "/": ["text/html; charset=utf-8", page],
    "/app.js": ["text/javascript; charset=utf-8", script],
    "/styles.css": ["text/css; charset=utf-8", styles],
  }
  const api = canopy.node()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    const asset = assets[path]
    if (asset === undefined || request.method !== "GET") {
      api(request, response)
      return
    }
    response.statusCode = 200
    response.setHeader("content-type", asset[0])
    response.setHeader("cache-control", "no-store")
    response.end(asset[1])
  })
  await canopy.attach(server)
  return {
    server,
    canopy,
    async close() {
      await canopy.close({ drainMs: 0 })
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
