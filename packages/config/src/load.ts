import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type Resolution, resolveConfig } from "./resolve.ts"
import type { Command, ConfigContext, Environment } from "./types.ts"

/** Options of {@link loadConfig}. */
export interface LoadOptions {
  readonly command: Command
  /** Where discovery starts and relative variable paths resolve. Defaults to the process directory. */
  readonly cwd?: string
  /** An explicit config file (`--config`). */
  readonly file?: string
  /** The process environment. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Load `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local` next to the config file (later files
   * win, real variables always win). `canopy dev` turns this on; servers do not.
   */
  readonly envFiles?: boolean
  /** Import the config file again even if it was loaded before, so edits are seen (`canopy dev`). */
  readonly fresh?: boolean
}

/** A loaded config: the resolution plus the file it came from. */
export interface LoadedConfig extends Resolution {
  readonly file: string | undefined
}

const NAMES = ["canopy.config.ts", "canopy.config.mts", "canopy.config.js", "canopy.config.mjs"]

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Finds the config file: `canopy.config.{ts,mts,js,mjs}` or `canopy/canopy.config.*`, walking up from `cwd`
 * to the filesystem root. Returns `undefined` when there is none (zero config mode).
 */
export async function findConfig(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd)
  for (;;) {
    for (const base of [dir, join(dir, "canopy")]) {
      for (const name of NAMES) {
        const candidate = join(base, name)
        if (await isFile(candidate)) return candidate
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Parses an env file: `KEY=value` lines, optional `export`, quotes and `#` comments. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2] ?? ""
    const quote = value[0]
    let close = -1
    if (quote === '"' || quote === "'") {
      for (let index = 1; index < value.length; index += 1) {
        if (quote === '"' && value[index] === "\\") index += 1
        else if (value[index] === quote) {
          close = index
          break
        }
      }
    }
    if (close > 0) {
      value = value.slice(1, close)
      if (quote === '"') value = value.replaceAll("\\n", "\n").replaceAll('\\"', '"')
    } else {
      const comment = value.search(/\s#/)
      if (comment >= 0) value = value.slice(0, comment)
      value = value.trim()
    }
    out.set(match[1] ?? "", value)
  }
  return out
}

async function readEnvFiles(
  dir: string,
  mode: Environment,
): Promise<{ values: Map<string, string>; origins: Map<string, string> }> {
  const values = new Map<string, string>()
  const origins = new Map<string, string>()
  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    const path = join(dir, name)
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    for (const [key, value] of parseEnvFile(text)) {
      values.set(key, value)
      origins.set(key, path)
    }
  }
  return { values, origins }
}

function modeOf(value: string | undefined): Environment {
  return value === "production" ? "production" : "development"
}

/**
 * Loads, validates and resolves the Canopy config for a command. Without a config file, the well known
 * `CANOPY_*` variables configure everything (zero config mode). Throws a `ConfigError` listing every
 * problem that matters for the command.
 */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const processEnv = options.env ?? process.env
  const file = options.file === undefined ? await findConfig(cwd) : resolve(cwd, options.file)
  const baseDir = file === undefined ? cwd : dirname(file)
  let env: Record<string, string | undefined> = { ...processEnv }
  let envOrigins = new Map<string, string>()
  if (options.envFiles === true) {
    const fromFiles = await readEnvFiles(baseDir, modeOf(processEnv["CANOPY_ENV"]))
    const merged: Record<string, string | undefined> = Object.fromEntries(fromFiles.values)
    for (const [key, value] of Object.entries(processEnv)) {
      if (value !== undefined) {
        merged[key] = value
        fromFiles.origins.delete(key)
      }
    }
    env = merged
    envOrigins = fromFiles.origins
  }
  let input: unknown = {}
  if (file !== undefined) {
    const url = pathToFileURL(file).href
    const module: unknown = await import(options.fresh === true ? `${url}?v=${Date.now()}` : url)
    const exported =
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined
    if (exported === undefined)
      throw new TypeError(
        `${file} must export its config as default: export default defineConfig({ ... })`,
      )
    const context: ConfigContext = { mode: modeOf(env["CANOPY_ENV"]), command: options.command }
    input =
      typeof exported === "function"
        ? await (exported as (c: ConfigContext) => unknown)(context)
        : exported
  }
  const resolution = resolveConfig(input, {
    env,
    envFiles: envOrigins,
    ...(file === undefined ? {} : { file }),
    baseDir,
    cwd,
    command: options.command,
  })
  return { ...resolution, file }
}
