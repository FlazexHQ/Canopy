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
 * policy folder needs no `node_modules` and its definitions are the ones the engine checks against. The
 * entry also loads `reflect-metadata` first: Bun's bundler runs a CommonJS side effect import after the
 * ES modules next to it, so tsyringe (used by the passkey dependencies) would otherwise find no polyfill
 * and stop the executable at startup.
 * When the Node-API addon of `@canopy/native` is built for a target (`bun --filter @canopy/native build:native`,
 * with `--target` for another platform), the entry of that target imports it by its literal path, which is
 * what makes `bun build --compile` embed it, and registers it where the loader looks first, so the `native`
 * engine works without `node_modules`. `--require-native` fails a target whose addon is not built.
 * Writes `SHA256SUMS` next to the executables.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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
/** Each Bun target and the platform suffix of the `@canopy/native` addon built for it. */
const ADDONS: Readonly<Record<string, string>> = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64-musl": "linux-x64-musl",
  "linux-arm64-musl": "linux-arm64-musl",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "windows-x64": "win32-x64-msvc",
  "windows-arm64": "win32-arm64-msvc",
}
const TARGETS = Object.keys(ADDONS)
const NATIVE = join(ROOT, "packages/native")

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage: bun deploy/binary/build.ts [--target <os-arch>]... [--all] [--only cli|server] [--out <dir>] [--require-native]\nTargets: ${TARGETS.join(", ")}\n`,
  )
  process.exit(1)
}

function parse(argv: readonly string[]) {
  const targets: string[] = []
  const only: string[] = []
  let out = "dist/binaries"
  let requireNative = false
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
    else if (arg === "--require-native") requireNative = true
    else usage(`Unknown option ${arg}`)
  }
  return {
    targets: targets.length === 0 ? [undefined] : [...new Set(targets)],
    programs: only.length === 0 ? Object.keys(PROGRAMS) : [...new Set(only)],
    out: resolve(ROOT, out),
    requireNative,
  }
}

/** The Bun target of this machine, in the names of {@link TARGETS}. */
function hostTarget(): string {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined
  const os = process.platform === "win32" ? "windows" : process.platform
  const musl = process.platform === "linux" && report?.header?.glibcVersionRuntime === undefined
  return `${os}-${process.arch}${musl ? "-musl" : ""}`
}

/** The built addon of `@canopy/native` for a Bun target, when there is one. */
function addonFor(target: string): string | undefined {
  const suffix = ADDONS[target]
  const file = suffix === undefined ? undefined : join(NATIVE, `canopy-native.${suffix}.node`)
  return file !== undefined && existsSync(file) ? file : undefined
}

function shim(program: Program, entryDir: string, addon: string | undefined): string {
  const imports = [
    `import "reflect-metadata"`,
    ...program.packages.map((name, index) => `import * as p${index} from "${name}"`),
    ...(addon === undefined
      ? []
      : [
          `import binding from ${JSON.stringify(addon.replaceAll("\\", "/"))}`,
          `;(globalThis as Record<symbol, unknown>)[Symbol.for("canopy.native.binding")] = binding`,
        ]),
  ]
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
  const version = (
    JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as { version: string }
  ).version
  const { targets, programs, out, requireNative } = parse(process.argv.slice(2))
  mkdirSync(out, { recursive: true })
  const sums: string[] = []
  for (const key of programs) {
    const program = PROGRAMS[key]
    if (program === undefined) continue
    const entryDir = dirname(join(ROOT, program.entry))
    const generated = join(entryDir, `.${program.name}.compile.ts`)
    try {
      for (const target of targets) {
        const addon = addonFor(target ?? hostTarget())
        if (addon === undefined && requireNative) {
          usage(`No @canopy/native addon is built for ${target ?? hostTarget()}`)
        }
        writeFileSync(generated, shim(program, entryDir, addon))
        const suffix = target === undefined ? "" : `-${target}`
        const windows =
          target === undefined ? process.platform === "win32" : target.startsWith("windows")
        const exe = windows ? ".exe" : ""
        const file = join(out, `${program.name}${suffix}${exe}`)
        const args = [
          "build",
          "--compile",
          "--minify",
          "--sourcemap",
          "--conditions=@canopy/source",
          `--define=process.env.CANOPY_BUILD_VERSION=${JSON.stringify(version)}`,
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
        const engine = addon === undefined ? "without the native engine" : "with the native engine"
        process.stdout.write(`${relative(process.cwd(), file)}  ${megabytes} MB, ${engine}\n`)
      }
    } finally {
      rmSync(generated, { force: true })
    }
  }
  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`)
}

main()
