/**
 * Builds standalone executables of the `canopy` CLI and the `canopy-server` binary with
 * `bun build --compile`. Each executable embeds the Bun runtime and every workspace package, so it runs on
 * a machine without Bun, Node or `node_modules`. Run it from the repository root with Bun:
 *
 *   bun deploy/binary/build.ts                            the host platform
 *   bun deploy/binary/build.ts --target linux-x64 --target windows-x64
 *   bun deploy/binary/build.ts --all --out dist/binaries
 *   bun deploy/binary/build.ts --only server
 *
 * Policy and config files are loaded from disk at run time and import `@canopy/policy` and
 * `@canopy/config`. A generated entry hands those imports the copies embedded in the executable, so a
 * policy folder needs no `node_modules` and its definitions are the ones the engine checks against.
 * Writes `SHA256SUMS` next to the executables.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface Program {
  readonly name: string
  readonly entry: string
  readonly packages: readonly string[]
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PROGRAMS: Readonly<Record<string, Program>> = {
  cli: {
    name: "canopy",
    entry: "packages/cli/src/cli.ts",
    packages: ["@canopy/config", "@canopy/policy", "@canopy/policy/testing"],
  },
  server: {
    name: "canopy-server",
    entry: "packages/server/src/bin/canopy-server.ts",
    packages: ["@canopy/config", "@canopy/policy"],
  },
}
const TARGETS = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
]

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage: bun deploy/binary/build.ts [--target <os-arch>]... [--all] [--only cli|server] [--out <dir>]\nTargets: ${TARGETS.join(", ")}\n`,
  )
  process.exit(1)
}

function parse(argv: readonly string[]) {
  const targets: string[] = []
  const only: string[] = []
  let out = "dist/binaries"
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = (): string => {
      const next = argv[++index]
      if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`)
      return next
    }
    if (arg === "--all") targets.push(...TARGETS)
    else if (arg === "--target") {
      const target = value().replace(/^bun-/, "")
      if (!TARGETS.includes(target)) usage(`Unknown target ${target}`)
      targets.push(target)
    } else if (arg === "--only") {
      const program = value()
      if (PROGRAMS[program] === undefined) usage(`Unknown program ${program}`)
      only.push(program)
    } else if (arg === "--out") out = value()
    else usage(`Unknown option ${arg}`)
  }
  return {
    targets: targets.length === 0 ? [undefined] : [...new Set(targets)],
    programs: only.length === 0 ? Object.keys(PROGRAMS) : [...new Set(only)],
    out: resolve(ROOT, out),
  }
}

function shim(program: Program, entryDir: string): string {
  const imports = program.packages.map((name, index) => `import * as p${index} from "${name}"`)
  const modules = program.packages.map(
    (name, index) =>
      `    build.module("${name}", () => ({ exports: p${index}, loader: "object" }))`,
  )
  const entry = `./${relative(entryDir, join(ROOT, program.entry)).replaceAll("\\", "/")}`
  return [
    ...imports,
    "Bun.plugin({",
    `  name: "canopy-embedded-packages",`,
    "  setup(build) {",
    ...modules,
    "  },",
    "})",
    `await import("${entry}")`,
    "",
  ].join("\n")
}

function main(): void {
  const bun = (globalThis as { Bun?: { version: string } }).Bun
  if (bun === undefined) usage("Run this script with Bun")
  const pinned = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      packageManager?: string
    }
  ).packageManager?.replace(/^bun@/, "")
  if (pinned !== undefined && pinned !== bun.version)
    process.stderr.write(
      `warning: Bun ${bun.version} embeds itself, but the repository pins Bun ${pinned}\n`,
    )
  const { targets, programs, out } = parse(process.argv.slice(2))
  mkdirSync(out, { recursive: true })
  const sums: string[] = []
  for (const key of programs) {
    const program = PROGRAMS[key]
    if (program === undefined) continue
    const entryDir = dirname(join(ROOT, program.entry))
    const generated = join(entryDir, `.${program.name}.compile.ts`)
    writeFileSync(generated, shim(program, entryDir))
    try {
      for (const target of targets) {
        const suffix = target === undefined ? "" : `-${target}`
        const exe = target?.startsWith("windows") === true ? ".exe" : ""
        const file = join(out, `${program.name}${suffix}${exe}`)
        const args = [
          "build",
          "--compile",
          "--minify",
          "--sourcemap",
          "--conditions=@canopy/source",
          ...(target === undefined ? [] : [`--target=bun-${target}`]),
          generated,
          "--outfile",
          file,
        ]
        const result = spawnSync(process.execPath, args, { cwd: out, stdio: "inherit" })
        if (result.status !== 0) process.exit(result.status ?? 1)
        const hash = createHash("sha256").update(readFileSync(file)).digest("hex")
        sums.push(`${hash}  ${relative(out, file)}`)
        const megabytes = (statSync(file).size / 1024 / 1024).toFixed(1)
        process.stdout.write(`${relative(process.cwd(), file)}  ${megabytes} MB\n`)
      }
    } finally {
      rmSync(generated, { force: true })
    }
  }
  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`)
}

main()
