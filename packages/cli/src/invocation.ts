import { resolve } from "node:path"
import { type Command, ConfigError, databaseFromUri, type ResolvedConfig } from "@canopy/config"
import { type LoadedConfig, loadConfig } from "@canopy/config/load"
import { readEnvironment, readToken } from "./credentials.ts"
import { messageOf, type Output } from "./output.ts"
import { AdminClient } from "./remote.ts"

/** The parsed `--name value` flags; a flag without a value is `true`. */
export type Flags = Map<string, string | true>
/** The environment variables a command reads. */
export type Env = Readonly<Record<string, string | undefined>>

/** One run of a command, after its name, flags and arguments were checked. */
export interface Invocation {
  readonly name: string
  readonly args: readonly string[]
  readonly flags: Flags
  readonly env: Env
  readonly out: Output
  readonly cwd: string
  readonly signal: AbortSignal
  /** The project named by `--env`, already checked to be an environment name. */
  readonly environment: string | undefined
}

/** An invocation with the resolved config and the policy directory. */
export interface Configured extends Invocation {
  readonly loaded: LoadedConfig
  readonly config: ResolvedConfig
  readonly dir: string
  /** Whether the policy directory came from `--dir` or the config rather than the default. */
  readonly dirGiven: boolean
  readonly uriFlag: string | undefined
}

/** Where a meta database command works: a MongoDB deployment, or a project's admin API (`--env`). */
interface MetaTarget {
  readonly mongodbUri: string
  readonly metaDatabase: string
  readonly remote?: AdminClient
}

/** The app database a command reads. */
export interface AppTarget {
  readonly mongodbUri: string
  readonly database: string
}

/**
 * How a command runs. `direct` commands need no config; the others load it first (as `load`, which
 * decides which settings must be present). `meta` commands then get the meta database or the admin API
 * behind `--env`, and `app` commands the app database.
 */
type Handler =
  | { readonly kind: "direct"; run(call: Invocation): number | Promise<number> }
  | {
      readonly kind: "config"
      readonly load: Command
      run(call: Configured): number | Promise<number>
    }
  | { readonly kind: "meta"; run(call: Configured, meta: MetaTarget): number | Promise<number> }
  | {
      readonly kind: "app"
      readonly load: Command
      run(call: Configured, app: AppTarget): number | Promise<number>
    }

/** A command: its flags, the number of its arguments and how it runs. */
export interface CommandSpec {
  readonly flags: readonly string[]
  /** The fewest and most positional arguments after the command name. */
  readonly args?: readonly [number, number]
  /** What the arguments are, for the error when their number is wrong. */
  readonly needs?: string
  readonly handler: Handler
}

/** Any number of positional arguments. */
export const ANY = [0, Number.POSITIVE_INFINITY] as const

/** The value of a flag given with a value. */
export function text(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

/** Reads a port flag, reporting a bad value; `false` means the command must stop. */
export function port(
  value: string | undefined,
  flag: string,
  out: Output,
): number | undefined | false {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    out.error(`--${flag} needs a port number between 0 and 65535`)
    return false
  }
  return Number(value)
}

/** The database in the path of a connection string, or an empty string. */
export function databaseOf(uri: string): string {
  return databaseFromUri(uri) ?? ""
}

/** Loads the config for a command, applying `--config`, `--env`, `--dir` and `--mongodb-uri`. */
export async function configure(call: Invocation, load: Command): Promise<Configured | undefined> {
  const { flags, environment } = call
  const uriFlag = text(flags, "mongodb-uri")
  const configEnv =
    environment === "production" || environment === "development"
      ? { ...call.env, CANOPY_ENV: environment }
      : call.env
  let loaded: LoadedConfig
  try {
    const file = text(flags, "config")
    loaded = await loadConfig({
      command:
        (uriFlag !== undefined || environment !== undefined) && load !== "print"
          ? "policies"
          : load,
      cwd: call.cwd,
      env: configEnv,
      ...(file === undefined ? {} : { file }),
    })
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error
    call.out.error(error.message)
    return undefined
  }
  const config = loaded.config
  const dir = resolve(
    call.cwd,
    text(flags, "dir") ?? ("dir" in config.policies ? config.policies.dir : "./canopy/policies"),
  )
  const dirGiven = flags.has("dir") || "dir" in config.policies
  return { ...call, loaded, config, dir, dirGiven, uriFlag }
}

function configuredUri(call: Configured): string | undefined {
  return call.uriFlag ?? (call.config.mongodb.uri === "" ? undefined : call.config.mongodb.uri)
}

