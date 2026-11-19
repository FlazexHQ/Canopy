#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import { suggest } from "@canopy/config"
import { ADMIN_COMMANDS } from "./admin-commands.ts"
import { isEnvironmentName } from "./credentials.ts"
import {
  appTarget,
  type CommandSpec,
  configure,
  type Env,
  type Flags,
  type Invocation,
  metaTarget,
} from "./invocation.ts"
import { DEFAULT_MONGO_IMAGE } from "./local-mongo.ts"
import { DEFAULT_MONGO_VERSION } from "./mongod-binary.ts"
import type { Output } from "./output.ts"
import { POLICY_COMMANDS } from "./policy-commands.ts"
import { PROJECT_COMMANDS } from "./project-commands.ts"

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
  pull                   Write an editable collection schema from MongoDB
  schema diff            Compare the schema file with MongoDB and exit 1 on drift
  schema push            Apply collection validators from the schema file (asks first)
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
                         pull: schema file to write (default: canopy.schema.ts, or canopy.schema.js with --js)
  --js                   pull: emit JavaScript
  --file <path>          schema diff, schema push: schema file (default: canopy.schema.ts, else canopy.schema.js)
  --collection <name>    pull: add one collection to the schema file
  --check                gen types: fail when the file is out of date instead of writing it
  --watch                gen types: regenerate when policies or collections change, until Ctrl+C
  --types                dev: regenerate the types file too (on by default once the file exists)
  --infer-enums          gen types, pull, schema diff: turn low cardinality string fields into literal unions
  --sample <n>           gen types, pull, schema diff: documents sampled per collection (default 1000)
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
                         pull: replace an edited schema file when pulling all collections
  --limit <n>            policies history: how many versions (default 50)
  --kind <kind>          keys create: publishable or secret
  --name <name>          keys create: a label for the key; admin create: the admin's name; admin tokens
                         create: the token's name
  --email <email>        admin create: the admin's email
  --role <role>          schema diff: report fields the role cannot read or write on insert
                         gen types: make fields this role cannot read optional; admin create, admin
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
                         admin tokens revoke, schema push: apply without asking
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
  "js",
  "infer-enums",
  "sources",
  "with-mongo",
  "mongo-binary",
  "watch",
  "types",
  "yes",
  "dry-run",
  "fail-on-drift",
  "force",
  "status",
  "all",
])

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  ...PROJECT_COMMANDS,
  ...POLICY_COMMANDS,
  ...ADMIN_COMMANDS,
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
