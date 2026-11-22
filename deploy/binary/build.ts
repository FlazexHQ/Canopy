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
 * Policy and config files are loaded from disk at run time and import `canopy.js/policy` and
 * `canopy.js/config` (or `@canopy/policy` and `@canopy/config`). A generated entry hands those imports the
 * copies embedded in the executable, so a
 * policy folder needs no `node_modules` and its definitions are the ones the engine checks against. The
 * entry also loads `reflect-metadata` first: Bun's bundler runs a CommonJS side effect import after the
 * ES modules next to it, so tsyringe (used by the passkey dependencies) would otherwise find no polyfill
 * and stop the executable at startup.
 * When the Node-API addon of `@canopy/native` is built for a target (`bun --filter @canopy/native build:native`,
 * with `--target` for another platform), the entry of that target imports it by its literal path, which is
 * what makes `bun build --compile` embed it, and registers it where the loader looks first, so the `native`
 * engine works without `node_modules`. `--require-native` fails a target whose addon is not built.
 * `--gateway` copies the built gateway beside the executables when available. `--require-gateway`
 * requires it. Gateway builds for multiple targets use separate folders so each gateway keeps its runtime name.
 * Writes `SHA256SUMS` next to the executables.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  NATIVE_TARGETS,
  type NativeTarget,
  hostTarget as nativeHostTarget,
} from "../../packages/native/src/targets.ts"

interface Program {
  readonly name: string
  readonly entry: string
  readonly packages: readonly string[]
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/**
 * The names application code uses for the embedded packages: policy and config files import them from
 * `canopy.js`, the TypeScript library, which carries the same definitions.
 */
const PUBLIC_NAMES: Readonly<Record<string, readonly string[]>> = {
  "@canopy/config": ["canopy.js/config"],
  "@canopy/policy": ["canopy.js/policy"],
  "@canopy/policy/testing": ["canopy.js/policy/testing"],
}
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
/** The Bun target name of a platform with a prebuilt addon, as `--target=bun-<name>` takes it. */
function bunTarget(target: NativeTarget): string {
  const os = target.os === "win32" ? "windows" : target.os
  return `${os}-${target.cpu}${target.libc === "musl" ? "-musl" : ""}`
}

const PLATFORMS: Readonly<Record<string, NativeTarget>> = Object.fromEntries(
  NATIVE_TARGETS.map((target) => [bunTarget(target), target]),
)
const TARGETS = Object.keys(PLATFORMS)
const NATIVE = join(ROOT, "packages/native")

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage: bun deploy/binary/build.ts [--target <os-arch>]... [--all] [--only cli|server] [--out <dir>] [--require-native] [--gateway|--require-gateway]\nTargets: ${TARGETS.join(", ")}\n`,
  )
  process.exit(1)
}

function parse(argv: readonly string[]) {
  const targets: string[] = []
  const only: string[] = []
  let out = "dist/binaries"
  let requireNative = false
  let includeGateway = false
  let requireGateway = false
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
    else if (arg === "--gateway") includeGateway = true
    else if (arg === "--require-gateway") requireGateway = true
    else usage(`Unknown option ${arg}`)
  }
  return {
    targets: targets.length === 0 ? [undefined] : [...new Set(targets)],
    programs: only.length === 0 ? Object.keys(PROGRAMS) : [...new Set(only)],
    out: resolve(ROOT, out),
    requireNative,
    includeGateway: includeGateway || requireGateway,
    requireGateway,
  }
}

/** The Bun target of this machine, in the names of {@link TARGETS}. */
function hostTarget(): string {
  const host = nativeHostTarget()
  return host === undefined ? `${process.platform}-${process.arch}` : bunTarget(host)
}

/** The built addon of `@canopy/native` for a Bun target, when there is one. */
function addonFor(target: string): string | undefined {
  const suffix = PLATFORMS[target]?.suffix
  const file = suffix === undefined ? undefined : join(NATIVE, `canopy-native.${suffix}.node`)
  return file !== undefined && existsSync(file) ? file : undefined
}

function gatewayFor(target: string, exe: string): string | undefined {
  const triple = PLATFORMS[target]?.triple
  const cargo = resolve(ROOT, process.env["CARGO_TARGET_DIR"] ?? "target")
  const name = `canopy-gateway${exe}`
  if (triple !== undefined) {
    const file = join(cargo, triple, "release", name)
    if (existsSync(file)) return file
  }
  const host = join(cargo, "release", name)
  return target === hostTarget() && existsSync(host) ? host : undefined
}

function checksum(out: string, file: string): string {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex")
  return `${hash}  ${relative(out, file).replaceAll("\\", "/")}`
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
  const modules = program.packages.flatMap((name, index) =>
    [name, ...(PUBLIC_NAMES[name] ?? [])].map(
      (specifier) =>
        `    build.module("${specifier}", () => ({ exports: p${index}, loader: "object" }))`,
    ),
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
  const { targets, programs, out, requireNative, includeGateway, requireGateway } = parse(
    process.argv.slice(2),
  )
  mkdirSync(out, { recursive: true })
  const sums: string[] = []
  const outputs = targets.map((target) => {
    const platform = target ?? hostTarget()
    const windows =
      target === undefined ? process.platform === "win32" : target.startsWith("windows")
    const exe = windows ? ".exe" : ""
    const gateway = includeGateway ? gatewayFor(platform, exe) : undefined
    if (gateway === undefined && requireGateway) {
      const triple = PLATFORMS[platform]?.triple
      const flag = triple === undefined || platform === hostTarget() ? "" : ` --target ${triple}`
      usage(
        `No canopy-gateway executable is built for ${platform}. Run cargo build --release -p canopy-gateway${flag}`,
      )
    }
    const dir = includeGateway && targets.length > 1 ? join(out, platform) : out
    mkdirSync(dir, { recursive: true })
    return { target, platform, exe, gateway, dir }
  })
  for (const key of programs) {
    const program = PROGRAMS[key]
    if (program === undefined) continue
    const entryDir = dirname(join(ROOT, program.entry))
    const generated = join(entryDir, `.${program.name}.compile.ts`)
    try {
      for (const { target, platform, exe, dir } of outputs) {
        const addon = addonFor(platform)
        if (addon === undefined && requireNative) {
          usage(`No @canopy/native addon is built for ${platform}`)
        }
        writeFileSync(generated, shim(program, entryDir, addon))
        const suffix = target === undefined ? "" : `-${target}`
        const file = join(dir, `${program.name}${suffix}${exe}`)
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
        sums.push(checksum(out, file))
        const megabytes = (statSync(file).size / 1024 / 1024).toFixed(1)
        const engine = addon === undefined ? "without the native engine" : "with the native engine"
        process.stdout.write(`${relative(process.cwd(), file)}  ${megabytes} MB, ${engine}\n`)
      }
    } finally {
      rmSync(generated, { force: true })
    }
  }
  for (const { gateway, dir } of outputs) {
    if (gateway === undefined) continue
    const file = join(dir, basename(gateway))
    copyFileSync(gateway, file)
    sums.push(checksum(out, file))
  }
  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`)
}

main()
