#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import {
  type Command,
  ConfigError,
  databaseFromUri,
  formatConfig,
  type ResolvedConfig,
  suggest,
} from "@canopy/config"
import { type LoadedConfig, loadConfig } from "@canopy/config/load"
import { adminCreate, adminList, adminResetTotp } from "./admin.ts"
import { authImport, type ImportSource } from "./auth-import.ts"
import { doctor, policiesLint, policiesTest } from "./commands.ts"
import { isEnvironmentName, readEnvironment, readToken } from "./credentials.ts"
import { dev } from "./dev.ts"
import { policiesExplain } from "./explain.ts"
import { genTypes } from "./gen-types.ts"
import { indexes } from "./indexes.ts"
import { init } from "./init.ts"
import { keysCreate, keysList, keysRevoke, migrate } from "./keys.ts"
import { DEFAULT_MONGO_IMAGE, dockerAvailable, startLocalMongo } from "./local-mongo.ts"
import { login, logout } from "./login.ts"
import {
  DEFAULT_MONGO_VERSION,
  mongoCacheDir,
  type RunningMongo,
  startBinaryMongo,
} from "./mongod-binary.ts"
import { messageOf, type Output } from "./output.ts"
import {
  policiesDiff,
  policiesHistory,
  policiesPull,
  policiesPush,
  policiesRollback,
} from "./policies.ts"
import { realtimeImages } from "./realtime-images.ts"
import { AdminClient } from "./remote.ts"
import { tokensCreate, tokensList, tokensRevoke } from "./tokens.ts"