/** The meta database of a command, or the admin API of the project named by `--env`. */
export async function metaTarget(call: Configured): Promise<MetaTarget | undefined> {
  if (call.environment !== undefined) {
    const remote = await remoteFor(call.environment, call.env, call.out)
    return remote === undefined ? undefined : { mongodbUri: "", metaDatabase: "", remote }
  }
  const uri = configuredUri(call)
  if (uri === undefined) {
    call.out.error(
      `${call.name} needs --mongodb-uri, MONGODB_URI or mongodb.uri in the config file`,
    )
    return undefined
  }
  return {
    mongodbUri: uri,
    metaDatabase: call.env["CANOPY_META_DB"] ?? call.config.mongodb.metaDatabase,
  }
}

/** The app database of a command, from the flags, the variables and the config. */
export function appTarget(call: Configured): AppTarget | undefined {
  const uri = configuredUri(call)
  if (uri === undefined) {
    call.out.error(
      `${call.name} needs --mongodb-uri, MONGODB_URI or mongodb.uri in the config file`,
    )
    return undefined
  }
  const database =
    text(call.flags, "database") ??
    (call.uriFlag === undefined
      ? call.config.mongodb.database
      : (call.env["CANOPY_DB"] ?? databaseOf(uri)))
  if (database === "") {
    call.out.error(`${call.name} needs --database, CANOPY_DB or a database in the URI path`)
    return undefined
  }
  return { mongodbUri: uri, database }
}

/** The `--comment` flag as an option. */
export function withComment(flags: Flags): { comment?: string } {
  const comment = text(flags, "comment")
  return comment === undefined ? {} : { comment }
}

/** Reads a whole number flag, reporting a bad value; `false` means the command must stop. */
export function count(
  value: string | undefined,
  flag: string,
  out: Output,
): number | undefined | false {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) {
    out.error(`--${flag} needs a whole number`)
    return false
  }
  return Number(value)
}

/**
 * The admin API behind `--env <name>`: the URL from `CANOPY_ADMIN_URL`, else the project stored by
 * `canopy login <url> --env <name>`; the token from `CANOPY_ADMIN_TOKEN`, else the one stored for that URL.
 * The token is checked first, and for the names `production` and `development` the server's `CANOPY_ENV`
 * must match, so a push meant for production never lands on a development server.
 */
async function remoteFor(
  environment: string,
  env: Env,
  out: Output,
): Promise<AdminClient | undefined> {
  const explicit = env["CANOPY_ADMIN_URL"]
  const url =
    explicit !== undefined && explicit !== "" ? explicit : await readEnvironment(environment, env)
  if (url === undefined) {
    out.error(
      `No project for --env ${environment}: run canopy login <url> --env ${environment}, or set CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN.`,
    )
    return undefined
  }
  const fromEnv = env["CANOPY_ADMIN_TOKEN"]
  const token = fromEnv !== undefined && fromEnv !== "" ? fromEnv : await readToken(url, { env })
  if (token === undefined) {
    out.error(
      `No admin token for ${url}: run canopy login ${url} --env ${environment}, or set CANOPY_ADMIN_TOKEN.`,
    )
    return undefined
  }
  const client = new AdminClient(url, token)
  try {
    const identity = await client.me()
    if (
      (environment === "production" || environment === "development") &&
      identity.environment !== environment
    ) {
      out.error(
        `--env ${environment} points at ${url}, which runs with CANOPY_ENV=${identity.environment}. Log in to the right project with canopy login <url> --env ${environment}.`,
      )
      return undefined
    }
    out.log(`env ${environment}: ${url} as ${identity.email} (${identity.role})`)
    return client
  } catch (error: unknown) {
    out.error(`--env ${environment}: ${messageOf(error)}`)
    return undefined
  }
}

/** Returns the project of an `admin tokens` command, reporting an error when `--env` is missing. */
export function tokensEnvironment(call: Invocation): string | undefined {
  if (call.environment === undefined)
    call.out.error(
      `${call.name} works on a project through its admin API: pass --env <name> (with canopy login <url> --env <name>, or CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN).`,
    )
  return call.environment
}

/** Runs `fn` with the admin API of the project an `admin tokens` command names. */
export async function withRemote(
  call: Invocation,
  fn: (remote: AdminClient) => Promise<number>,
): Promise<number> {
  const environment = tokensEnvironment(call)
  if (environment === undefined) return 1
  const remote = await remoteFor(environment, call.env, call.out)
  return remote === undefined ? 1 : fn(remote)
}
