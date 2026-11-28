import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  GLIBC_BASELINE,
  hostTarget,
  NATIVE_TARGETS,
  type NativeTarget,
  WASM_TARGET,
} from "../src/targets.ts"
import { type Expected, verifyNative, verifyRoot, verifyWasm } from "./verify.ts"

/**
 * Builds the Rust port into this package and packs the npm packages a release publishes. Run with Bun:
 *
 *   bun scripts/build.ts [--target <triple>]... [--cross] [--native-only] [--pack]
 *   bun scripts/build.ts --assemble <dir> [--partial]
 *
 * The first form builds the addon of each `--target` (the host when none is given) as
 * `canopy-native.<suffix>.node` and, unless `--native-only` is given, the WebAssembly fallback
 * (`canopy-native.wasm32-wasi.wasm`), which the loader finds next to `wasi.cjs`. `--cross` builds the Linux
 * targets through cargo-zigbuild (Zig on the PATH), the glibc ones against glibc 2.17, so one Linux host builds
 * all four. `--pack` then packs into `packs/` one package per built addon (`os`, `cpu` and `libc` set so package
 * managers install only the matching one), the WebAssembly package, and the root package whose
 * `optionalDependencies` name the packages packed with it, checks each tarball, and lists them in
 * `packs/packs.json`, the root package first.
 *
 * `--assemble` takes the `packs/` folders of several such runs, downloaded anywhere under `<dir>`, and packs
 * the release into `packs/`: the platform packages of every target and the WebAssembly package, each checked
 * (the glibc addons against the 2.17 baseline), and the root package whose `optionalDependencies` name all of
 * them at its version. It fails when one is missing, unless `--partial` allows a subset for local testing.
 */
const root = fileURLToPath(new URL("..", import.meta.url))
const packs = join(root, "packs")

interface Options {
  readonly triples: string[]
  readonly cross: boolean
  readonly nativeOnly: boolean
  readonly pack: boolean
  readonly assemble?: string
  readonly partial: boolean
}

function usage(message: string): never {
  throw new Error(
    `${message}\nUsage: build.ts [--target <triple>]... [--cross] [--native-only] [--pack]\n       build.ts --assemble <dir> [--partial]`,
  )
}

function parse(argv: readonly string[]): Options {
  const triples: string[] = []
  let cross = false
  let nativeOnly = false
  let pack = false
  let partial = false
  let assemble: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--cross") cross = true
    else if (flag === "--native-only") nativeOnly = true
    else if (flag === "--pack") pack = true
    else if (flag === "--partial") partial = true
    else if (flag === "--target") {
      index += 1
      triples.push(argv[index] ?? usage("--target needs a triple"))
    } else if (flag === "--assemble") {
      index += 1
      assemble = argv[index] ?? usage("--assemble needs a folder")
    } else usage(`Unexpected argument ${flag ?? ""}`)
  }
  if (assemble !== undefined && (triples.length > 0 || cross || nativeOnly || pack))
    usage("--assemble takes no build options")
  if (partial && assemble === undefined) usage("--partial needs --assemble")
  return {
    triples,
    cross,
    nativeOnly,
    pack,
    partial,
    ...(assemble === undefined ? {} : { assemble }),
  }
}

function run(command: string, commandArgs: readonly string[]): void {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${String(result.status)}`)
  }
}

const napi = join(root, "node_modules", "@napi-rs", "cli", "dist", "cli.js")
const napiBuild = (extra: readonly string[]): void =>
  run(process.execPath, [
    napi,
    "build",
    "--platform",
    "--release",
    "--no-js",
    "--no-dts-header",
    ...extra,
  ])

const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
  string,
  unknown
> & {
  name: string
  version: string
  license: string
  repository: { type: string; url: string; directory: string }
  napi: { binaryName: string }
}
const catalog = (
  JSON.parse(readFileSync(join(root, "..", "..", "package.json"), "utf8")) as {
    workspaces: { catalog: Record<string, string> }
  }
).workspaces.catalog
const expected: Expected = {
  root: source.name,
  version: source.version,
  binary: source.napi.binaryName,
}
const packageName = (suffix: string): string => `${source.name}-${suffix}`
const tarballName = (name: string): string =>
  `${name.replace("@", "").replace("/", "-")}-${source.version}.tgz`

/** A tarball in `packs/`, as `packs/packs.json` lists it. */
interface Packed {
  readonly name: string
  readonly file: string
}

function fail(problems: readonly string[]): void {
  if (problems.length > 0) throw new Error(`Packing failed:\n${problems.join("\n")}`)
}

function stage(name: string, manifest: Record<string, unknown>, files: readonly string[]): Packed {
  const folder = join(packs, "staging", name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, "package.json"),
    `${JSON.stringify({ name, version: source.version, license: source.license, repository: source.repository, ...manifest }, null, 2)}\n`,
  )
  for (const file of files) copyFileSync(join(root, file), join(folder, file))
  writeFileSync(join(folder, "README.md"), `# ${name}\n\n${String(manifest["description"])}\n`)
  run(process.execPath, ["pm", "pack", "--destination", packs, "--quiet", "--cwd", folder])
  return { name, file: tarballName(name) }
}

function packNative(target: NativeTarget, glibcBaseline: boolean): Packed {
  const file = `${source.napi.binaryName}.${target.suffix}.node`
  const packed = stage(
    packageName(target.suffix),
    {
      description: `${source.name} for ${target.triple}`,
      os: [target.os],
      cpu: [target.cpu],
      ...(target.libc === undefined ? {} : { libc: [target.libc] }),
      main: file,
      files: [file],
    },
    [file],
  )
  fail(verifyNative(join(packs, packed.file), target, expected, glibcBaseline))
  return packed
}