const USAGE = `Usage: canopy <command> [options]

Commands:
  init                   Add a canopy/ folder (config, starter policies, .env.example) to this project
  dev                    Run Canopy locally with hot reload; --with-mongo starts MongoDB too
  doctor                 Check MongoDB, change streams, policies and indexes
  policies lint          Validate and lint the policy directory
  policies test          Run policy tests in memory and, with --mongodb-uri, against MongoDB
  policies explain <collection>
                         Show how DLS decides an operation for a caller (--as, --roles, --op, --filter)
  policies diff [collection...]
                         Compare the policy directory with the published policies
  policies push [collection...]
                         Publish changed collections (versioned, audited, conditional)
  policies pull [collection...]
                         Write the published policies into the policy directory as TypeScript
  policies history <collection>
                         List the published versions of a collection
  policies rollback <collection> <version>
                         Republish an earlier version as a new one (asks first)
  auth import <file>     Import app users from --from firebase|auth0|cognito|csv into built in auth;
                         password hashes are checked on first sign in, then rehashed
  keys list              List the API keys of the project
  keys create            Create a key: --kind publishable|secret --name <name>
  keys revoke <id>       Revoke a key for good (asks first)
  admin list             List the Studio admins
  admin create           Create an admin: --email <email> --role owner|admin|developer|viewer [--name]
  admin reset-totp <id|email>
                         Clear an admin's TOTP and end their sessions (asks first)
  admin tokens create    Create a long lived admin API token for CI on the project behind --env:
                         --name <name> [--role <role>] [--expires <days>]
  admin tokens list      List your admin API tokens (--all: every admin's)
  admin tokens revoke <id>
                         Revoke an admin API token at once (asks first)
  migrate                Bring the meta database up to date (--status lists the migrations)
  login <url>            Verify an admin token and store it for a remote project in the OS keychain
  logout <url>           Remove the stored admin token of a project
  gen types              Generate the Database types from validators, config and sampled documents
  config print           Print the resolved config with secrets masked
  realtime enable-images <collection...>
                         Turn on change stream pre and post images (asks first)
  realtime disable-images <collection...>
                         Turn them off (asks first)
  indexes advise         Suggest indexes for the equality fields of policies and context lookups
  indexes create         Create the suggested indexes (asks first)

Settings come from canopy.config.ts (or canopy/canopy.config.ts), found from the working directory, and
the CANOPY_* variables. Flags override both.

Options:
  --config <file>        The config file (default: discovered)
  --dir <path>           Policy directory (default: the config's policies.dir, else ./canopy/policies)
  --mongodb-uri <uri>    MongoDB connection string (default: the config, else $MONGODB_URI)
  --database <name>      App database (default: the config, else $CANOPY_DB or the URI path)
  --out <file>           gen types: the file to write (default: the config's types.out, else src/canopy.gen.ts)
  --check                gen types: fail when the file is out of date instead of writing it
  --infer-enums          gen types: turn low cardinality string fields into literal unions
  --sample <n>           gen types: documents sampled per collection (default 1000)
  --sources              config print: show where each value came from
  --with-mongo           dev: start a single node replica set, in Docker when it runs (persistent volume),
                         otherwise from the official binaries (downloaded once, data in .canopy/mongodb)
  --mongo-binary         dev --with-mongo: use the official binaries even when Docker runs
  --mongo-version <x.y.z> dev --with-mongo: the binaries' version (default ${DEFAULT_MONGO_VERSION})
  --port <n>             dev: the port to serve on (default: the config's server.port)
  --mongo-port <n>       dev --with-mongo: the MongoDB port (default 27017)
  --mongo-image <image>  dev --with-mongo: the image (default ${DEFAULT_MONGO_IMAGE})
  --expect-version <v>   policies push: the version each change was made against, as n (one collection)
                         or collection=n pairs (_context=n for the context lookups); policies
                         rollback: the current version
  --comment <text>       policies push, rollback: recorded in the history and the audit log
  --dry-run              policies push: show what would be published; auth import: only read the file
  --fail-on-drift        policies diff: exit 1 when anything differs
  --force                policies pull: replace existing files
  --limit <n>            policies history: how many versions (default 50)
  --kind <kind>          keys create: publishable or secret
  --name <name>          keys create: a label for the key; admin create: the admin's name; admin tokens
                         create: the token's name
  --email <email>        admin create: the admin's email
  --role <role>          gen types: make fields this role cannot read optional; admin create, admin
                         tokens create: the role (a token's defaults to yours and may not be higher)
  --expires <days>       admin tokens create: days until the token expires, as 90 or 90d (default never)
  --all                  admin tokens list: every admin's tokens (owners and admins)
  --status               migrate: list the migrations instead of running them
  --token <token>        login: the admin token (default: $CANOPY_ADMIN_TOKEN, else asked for)
  --env <name>           login: remember the project under this name; policies push, diff, pull,
                         history, rollback and admin tokens: work on that project through its admin API
                         ($CANOPY_ADMIN_URL and $CANOPY_ADMIN_TOKEN override the stored login).
                         production and development also set CANOPY_ENV
  --yes                  realtime, indexes create, policies rollback, keys revoke, admin reset-totp,
                         admin tokens revoke: apply without asking
  --from <system>        auth import: firebase, auth0, cognito or csv
  --hash-key <base64>    auth import: Firebase's signer key; with --salt-separator, --rounds and
                         --mem-cost (the project's password hash parameters) imports password hashes
  --as <claims>          policies explain: the caller's claims as JSON (default: anon)
  --roles <a,b>          policies explain: custom roles of the caller
  --op <op>              policies explain: read, insert, update or delete (default read)
  --filter <json>        policies explain: the caller's read filter
  --ctx <json>           policies explain: context lookup values instead of resolving them
  --version              Print the version of the CLI
  --debug                With an unexpected error, print its stack trace
  --help                 Show this help`

const GLOBAL_FLAGS = ["help", "version", "debug", "config", "dir", "mongodb-uri", "database"]

/** Flags that never take a value, so a word after them stays a positional argument. */
const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "debug",
  "check",
  "infer-enums",
  "sources",
  "with-mongo",
  "mongo-binary",
  "yes",
  "dry-run",
  "fail-on-drift",
  "force",
  "status",
  "all",
])

