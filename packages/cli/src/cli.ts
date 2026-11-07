#!/usr/bin/env node
import { ConfigError, formatConfig, type ResolvedConfig } from "@canopy/config"
import { type LoadedConfig, loadConfig } from "@canopy/config/load"
import { doctor, type Output, policiesLint, policiesTest } from "./commands.ts"
import { genTypes } from "./gen-types.ts"

const USAGE = `Usage: canopy <command> [options]

Commands:
  doctor                 Check MongoDB, change streams, policies and indexes
  policies lint          Validate and lint the policy directory
  policies test          Run policy tests in memory and, with --mongodb-uri, against MongoDB
  gen types              Generate the Database types from validators, config and sampled documents
  config print           Print the resolved config with secrets masked

Settings come from canopy.config.ts (or canopy/canopy.config.ts), found from the working directory, and
the CANOPY_* variables. Flags override both.

Options:
  --config <file>        The config file (default: discovered)
  --dir <path>           Policy directory (default: the config's policies.dir, else ./canopy/policies)
  --mongodb-uri <uri>    MongoDB connection string (default: the config, else $MONGODB_URI)
  --database <name>      App database (default: the config, else $CANOPY_DB or the URI path)
  --out <file>           gen types: the file to write (default: the config's types.out, else src/canopy.gen.ts)
  --role <role>          gen types: make fields this role cannot read optional
  --check                gen types: fail when the file is out of date instead of writing it
  --infer-enums          gen types: turn low cardinality string fields into literal unions
  --sample <n>           gen types: documents sampled per collection (default 1000)
  --sources              config print: show where each value came from
  --help                 Show this help`

const GLOBAL_FLAGS = ["help", "config", "dir", "mongodb-uri", "database"]
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  doctor: [],
  "policies lint": [],
  "policies test": [],
  "gen types": ["out", "role", "check", "infer-enums", "sample"],
  "config print": ["sources"],
}

/** Parses `--name value` flags. */
export function parseArgs(argv: readonly string[]): {
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
    else if (next !== undefined && !next.startsWith("--")) {
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

function closest(input: string, candidates: readonly string[]): string | undefined {
  return candidates.find(
    (candidate) =>
      candidate.startsWith(input.slice(0, 3)) && Math.abs(candidate.length - input.length) <= 2,
  )
}

/** Runs the CLI and returns the exit code. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Output,
  cwd: string = process.cwd(),
): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  if (flags.has("help") || positional.length === 0) {
    out.log(USAGE)
    return positional.length === 0 && !flags.has("help") ? 1 : 0
  }
  const name = positional.slice(0, 2).join(" ")
  const allowed = COMMAND_FLAGS[name]
  if (allowed === undefined) {
    out.error(`Unknown command: ${positional.join(" ")}\n\n${USAGE}`)
    return 1
  }
  for (const flag of flags.keys()) {
    if (GLOBAL_FLAGS.includes(flag) || allowed.includes(flag)) continue
    const near = closest(flag, [...GLOBAL_FLAGS, ...allowed])
    out.error(
      `Unknown option --${flag} for ${name}.${near === undefined ? "" : ` Did you mean --${near}?`}`,
    )
    return 1
  }
  const uriFlag = text(flags, "mongodb-uri")
  const command =
    name === "config print"
      ? "print"
      : name === "doctor"
        ? "doctor"
        : name === "gen types"
          ? "gen"
          : "policies"
  let loaded: LoadedConfig
  try {
    const file = text(flags, "config")
    loaded = await loadConfig({
      command: uriFlag !== undefined && command !== "print" ? "policies" : command,
      cwd,
      env,
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
  const dir =
    text(flags, "dir") ?? ("dir" in config.policies ? config.policies.dir : "./canopy/policies")
  const dirGiven = flags.has("dir") || "dir" in config.policies
  const uri = uriFlag ?? (config.mongodb.uri === "" ? undefined : config.mongodb.uri)
  if (name === "policies lint") return policiesLint({ dir }, out)
  if (name === "policies test")
    return policiesTest({ dir, ...(uriFlag === undefined ? {} : { mongodbUri: uriFlag }) }, out)
  if (uri === undefined) {
    out.error(`${name} needs --mongodb-uri, MONGODB_URI or mongodb.uri in the config file`)
    return 1
  }
  const database =
    text(flags, "database") ??
    (uriFlag === undefined
      ? config.mongodb.database
      : (env["CANOPY_DB"] ?? new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.slice(1)))
  if (database === "") {
    out.error(`${name} needs --database, CANOPY_DB or a database in the URI path`)
    return 1
  }
  if (name === "doctor")
    return doctor({ mongodbUri: uri, database, ...(dirGiven ? { dir } : {}) }, out)
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

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop() ?? "")
if (isMain) {
  const out: Output = {
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  }
  run(process.argv.slice(2), process.env, out).then(
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
