#!/usr/bin/env node
import { doctor, type Output, policiesLint, policiesTest } from "./commands.ts"
import { genTypes } from "./gen-types.ts"

const USAGE = `Usage: canopy <command> [options]

Commands:
  doctor                 Check MongoDB, change streams, policies and indexes
  policies lint          Validate and lint the policy directory
  policies test          Run policy tests in memory and, with --mongodb-uri, against MongoDB
  gen types              Generate the Database types from validators, config and sampled documents

Options:
  --dir <path>           Policy directory (default ./canopy/policies)
  --mongodb-uri <uri>    MongoDB connection string (default $MONGODB_URI)
  --database <name>      App database (default $CANOPY_DB or the URI path)
  --out <file>           gen types: the file to write (default src/canopy.gen.ts)
  --role <role>          gen types: make fields this role cannot read optional
  --check                gen types: fail when the file is out of date instead of writing it
  --infer-enums          gen types: turn low cardinality string fields into literal unions
  --sample <n>           gen types: documents sampled per collection (default 1000)
  --help                 Show this help`

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

/** Runs the CLI and returns the exit code. */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Output,
): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  if (flags.has("help") || positional.length === 0) {
    out.log(USAGE)
    return positional.length === 0 && !flags.has("help") ? 1 : 0
  }
  const dir = text(flags, "dir") ?? "./canopy/policies"
  const uri = text(flags, "mongodb-uri") ?? env["MONGODB_URI"]
  const [command, sub] = positional
  if (command === "policies" && sub === "lint") return policiesLint({ dir }, out)
  if (command === "policies" && sub === "test")
    return policiesTest({ dir, ...(uri === undefined ? {} : { mongodbUri: uri }) }, out)
  const name = command === "gen" && sub === "types" ? "gen types" : command
  if (command === "doctor" || name === "gen types") {
    if (uri === undefined) {
      out.error(`${name} needs --mongodb-uri or MONGODB_URI`)
      return 1
    }
    const database =
      text(flags, "database") ??
      env["CANOPY_DB"] ??
      new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.slice(1)
    if (database === "") {
      out.error(`${name} needs --database, CANOPY_DB or a database in the URI path`)
      return 1
    }
    if (command === "doctor")
      return doctor({ mongodbUri: uri, database, ...(flags.has("dir") ? { dir } : {}) }, out)
    const sample = text(flags, "sample")
    const role = text(flags, "role")
    if (sample !== undefined && !/^[1-9]\d*$/.test(sample)) {
      out.error("--sample needs a positive integer")
      return 1
    }
    return genTypes(
      {
        mongodbUri: uri,
        database,
        out: text(flags, "out") ?? "src/canopy.gen.ts",
        check: flags.has("check"),
        inferEnums: flags.has("infer-enums"),
        ...(flags.has("dir") ? { dir } : {}),
        ...(role === undefined ? {} : { role }),
        ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
      },
      out,
    )
  }
  out.error(`Unknown command: ${positional.join(" ")}\n\n${USAGE}`)
  return 1
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