type Flags = Map<string, string | true>
type Env = Readonly<Record<string, string | undefined>>

/** One run of a command, after its name, flags and arguments were checked. */
interface Invocation {
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
interface Configured extends Invocation {
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
interface AppTarget {
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

interface CommandSpec {
  readonly flags: readonly string[]
  /** The fewest and most positional arguments after the command name. */
  readonly args?: readonly [number, number]
  /** What the arguments are, for the error when their number is wrong. */
  readonly needs?: string
  readonly handler: Handler
}

const ANY = [0, Number.POSITIVE_INFINITY] as const

const EXPLAIN_FLAGS = ["as", "roles", "op", "filter", "ctx"]

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  doctor: {
    flags: [],
    handler: {
      kind: "app",
      load: "doctor",
      run: (call, app) => doctor({ ...app, ...(call.dirGiven ? { dir: call.dir } : {}) }, call.out),
    },
  },
  "policies lint": {
    flags: [],
    handler: {
      kind: "config",
      load: "policies",
      run: (call) => policiesLint({ dir: call.dir }, call.out),
    },
  },
  "policies test": {
    flags: [],
    handler: {
      kind: "config",
      load: "policies",
      run: (call) =>
        policiesTest(
          { dir: call.dir, ...(call.uriFlag === undefined ? {} : { mongodbUri: call.uriFlag }) },
          call.out,
        ),
    },
  },
  "policies explain": {
    flags: EXPLAIN_FLAGS,
    args: [1, 1],
    needs: "exactly one collection",
    handler: { kind: "config", load: "policies", run: runExplain },
  },
  "policies diff": {
    flags: ["fail-on-drift", "env"],
    args: ANY,
    handler: {
      kind: "meta",
      run: (call, meta) =>
        policiesDiff(
          {
            ...meta,
            dir: call.dir,
            collections: call.args,
            failOnDrift: call.flags.has("fail-on-drift"),
          },
          call.out,
        ),
    },
  },
  "policies push": {
    flags: ["expect-version", "comment", "dry-run", "env"],
    args: ANY,
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const expectVersion = text(call.flags, "expect-version")
        return policiesPush(
          {
            ...meta,
            dir: call.dir,
            collections: call.args,
            dryRun: call.flags.has("dry-run"),
            ...withComment(call.flags),
            ...(expectVersion === undefined ? {} : { expectVersion }),
          },
          call.out,
        )
      },
    },
  },
  "policies pull": {
    flags: ["force", "env"],
    args: ANY,
    handler: {
      kind: "meta",
      run: (call, meta) =>
        policiesPull(
          { ...meta, dir: call.dir, collections: call.args, force: call.flags.has("force") },
          call.out,
        ),
    },
  },
  "policies history": {
    flags: ["limit", "env"],
    args: [1, 1],
    needs: "exactly one collection",
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const limit = count(text(call.flags, "limit"), "limit", call.out)
        if (limit === false) return 1
        return policiesHistory(
          { ...meta, collection: call.args[0] ?? "", ...(limit === undefined ? {} : { limit }) },
          call.out,
        )
      },
    },
  },
  "policies rollback": {
    flags: ["expect-version", "comment", "yes", "env"],
    args: [2, 2],
    needs: "a collection and a version",
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const version = count(call.args[1], "version", call.out)
        const expectVersion = count(text(call.flags, "expect-version"), "expect-version", call.out)
        if (version === false || version === undefined || expectVersion === false) return 1
        return policiesRollback(
          {
            ...meta,
            collection: call.args[0] ?? "",
            version,
            yes: call.flags.has("yes"),
            ...withComment(call.flags),
            ...(expectVersion === undefined ? {} : { expectVersion }),
          },
          call.out,
        )
      },
    },
  },
  "gen types": {
    flags: ["out", "role", "check", "infer-enums", "sample"],
    handler: { kind: "app", load: "gen", run: runGenTypes },
  },
  "config print": {
    flags: ["sources"],
    handler: {
      kind: "config",
      load: "print",
      run: (call) => {
        call.out.log(formatConfig(call.loaded, { sources: call.flags.has("sources") }).trimEnd())
        return 0
      },
    },
  },
  init: { flags: [], handler: { kind: "direct", run: runInit } },
  dev: {
    flags: ["with-mongo", "mongo-binary", "mongo-version", "port", "mongo-port", "mongo-image"],
    handler: { kind: "direct", run: runDev },
  },
  "realtime enable-images": {
    flags: ["yes"],
    args: ANY,
    handler: { kind: "app", load: "gen", run: (call, app) => runImages(call, app, true) },
  },
  "realtime disable-images": {
    flags: ["yes"],
    args: ANY,
    handler: { kind: "app", load: "gen", run: (call, app) => runImages(call, app, false) },
  },
  "indexes advise": {
    flags: [],
    handler: { kind: "app", load: "gen", run: (call, app) => runIndexes(call, app, false) },
  },
  "indexes create": {
    flags: ["yes"],
    handler: { kind: "app", load: "gen", run: (call, app) => runIndexes(call, app, true) },
  },
  "keys list": {
    flags: [],
    handler: { kind: "meta", run: (call, meta) => keysList(meta, call.out) },
  },
  "keys create": {
    flags: ["kind", "name"],
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const kind = text(call.flags, "kind")
        const keyName = text(call.flags, "name")
        if ((kind !== "publishable" && kind !== "secret") || keyName === undefined) {
          call.out.error("keys create needs --kind publishable|secret and --name <name>")
          return 1
        }
        return keysCreate({ ...meta, kind, name: keyName }, call.out)
      },
    },
  },
  "keys revoke": {
    flags: ["yes"],
    args: [1, 1],
    needs: "the id of one key",
    handler: {
      kind: "meta",
      run: (call, meta) =>
        keysRevoke({ ...meta, id: call.args[0] ?? "", yes: call.flags.has("yes") }, call.out),
    },
  },
  "admin list": {
    flags: [],
    handler: { kind: "meta", run: (call, meta) => adminList(meta, call.out) },
  },
  "admin create": {
    flags: ["email", "role", "name"],
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const email = text(call.flags, "email")
        const role = text(call.flags, "role")
        const adminName = text(call.flags, "name")
        if (email === undefined || role === undefined) {
          call.out.error(
            "admin create needs --email <email> and --role owner|admin|developer|viewer",
          )
          return 1
        }
        return adminCreate(
          { ...meta, email, role, ...(adminName === undefined ? {} : { name: adminName }) },
          call.out,
        )
      },
    },
  },
  "auth import": {
    flags: ["from", "hash-key", "salt-separator", "rounds", "mem-cost", "dry-run", "env"],
    args: [1, 1],
    needs: "the export file",
    handler: { kind: "direct", run: runAuthImport },
  },
  "admin reset-totp": {
    flags: ["yes"],
    args: [1, 1],
    needs: "the id or email of one admin",
    handler: {
      kind: "meta",
      run: (call, meta) =>
        adminResetTotp(
          { ...meta, admin: call.args[0] ?? "", yes: call.flags.has("yes") },
          call.out,
        ),
    },
  },
  "admin tokens create": {
    flags: ["name", "role", "expires", "env"],
    handler: { kind: "direct", run: runTokensCreate },
  },
  "admin tokens list": {
    flags: ["all", "env"],
    handler: {
      kind: "direct",
      run: (call) =>
        withRemote(call, (remote) => tokensList({ remote, all: call.flags.has("all") }, call.out)),
    },
  },
  "admin tokens revoke": {
    flags: ["yes", "env"],
    args: [1, 1],
    needs: "the id of one token",
    handler: {
      kind: "direct",
      run: (call) =>
        withRemote(call, (remote) =>
          tokensRevoke({ remote, id: call.args[0] ?? "", yes: call.flags.has("yes") }, call.out),
        ),
    },
  },
  migrate: {
    flags: ["status"],
    handler: {
      kind: "meta",
      run: (call, meta) => migrate({ ...meta, status: call.flags.has("status") }, call.out),
    },
  },
  login: {
    flags: ["token", "env"],
    args: [1, 1],
    needs: "the project URL",
    handler: { kind: "direct", run: (call) => login(accountOptions(call), call.out) },
  },
  logout: {
    flags: [],
    args: [1, 1],
    needs: "the project URL",
    handler: { kind: "direct", run: (call) => logout(accountOptions(call), call.out) },
  },
}

