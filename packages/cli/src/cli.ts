#!/usr/bin/env node
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import {
  ConfigError,
  databaseFromUri,
  formatConfig,
  type ResolvedConfig,
  suggest,
} from "@canopy/config"
import { type LoadedConfig, loadConfig } from "@canopy/config/load"
import { adminCreate, adminList, adminResetTotp } from "./admin.ts"
import { doctor, policiesLint, policiesTest } from "./commands.ts"
import { isEnvironmentName, readEnvironment, readToken } from "./credentials.ts"
import { dev } from "./dev.ts"
import { policiesExplain } from "./explain.ts"
import { genTypes } from "./gen-types.ts"
import { indexes } from "./indexes.ts"
import { init } from "./init.ts"
import { keysCreate, keysList, keysRevoke, migrate } from "./keys.ts"
import { DEFAULT_MONGO_IMAGE, startLocalMongo } from "./local-mongo.ts"
import { login, logout } from "./login.ts"
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
  dev                    Run Canopy locally with hot reload; --with-mongo starts MongoDB in Docker
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
  --with-mongo           dev: start a single node replica set in Docker (persistent volume)
  --port <n>             dev: the port to serve on (default: the config's server.port)
  --mongo-port <n>       dev --with-mongo: the MongoDB port (default 27017)
  --mongo-image <image>  dev --with-mongo: the image (default ${DEFAULT_MONGO_IMAGE})
  --expect-version <v>   policies push: the version each change was made against, as n (one collection)
                         or collection=n pairs (_context=n for the context lookups); policies
                         rollback: the current version
  --comment <text>       policies push, rollback: recorded in the history and the audit log
  --dry-run              policies push: show what would be published
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
  --as <claims>          policies explain: the caller's claims as JSON (default: anon)
  --roles <a,b>          policies explain: custom roles of the caller
  --op <op>              policies explain: read, insert, update or delete (default read)
  --filter <json>        policies explain: the caller's read filter
  --ctx <json>           policies explain: context lookup values instead of resolving them
  --help                 Show this help`

const GLOBAL_FLAGS = ["help", "config", "dir", "mongodb-uri", "database"]

/** Flags that never take a value, so a word after them stays a positional argument. */
const BOOLEAN_FLAGS = new Set([
  "help",
  "check",
  "infer-enums",
  "sources",
  "with-mongo",
  "yes",
  "dry-run",
  "fail-on-drift",
  "force",
  "status",
  "all",
])

interface CommandSpec {
  readonly flags: readonly string[]
  /** The fewest and most positional arguments after the command name. */
  readonly args?: readonly [number, number]
  /** What the arguments are, for the error when their number is wrong. */
  readonly needs?: string
}

const ANY = [0, Number.POSITIVE_INFINITY] as const

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  doctor: { flags: [] },
  "policies lint": { flags: [] },
  "policies test": { flags: [] },
  "policies explain": {
    flags: ["as", "roles", "op", "filter", "ctx"],
    args: [1, 1],
    needs: "exactly one collection",
  },
  "policies diff": { flags: ["fail-on-drift", "env"], args: ANY },
  "policies push": { flags: ["expect-version", "comment", "dry-run", "env"], args: ANY },
  "policies pull": { flags: ["force", "env"], args: ANY },
  "policies history": { flags: ["limit", "env"], args: [1, 1], needs: "exactly one collection" },
  "policies rollback": {
    flags: ["expect-version", "comment", "yes", "env"],
    args: [2, 2],
    needs: "a collection and a version",
  },
  "gen types": { flags: ["out", "role", "check", "infer-enums", "sample"] },
  "config print": { flags: ["sources"] },
  init: { flags: [] },
  dev: { flags: ["with-mongo", "port", "mongo-port", "mongo-image"] },
  "realtime enable-images": { flags: ["yes"], args: ANY },
  "realtime disable-images": { flags: ["yes"], args: ANY },
  "indexes advise": { flags: [] },
  "indexes create": { flags: ["yes"] },
  "keys list": { flags: [] },
  "keys create": { flags: ["kind", "name"] },
  "keys revoke": { flags: ["yes"], args: [1, 1], needs: "the id of one key" },
  "admin list": { flags: [] },
  "admin create": { flags: ["email", "role", "name"] },
  "admin reset-totp": { flags: ["yes"], args: [1, 1], needs: "the id or email of one admin" },
  "admin tokens create": { flags: ["name", "role", "expires", "env"] },
  "admin tokens list": { flags: ["all", "env"] },
  "admin tokens revoke": { flags: ["yes", "env"], args: [1, 1], needs: "the id of one token" },
  migrate: { flags: ["status"] },
  login: { flags: ["token", "env"], args: [1, 1], needs: "the project URL" },
  logout: { flags: [], args: [1, 1], needs: "the project URL" },
}

const SINGLE = new Set(["doctor", "init", "dev", "migrate", "login", "logout"])

/** Command groups whose commands have three words, such as `admin tokens create`. */
const GROUPS = new Set(["admin tokens"])

/** Commands that only use the meta database, not the app database. */
const META_ONLY = new Set([
  "policies diff",
  "policies push",
  "policies pull",
  "policies history",
  "policies rollback",
  "keys list",
  "keys create",
  "keys revoke",
  "admin list",
  "admin create",
  "admin reset-totp",
  "migrate",
])

/** Parses `--name value` flags. Flags in `booleans` never take the next word as their value. */
export function parseArgs(
  argv: readonly string[],
  booleans: ReadonlySet<string> = BOOLEAN_FLAGS,
): {
  positional: string[]
  flags: Map<string, string | true>
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

function text(flags: Map<string, string | true>, name: string): string | undefined {
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
 * Runs the CLI and returns the exit code. `signal` stops long running commands (`dev`); without it they
 * run until the process ends.
 */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Output,
  cwd: string = process.cwd(),
  signal: AbortSignal = new AbortController().signal,
): Promise<number> {
  const { positional, flags } = parseArgs(argv)
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
  const rest = positional.slice(name.split(" ").length)
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
  if (rest.length < fewest || rest.length > most) {
    out.error(
      spec.needs === undefined
        ? `Unexpected argument ${rest.slice(most).join(" ")} for ${name}`
        : `${name} needs ${spec.needs}`,
    )
    return 1
  }
  const uriFlag = text(flags, "mongodb-uri")
  if (name === "init") {
    const database = text(flags, "database") ?? (uriFlag === undefined ? "" : databaseOf(uriFlag))
    if (uriFlag !== undefined && database === "") {
      out.error("init --mongodb-uri needs --database or a database in the URI path")
      return 1
    }
    return init({ cwd, ...(uriFlag === undefined ? {} : { mongodbUri: uriFlag, database }) }, out)
  }
  if (name === "dev") return runDev(flags, env, out, cwd, signal)
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
  if (name === "login" || name === "logout") {
    const token = text(flags, "token")
    const options = {
      url: rest[0] ?? "",
      env,
      ...(token === undefined ? {} : { token }),
      ...(environment === undefined ? {} : { environment }),
    }
    return name === "login" ? login(options, out) : logout(options, out)
  }
  if (name.startsWith("admin tokens ")) {
    if (environment === undefined) {
      out.error(
        `${name} works on a project through its admin API: pass --env <name> (with canopy login <url> --env <name>, or CANOPY_ADMIN_URL and CANOPY_ADMIN_TOKEN).`,
      )
      return 1
    }
    return adminTokens(name, rest, flags, environment, env, out)
  }
  const configEnv =
    environment === "production" || environment === "development"
      ? { ...env, CANOPY_ENV: environment }
      : env
  const command =
    name === "config print"
      ? "print"
      : name === "doctor"
        ? "doctor"
        : name === "policies lint" || name === "policies test" || name === "policies explain"
          ? "policies"
          : "gen"
  let loaded: LoadedConfig
  try {
    const file = text(flags, "config")
    loaded = await loadConfig({
      command:
        (uriFlag !== undefined || environment !== undefined) && command !== "print"
          ? "policies"
          : command,
      cwd,
      env: configEnv,
      ...(file === undefined ? {} : { file }),
    })
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error
    out.error(error.message)
    return 1
  }
  const config: ResolvedConfig = loaded.config
  if (name === "config print") {
    out.log(formatConfig(loaded, { sources: flags.has("sources") }).trimEnd())
    return 0
  }
  const dir = resolve(
    cwd,
    text(flags, "dir") ?? ("dir" in config.policies ? config.policies.dir : "./canopy/policies"),
  )
  const dirGiven = flags.has("dir") || "dir" in config.policies
  const uri = uriFlag ?? (config.mongodb.uri === "" ? undefined : config.mongodb.uri)
  if (name === "policies lint") return policiesLint({ dir }, out)
  if (name === "policies test")
    return policiesTest({ dir, ...(uriFlag === undefined ? {} : { mongodbUri: uriFlag }) }, out)
  if (name === "policies explain") {
    const bare = ["as", "roles", "op", "filter", "ctx"].find((flag) => flags.get(flag) === true)
    if (bare !== undefined) {
      out.error(`--${bare} needs a value`)
      return 1
    }
    const explainOptions = ["as", "roles", "op", "filter", "ctx"].flatMap((flag) => {
      const value = text(flags, flag)
      return value === undefined ? [] : [[flag, value] as const]
    })
    return policiesExplain(
      {
        dir,
        collection: rest[0] ?? "",
        ...Object.fromEntries(explainOptions),
        ...(uriFlag === undefined
          ? {}
          : {
              mongodbUri: uriFlag,
              database: text(flags, "database") ?? env["CANOPY_DB"] ?? databaseOf(uriFlag),
            }),
      },
      out,
    )
  }
  if (environment !== undefined) {
    const remote = await remoteFor(environment, env, out)
    if (remote === undefined) return 1
    return runMeta(name, rest, flags, { mongodbUri: "", metaDatabase: "", remote }, dir, out)
  }
  if (uri === undefined) {
    out.error(`${name} needs --mongodb-uri, MONGODB_URI or mongodb.uri in the config file`)
    return 1
  }
  if (META_ONLY.has(name))
    return runMeta(
      name,
      rest,
      flags,
      { mongodbUri: uri, metaDatabase: env["CANOPY_META_DB"] ?? config.mongodb.metaDatabase },
      dir,
      out,
    )
  const database =
    text(flags, "database") ??
    (uriFlag === undefined ? config.mongodb.database : (env["CANOPY_DB"] ?? databaseOf(uri)))
  if (database === "") {
    out.error(`${name} needs --database, CANOPY_DB or a database in the URI path`)
    return 1
  }
  if (name === "doctor")
    return doctor({ mongodbUri: uri, database, ...(dirGiven ? { dir } : {}) }, out)
  if (name.startsWith("realtime "))
    return realtimeImages(
      {
        mongodbUri: uri,
        database,
        collections: rest,
        enable: name === "realtime enable-images",
        yes: flags.has("yes"),
      },
      out,
    )
  if (name.startsWith("indexes "))
    return indexes(
      {
        mongodbUri: uri,
        database,
        metaDatabase: config.mongodb.metaDatabase,
        create: name === "indexes create",
        yes: flags.has("yes"),
        ...(dirGiven ? { dir } : {}),
      },
      out,
    )
  const sample = text(flags, "sample")
  const role = text(flags, "role") ?? config.types.role
  if (sample !== undefined && !/^[1-9]\d*$/.test(sample)) {
    out.error("--sample needs a positive integer")
    return 1
  }
  return genTypes(
    {
      mongodbUri: uri,
      database,
      out: text(flags, "out") ?? config.types.out,
      check: flags.has("check"),
      inferEnums: flags.has("infer-enums"),
      ...(dirGiven ? { dir } : {}),
      ...(role === undefined ? {} : { role }),
      ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
    },
    out,
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
  env: Readonly<Record<string, string | undefined>>,
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

async function adminTokens(
  name: string,
  args: readonly string[],
  flags: Map<string, string | true>,
  environment: string,
  env: Readonly<Record<string, string | undefined>>,
  out: Output,
): Promise<number> {
  if (name === "admin tokens create") {
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
    const remote = await remoteFor(environment, env, out)
    if (remote === undefined) return 1
    return tokensCreate(
      {
        remote,
        name: tokenName,
        ...(role === undefined ? {} : { role }),
        ...(days === undefined ? {} : { expiresInDays: Number(days) }),
      },
      out,
    )
  }
  const remote = await remoteFor(environment, env, out)
  if (remote === undefined) return 1
  if (name === "admin tokens list") return tokensList({ remote, all: flags.has("all") }, out)
  return tokensRevoke({ remote, id: args[0] ?? "", yes: flags.has("yes") }, out)
}

async function runMeta(
  name: string,
  args: readonly string[],
  flags: Map<string, string | true>,
  meta: {
    readonly mongodbUri: string
    readonly metaDatabase: string
    readonly remote?: AdminClient
  },
  dir: string,
  out: Output,
): Promise<number> {
  const comment = text(flags, "comment")
  const withComment = comment === undefined ? {} : { comment }
  switch (name) {
    case "policies diff":
      return policiesDiff(
        { ...meta, dir, collections: args, failOnDrift: flags.has("fail-on-drift") },
        out,
      )
    case "policies push": {
      const expectVersion = text(flags, "expect-version")
      return policiesPush(
        {
          ...meta,
          dir,
          collections: args,
          dryRun: flags.has("dry-run"),
          ...withComment,
          ...(expectVersion === undefined ? {} : { expectVersion }),
        },
        out,
      )
    }
    case "policies pull":
      return policiesPull({ ...meta, dir, collections: args, force: flags.has("force") }, out)
    case "policies history": {
      const limit = count(text(flags, "limit"), "limit", out)
      if (limit === false) return 1
      return policiesHistory(
        { ...meta, collection: args[0] ?? "", ...(limit === undefined ? {} : { limit }) },
        out,
      )
    }
    case "policies rollback": {
      const version = count(args[1], "version", out)
      const expectVersion = count(text(flags, "expect-version"), "expect-version", out)
      if (version === false || version === undefined || expectVersion === false) return 1
      return policiesRollback(
        {
          ...meta,
          collection: args[0] ?? "",
          version,
          yes: flags.has("yes"),
          ...withComment,
          ...(expectVersion === undefined ? {} : { expectVersion }),
        },
        out,
      )
    }
    case "keys list":
      return keysList(meta, out)
    case "keys create": {
      const kind = text(flags, "kind")
      const keyName = text(flags, "name")
      if ((kind !== "publishable" && kind !== "secret") || keyName === undefined) {
        out.error("keys create needs --kind publishable|secret and --name <name>")
        return 1
      }
      return keysCreate({ ...meta, kind, name: keyName }, out)
    }
    case "keys revoke":
      return keysRevoke({ ...meta, id: args[0] ?? "", yes: flags.has("yes") }, out)
    case "admin list":
      return adminList(meta, out)
    case "admin create": {
      const email = text(flags, "email")
      const role = text(flags, "role")
      const adminName = text(flags, "name")
      if (email === undefined || role === undefined) {
        out.error("admin create needs --email <email> and --role owner|admin|developer|viewer")
        return 1
      }
      return adminCreate(
        { ...meta, email, role, ...(adminName === undefined ? {} : { name: adminName }) },
        out,
      )
    }
    case "admin reset-totp":
      return adminResetTotp({ ...meta, admin: args[0] ?? "", yes: flags.has("yes") }, out)
    default:
      return migrate({ ...meta, status: flags.has("status") }, out)
  }
}

async function runDev(
  flags: Map<string, string | true>,
  env: Readonly<Record<string, string | undefined>>,
  out: Output,
  cwd: string,
  signal: AbortSignal,
): Promise<number> {
  const serverPort = port(text(flags, "port"), "port", out)
  const mongoPort = port(text(flags, "mongo-port"), "mongo-port", out)
  if (serverPort === false || mongoPort === false) return 1
  let devEnv = env
  if (flags.has("with-mongo")) {
    const configured = env["MONGODB_URI"]
    const database =
      text(flags, "database") ??
      env["CANOPY_DB"] ??
      (configured === undefined ? "" : databaseOf(configured))
    try {
      const uri = await startLocalMongo({
        projectDir: cwd,
        port: mongoPort ?? 27017,
        database: database === "" ? "app" : database,
        image: text(flags, "mongo-image") ?? env["CANOPY_MONGO_IMAGE"] ?? DEFAULT_MONGO_IMAGE,
        log: (line) => out.log(line),
      })
      devEnv = { ...env, MONGODB_URI: uri }
      out.log(`MongoDB is ready at ${uri}`)
    } catch (error: unknown) {
      out.error(`--with-mongo: ${messageOf(error)}`)
      return 1
    }
  }
  return dev(
    {
      cwd,
      env: devEnv,
      ...(text(flags, "config") === undefined ? {} : { configFile: text(flags, "config") ?? "" }),
      ...(serverPort === undefined ? {} : { port: serverPort }),
    },
    out,
    signal,
  )
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
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exitCode = 1
    },
  )
}
