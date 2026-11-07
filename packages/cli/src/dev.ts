import { randomBytes } from "node:crypto"
import { watch } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { basename, dirname, relative } from "node:path"
import { ConfigError, type ResolvedConfig, redactUri } from "@canopy/config"
import { loadConfig } from "@canopy/config/load"
import { lintPolicies } from "@canopy/policy"
import type { Logger } from "@canopy/realtime"
import { type Canopy, createCanopy } from "@canopy/server"
import { messageOf, type Output } from "./output.ts"

/** Options of `canopy dev`. */
export interface DevOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** An explicit config file. */
  readonly configFile?: string
  /** Overrides the configured port; `0` picks a free one. */
  readonly port?: number
  /** Called with the base URL each time the server (re)starts. */
  readonly onReady?: (url: string) => void
}

/** Development keys for a session without configured keys. */
export function devKeys(): { publishable: string; secret: string } {
  return {
    publishable: `canopy_pk_dev_${randomBytes(12).toString("hex")}`,
    secret: `canopy_sk_dev_${randomBytes(18).toString("hex")}`,
  }
}

function devLogger(out: Output): Logger {
  const line = (object: Record<string, unknown>, message?: string): string => {
    const err = object["err"]
    return `${message ?? ""}${err === undefined ? "" : `: ${messageOf(err)}`}`
  }
  return {
    debug: () => {},
    info: () => {},
    warn: (object, message) => out.log(`warn  ${line(object, message)}`),
    error: (object, message) => out.error(`error  ${line(object, message)}`),
  }
}

interface Running {
  readonly canopy: Canopy
  readonly server: Server
  readonly url: string
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(port, () => {
      server.off("error", fail)
      done()
    })
  })
  return (server.address() as AddressInfo).port
}

function summary(
  config: ResolvedConfig,
  canopy: Canopy,
  url: string,
  cwd: string,
  generated: boolean,
): string[] {
  const ws = url.replace(/^http/, "ws")
  const set = canopy.policies.set
  const findings = lintPolicies([...set.collections.values()], set.contexts)
  const errors = findings.filter((finding) => finding.severity === "error").length
  const policies = [...set.collections.values()].reduce((n, def) => n + def.policies.length, 0)
  const source =
    "dir" in config.policies ? relative(cwd, config.policies.dir) || "." : "the meta database"
  const lines = [
    `Canopy dev  (config ${config.file === undefined ? "none, CANOPY_* variables" : relative(cwd, config.file)})`,
    "",
    `  REST      ${canopy.rest === undefined ? "off" : `${url}/rest/v1`}`,
    `  Realtime  ${canopy.realtime === undefined ? "off" : `${ws}/realtime/v1`}`,
    `  MongoDB   ${redactUri(config.mongodb.uri)}  (app database ${config.mongodb.database})`,
  ]
  const publishable = config.keys.publishable[0]
  const secret = config.keys.secret[0]
  if (generated && publishable !== undefined && secret !== undefined) {
    lines.push(`  Keys      publishable ${publishable}`)
    lines.push(`            secret      ${secret}  (generated for this session; never ship it)`)
  } else {
    lines.push(
      `  Keys      ${publishable === undefined ? "no publishable key" : `publishable ${publishable}`}, ${config.keys.secret.length} secret`,
    )
  }
  lines.push(
    `  Auth      ${config.auth === undefined ? "API keys only (no identity provider configured)" : config.auth.issuer}`,
  )
  lines.push(
    `  Policies  ${set.collections.size} collections, ${policies} policies from ${source}, ${errors} lint errors`,
  )
  lines.push("")
  lines.push(
    "Watching the config and env files (restart) and the policies (hot reload). Ctrl+C stops.",
  )
  return lines
}

/**
 * `canopy dev`: runs Canopy locally from the project config with `.env` files loaded. The policy directory
 * hot reloads (an invalid set keeps the previous one and prints why); edits to the config file or the env
 * files next to it restart the server, and an invalid edit keeps the running one. Without configured keys a
 * publishable and a secret key are generated for the session. Runs until `signal` aborts.
 */
export async function dev(options: DevOptions, out: Output, signal: AbortSignal): Promise<number> {
  let session: { publishable: string; secret: string } | undefined
  let generated = false
  const load = async (env: Readonly<Record<string, string | undefined>>): Promise<ResolvedConfig> =>
    (
      await loadConfig({
        command: "dev",
        cwd: options.cwd,
        env,
        envFiles: true,
        fresh: true,
        ...(options.configFile === undefined ? {} : { file: options.configFile }),
      })
    ).config
  const tryLoad = async (): Promise<ResolvedConfig | undefined> => {
    try {
      const config = await load(options.env)
      generated =
        config.environment === "development" &&
        config.keys.publishable.length === 0 &&
        config.keys.secret.length === 0
      if (!generated) return config
      session ??= devKeys()
      return await load({
        ...options.env,
        CANOPY_PUBLISHABLE_KEYS: session.publishable,
        CANOPY_SECRET_KEYS: session.secret,
      })
    } catch (error: unknown) {
      out.error(error instanceof ConfigError ? error.message : `error  ${messageOf(error)}`)
      return undefined
    }
  }

  const logger = devLogger(out)
  const start = async (config: ResolvedConfig): Promise<Running | undefined> => {
    let canopy: Canopy | undefined
    try {
      canopy = await createCanopy(config, { logger })
      const server = createServer(canopy.node())
      await canopy.attach(server)
      const port = await listen(server, options.port ?? config.server.port)
      const url = `http://localhost:${port}`
      for (const line of summary(config, canopy, url, options.cwd, generated)) out.log(line)
      options.onReady?.(url)
      return { canopy, server, url }
    } catch (error: unknown) {
      out.error(`error  Canopy did not start: ${messageOf(error)}`)
      await canopy?.close({ drainMs: 0 })
      return undefined
    }
  }
  const stop = async (running: Running | undefined): Promise<void> => {
    if (running === undefined) return
    await running.canopy.close({ drainMs: 0 })
    running.server.closeAllConnections()
    await new Promise<void>((done) => running.server.close(() => done()))
  }

  const first = await tryLoad()
  if (first === undefined) return 1
  let running = await start(first)
  if (running === undefined) return 1

  const configFile = first.file
  const watched = configFile === undefined ? options.cwd : dirname(configFile)
  const isWatched = (name: string): boolean =>
    (configFile !== undefined && name === basename(configFile)) || /^\.env(\..+)?$/.test(name)
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<void> = Promise.resolve()
  const restart = (): void => {
    queue = queue.then(async () => {
      if (signal.aborted) return
      out.log("Config changed, restarting")
      const config = await tryLoad()
      if (config === undefined) {
        out.error("Keeping the running server until the config is fixed.")
        return
      }
      await stop(running)
      running = await start(config)
    })
  }
  const watcher = watch(watched, (_event, name) => {
    if (name === null || !isWatched(String(name))) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(restart, 150)
  })

  await new Promise<void>((done) => {
    if (signal.aborted) done()
    else signal.addEventListener("abort", () => done(), { once: true })
  })
  watcher.close()
  if (timer !== undefined) clearTimeout(timer)
  await queue
  await stop(running)
  return 0
}