/** Commands of one word; every other command has two words, or three in a group. */
const SINGLE = new Set(Object.keys(COMMANDS).filter((name) => !name.includes(" ")))

/** Command groups whose commands have three words, such as `admin tokens create`. */
const GROUPS = new Set(["admin tokens"])

/** Parses `--name value` flags. Flags in `booleans` never take the next word as their value. */
export function parseArgs(
  argv: readonly string[],
  booleans: ReadonlySet<string> = BOOLEAN_FLAGS,
): {
  positional: string[]
  flags: Flags
} {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split("=", 2)
    const next = argv[index + 1]
    if (inline !== undefined) flags.set(name ?? "", inline)
    else if (next !== undefined && !next.startsWith("--") && !booleans.has(name ?? "")) {
      flags.set(name ?? "", next)
      index += 1
    } else flags.set(name ?? "", true)
  }
  return { positional, flags }
}

function text(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

function port(value: string | undefined, flag: string, out: Output): number | undefined | false {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    out.error(`--${flag} needs a port number between 0 and 65535`)
    return false
  }
  return Number(value)
}

function databaseOf(uri: string): string {
  return databaseFromUri(uri) ?? ""
}

/**
 * The version of this package, from its `package.json` (one level above both `src/` and `dist/`). A
 * standalone executable has no such file, so `build.ts` embeds the version as `CANOPY_BUILD_VERSION`.
 */