function packWasm(): Packed {
  const wasm = `${source.napi.binaryName}.${WASM_TARGET.suffix}.wasm`
  const packed = stage(
    packageName(WASM_TARGET.suffix),
    {
      description: `${source.name} as WebAssembly (${WASM_TARGET.triple}), the fallback on every platform`,
      main: "wasi.cjs",
      files: ["wasi.cjs", wasm],
      dependencies: Object.fromEntries(
        WASM_TARGET.dependencies.map((name) => [name, catalog[name]]),
      ),
    },
    ["wasi.cjs", wasm],
  )
  fail(verifyWasm(join(packs, packed.file), expected, catalog))
  return packed
}

/** Packs the root package with `optionalDependencies` naming `platform`, checks it and writes `packs.json`. */
function packRoot(platform: readonly Packed[]): void {
  rmSync(join(packs, "staging"), { recursive: true, force: true })
  run(process.execPath, ["run", "build"])
  const optional = Object.fromEntries(platform.map(({ name }) => [name, source.version]))
  const manifest = join(root, "package.json")
  const original = readFileSync(manifest, "utf8")
  try {
    writeFileSync(
      manifest,
      `${JSON.stringify({ ...source, optionalDependencies: optional }, null, 2)}\n`,
    )
    run(process.execPath, ["pm", "pack", "--destination", packs, "--quiet"])
  } finally {
    writeFileSync(manifest, original)
  }
  const own: Packed = { name: source.name, file: tarballName(source.name) }
  const all = [own, ...platform]
  const missing = all.filter(({ file }) => !existsSync(join(packs, file)))
  if (missing.length > 0)
    throw new Error(`bun pm pack wrote no ${missing.map(({ file }) => file).join(", ")}`)
  fail(verifyRoot(join(packs, own.file), expected, optional))
  writeFileSync(join(packs, "packs.json"), `${JSON.stringify(all, null, 2)}\n`)
  process.stdout.write(`packed ${all.map(({ name }) => name).join(", ")} into ${packs}\n`)
}

function build(options: Options): void {
  const host = hostTarget()
  const targets =
    options.triples.length === 0
      ? [host ?? usage(`No native target for ${process.platform} ${process.arch}`)]
      : options.triples.map(
          (triple) =>
            NATIVE_TARGETS.find((target) => target.triple === triple) ??
            usage(`No native target ${triple}`),
        )
  for (const target of targets) {
    const zig = options.cross && target.os === "linux"
    const triple =
      zig && target.libc === "glibc" ? `${target.triple}.${GLIBC_BASELINE}` : target.triple
    napiBuild(["--target", triple, ...(zig ? ["--cross-compile"] : [])])
  }
  if (!options.nativeOnly) napiBuild(["--target", WASM_TARGET.triple])
  if (!options.pack) return
  rmSync(packs, { recursive: true, force: true })
  const platform = targets.map((target) =>
    packNative(target, options.cross && target.os === "linux"),
  )
  if (!options.nativeOnly) platform.push(packWasm())
  packRoot(platform)
}

function assemble(folder: string, partial: boolean): void {
  const input = resolve(folder)
  const inside = relative(packs, input)
  if (!inside.startsWith("..") && !isAbsolute(inside))
    usage(`--assemble cannot read from ${packs}, which it replaces`)
  const found = new Map<string, string>()
  const lists = readdirSync(input, { recursive: true, encoding: "utf8" }).filter(
    (path) => basename(path) === "packs.json",
  )
  for (const list of lists) {
    const entries = JSON.parse(readFileSync(join(input, list), "utf8")) as Packed[]
    for (const { name, file } of entries) {
      if (name === source.name) continue
      if (basename(file) !== file || file !== tarballName(name))
        throw new Error(`${list} lists ${file} for ${name}, expected ${tarballName(name)}`)
      const path = join(input, dirname(list), file)
      const previous = found.get(name)
      if (previous !== undefined)
        throw new Error(`${name} is packed twice: ${previous} and ${path}`)
      found.set(name, path)
    }
  }
  const wanted = [...NATIVE_TARGETS.map(({ suffix }) => suffix), WASM_TARGET.suffix].map(
    packageName,
  )
  const unknown = [...found.keys()].filter((name) => !wanted.includes(name))
  if (unknown.length > 0) throw new Error(`Unknown packages in ${input}: ${unknown.join(", ")}`)
  const missing = wanted.filter((name) => !found.has(name))
  if (missing.length > 0 && !partial)
    throw new Error(`Missing from ${input}: ${missing.join(", ")} (--partial allows a subset)`)
  if (found.size === 0) throw new Error(`No packs.json under ${input}`)
  rmSync(packs, { recursive: true, force: true })
  mkdirSync(packs, { recursive: true })
  const platform: Packed[] = []
  const problems: string[] = []
  for (const name of wanted) {
    const path = found.get(name)
    if (path === undefined) continue
    const packed = { name, file: tarballName(name) }
    copyFileSync(path, join(packs, packed.file))
    const tarball = join(packs, packed.file)
    const target = NATIVE_TARGETS.find(({ suffix }) => packageName(suffix) === name)
    problems.push(
      ...(target === undefined
        ? verifyWasm(tarball, expected, catalog)
        : verifyNative(tarball, target, expected, true)),
    )
    platform.push(packed)
  }
  fail(problems)
  if (missing.length > 0) process.stdout.write(`partial release, without ${missing.join(", ")}\n`)
  packRoot(platform)
}

const options = parse(process.argv.slice(2))
if (options.assemble === undefined) build(options)
else assemble(options.assemble, options.partial)