function cliVersion(): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  } catch {
    return process.env["CANOPY_BUILD_VERSION"] ?? "unknown"
  }
  const version =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { version?: unknown }).version
      : undefined
  return typeof version === "string" ? version : "unknown"
}

/**
 * Runs the CLI and returns the exit code. `signal` stops long running commands (`dev`); without it they
 * run until the process ends.
 */
export async function run(
  argv: readonly string[],
  env: Env,
  out: Output,
  cwd: string = process.cwd(),
  signal: AbortSignal = new AbortController().signal,
): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  if (flags.has("version")) {
    out.log(cliVersion())
    return 0
  }
  if (flags.has("help") || positional.length === 0) {
    out.log(USAGE)
    return positional.length === 0 && !flags.has("help") ? 1 : 0
  }
  const first = positional[0] ?? ""
  const name = SINGLE.has(first)
    ? first
    : GROUPS.has(positional.slice(0, 2).join(" "))
      ? positional.slice(0, 3).join(" ")
      : positional.slice(0, 2).join(" ")
  const args = positional.slice(name.split(" ").length)
  const spec = COMMANDS[name]
  if (spec === undefined) {
    const near = suggest(name, Object.keys(COMMANDS))
    out.error(
      `Unknown command: ${positional.join(" ")}${near === undefined ? "" : `. Did you mean canopy ${near}?`}\n\n${USAGE}`,
    )
    return 1
  }
  const allowed = spec.flags
  for (const flag of flags.keys()) {
    if (GLOBAL_FLAGS.includes(flag) || allowed.includes(flag)) continue
    const near = suggest(flag, [...GLOBAL_FLAGS, ...allowed])
    out.error(
      `Unknown option --${flag} for ${name}.${near === undefined ? "" : ` Did you mean --${near}?`}`,
    )
    return 1
  }
  const [fewest, most] = spec.args ?? [0, 0]
  if (args.length < fewest || args.length > most) {
    out.error(
      spec.needs === undefined
        ? `Unexpected argument ${args.slice(most).join(" ")} for ${name}`
        : `${name} needs ${spec.needs}`,
    )
    return 1
  }
  const environment = flags.get("env")
  if (environment === true) {
    out.error("--env needs an environment name, such as --env production")
    return 1
  }
  if (environment !== undefined && !isEnvironmentName(environment)) {
    out.error(
      `--env ${JSON.stringify(environment)} is not an environment name: a letter, then letters, digits, _ or -`,
    )
    return 1
  }
  const call: Invocation = { name, args, flags, env, out, cwd, signal, environment }
  const handler = spec.handler
  if (handler.kind === "direct") return handler.run(call)
  const configured = await configure(call, handler.kind === "meta" ? "gen" : handler.load)
  if (configured === undefined) return 1
  if (handler.kind === "config") return handler.run(configured)
  if (handler.kind === "meta") {
    const meta = await metaTarget(configured)
    return meta === undefined ? 1 : handler.run(configured, meta)
  }
  const app = appTarget(configured)
  return app === undefined ? 1 : handler.run(configured, app)
}

async function configure(call: Invocation, load: Command): Promise<Configured | undefined> {
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

async function metaTarget(call: Configured): Promise<MetaTarget | undefined> {
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

function appTarget(call: Configured): AppTarget | undefined {
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

function withComment(flags: Flags): { comment?: string } {
  const comment = text(flags, "comment")
  return comment === undefined ? {} : { comment }
}

function runInit(call: Invocation): number | Promise<number> {
  const uriFlag = text(call.flags, "mongodb-uri")
  const database =
    text(call.flags, "database") ?? (uriFlag === undefined ? "" : databaseOf(uriFlag))
  if (uriFlag !== undefined && database === "") {
    call.out.error("init --mongodb-uri needs --database or a database in the URI path")
    return 1
  }
  return init(
    { cwd: call.cwd, ...(uriFlag === undefined ? {} : { mongodbUri: uriFlag, database }) },
    call.out,
  )
}

function accountOptions(call: Invocation): {
  url: string
  env: Env
  token?: string
  environment?: string
} {
  const token = text(call.flags, "token")
  return {
    url: call.args[0] ?? "",
    env: call.env,
    ...(token === undefined ? {} : { token }),
    ...(call.environment === undefined ? {} : { environment: call.environment }),
  }
}

function runExplain(call: Configured): number | Promise<number> {
  const bare = EXPLAIN_FLAGS.find((flag) => call.flags.get(flag) === true)
  if (bare !== undefined) {
    call.out.error(`--${bare} needs a value`)
    return 1
  }
  const explainOptions = EXPLAIN_FLAGS.flatMap((flag) => {
    const value = text(call.flags, flag)
    return value === undefined ? [] : [[flag, value] as const]
  })
  const { uriFlag } = call
  return policiesExplain(
    {
      dir: call.dir,
      collection: call.args[0] ?? "",
      ...Object.fromEntries(explainOptions),
      ...(uriFlag === undefined
        ? {}
        : {
            mongodbUri: uriFlag,
            database: text(call.flags, "database") ?? call.env["CANOPY_DB"] ?? databaseOf(uriFlag),
          }),
    },
    call.out,
  )
}

function runImages(call: Configured, app: AppTarget, enable: boolean): Promise<number> {
  return realtimeImages(
    { ...app, collections: call.args, enable, yes: call.flags.has("yes") },
    call.out,
  )
}

function runIndexes(call: Configured, app: AppTarget, create: boolean): Promise<number> {
  return indexes(
    {
      ...app,
      metaDatabase: call.config.mongodb.metaDatabase,
      create,
      yes: call.flags.has("yes"),
      ...(call.dirGiven ? { dir: call.dir } : {}),
    },
    call.out,
  )
}

function runGenTypes(call: Configured, app: AppTarget): number | Promise<number> {
  const { flags, config } = call
  const sample = text(flags, "sample")
  const role = text(flags, "role") ?? config.types.role
  if (sample !== undefined && !/^[1-9]\d*$/.test(sample)) {
    call.out.error("--sample needs a positive integer")
    return 1
  }
  return genTypes(
    {
      ...app,
      out: text(flags, "out") ?? config.types.out,
      check: flags.has("check"),
      inferEnums: flags.has("infer-enums"),
      ...(call.dirGiven ? { dir: call.dir } : {}),
      ...(role === undefined ? {} : { role }),
      ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
    },
    call.out,
  )
}

function count(value: string | undefined, flag: string, out: Output): number | undefined | false {
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
function tokensEnvironment(call: Invocation): string | undefined {
  if (call.environment === undefined)
    call.out.error(
      `${call.name} works on a project through its admin API: pass --env <name> (with canopy login <url> --env <name>, or CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN).`,
    )
  return call.environment
}

async function withRemote(
  call: Invocation,
  fn: (remote: AdminClient) => Promise<number>,
): Promise<number> {
  const environment = tokensEnvironment(call)
  if (environment === undefined) return 1
  const remote = await remoteFor(environment, call.env, call.out)
  return remote === undefined ? 1 : fn(remote)
}

const IMPORT_SOURCES: readonly ImportSource[] = ["firebase", "auth0", "cognito", "csv"]

function runAuthImport(call: Invocation): number | Promise<number> {
  const { flags, out } = call
  const from = text(flags, "from")
  if (from === undefined || !(IMPORT_SOURCES as readonly string[]).includes(from)) {
    out.error("auth import needs --from firebase|auth0|cognito|csv")
    return 1
  }
  const hashKey = text(flags, "hash-key")
  const separator = text(flags, "salt-separator")
  const rounds = Number(text(flags, "rounds") ?? "8")
  const memCost = Number(text(flags, "mem-cost") ?? "14")
  if (hashKey !== undefined && (separator === undefined || from !== "firebase")) {
    out.error(
      "--hash-key is for --from firebase and needs --salt-separator (and --rounds, --mem-cost)",
    )
    return 1
  }
  if (!Number.isInteger(rounds) || !Number.isInteger(memCost)) {
    out.error("--rounds and --mem-cost must be integers")
    return 1
  }
  const run = (remote: AdminClient | undefined): Promise<number> =>
    authImport(
      {
        file: resolve(call.cwd, call.args[0] ?? ""),
        from: from as ImportSource,
        dryRun: flags.has("dry-run"),
        remote,
        ...(hashKey === undefined || separator === undefined
          ? {}
          : { firebase: { signerKey: hashKey, saltSeparator: separator, rounds, memCost } }),
      },
      out,
    )
  return flags.has("dry-run") ? run(undefined) : withRemote(call, run)
}

function runTokensCreate(call: Invocation): number | Promise<number> {
  if (tokensEnvironment(call) === undefined) return 1
  const { flags, out } = call
  const tokenName = text(flags, "name")
  if (tokenName === undefined) {
    out.error("admin tokens create needs --name <name>")
    return 1
  }
  const role = text(flags, "role")
  if (role !== undefined && !["owner", "admin", "developer", "viewer"].includes(role)) {
    out.error("--role must be owner, admin, developer or viewer")
    return 1
  }
  const expires = text(flags, "expires")
  const days = expires === undefined ? undefined : /^([1-9]\d{0,3})d?$/.exec(expires)?.[1]
  if (expires !== undefined && days === undefined) {
    out.error("--expires needs a number of days, such as 90 or 90d")
    return 1
  }
  return withRemote(call, (remote) =>
    tokensCreate(
      {
        remote,
        name: tokenName,
        ...(role === undefined ? {} : { role }),
        ...(days === undefined ? {} : { expiresInDays: Number(days) }),
      },
      out,
    ),
  )
}

async function runDev(call: Invocation): Promise<number> {
  const { flags, env, out, cwd, signal } = call
  const serverPort = port(text(flags, "port"), "port", out)
  const mongoPort = port(text(flags, "mongo-port"), "mongo-port", out)
  if (serverPort === false || mongoPort === false) return 1
  let devEnv = env
  let binary: RunningMongo | undefined
  if (flags.has("with-mongo")) {
    const configured = env["MONGODB_URI"]
    const database =
      text(flags, "database") ??
      env["CANOPY_DB"] ??
      (configured === undefined ? "" : databaseOf(configured))
    const app = database === "" ? "app" : database
    try {
      const useDocker = !flags.has("mongo-binary") && (await dockerAvailable())
      let uri: string
      if (useDocker) {
        uri = await startLocalMongo({
          projectDir: cwd,
          port: mongoPort ?? 27017,
          database: app,
          image: text(flags, "mongo-image") ?? env["CANOPY_MONGO_IMAGE"] ?? DEFAULT_MONGO_IMAGE,
          log: (line) => out.log(line),
        })
      } else {
        if (!flags.has("mongo-binary")) out.log("Docker is not running: using the MongoDB binaries")
        binary = await startBinaryMongo({
          projectDir: cwd,
          port: mongoPort ?? 27017,
          database: app,
          version: text(flags, "mongo-version") ?? DEFAULT_MONGO_VERSION,
          cacheDir: mongoCacheDir(env),
          log: (line) => out.log(line),
        })
        uri = binary.uri
      }
      devEnv = { ...env, MONGODB_URI: uri }
      out.log(`MongoDB is ready at ${uri}`)
    } catch (error: unknown) {
      out.error(`--with-mongo: ${messageOf(error)}`)
      return 1
    }
  }
  try {
    return await dev(
      {
        cwd,
        env: devEnv,
        ...(text(flags, "config") === undefined ? {} : { configFile: text(flags, "config") ?? "" }),
        ...(serverPort === undefined ? {} : { port: serverPort }),
      },
      out,
      signal,
    )
  } finally {
    await binary?.stop()
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop() ?? "")
if (isMain) {
  const out: Output = {
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    ...(process.stdin.isTTY === true
      ? {
          confirm: async (question: string) => {
            const prompt = createInterface({ input: process.stdin, output: process.stdout })
            try {
              return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim())
            } finally {
              prompt.close()
            }
          },
        }
      : {}),
    readSecret: async (question: string) => {
      if (process.stdin.isTTY !== true) {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
        return Buffer.concat(chunks).toString("utf8").trim()
      }
      process.stdout.write(question)
      const muted = new Writable({ write: (_chunk, _encoding, done) => done() })
      const prompt = createInterface({ input: process.stdin, output: muted, terminal: true })
      try {
        return await prompt.question("")
      } finally {
        prompt.close()
        process.stdout.write("\n")
      }
    },
  }
  const stop = new AbortController()
  process.once("SIGINT", () => stop.abort())
  process.once("SIGTERM", () => stop.abort())
  if (process.platform === "win32") process.once("SIGBREAK", () => stop.abort())
  run(process.argv.slice(2), process.env, out, process.cwd(), stop.signal).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      const debug = process.argv.includes("--debug")
      const detail =
        error instanceof Error
          ? debug
            ? (error.stack ?? error.message)
            : error.message
          : String(error)
      const hint = debug ? "" : "Run again with --debug for the stack trace.\n"
      process.stderr.write(`${detail}\n${hint}`)
      process.exitCode = 1
    },
  )
}
