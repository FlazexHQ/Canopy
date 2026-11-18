/**
 * Install test: packs every published package, installs the tarballs into a scratch project with each
 * package manager, and imports every entry point of every `exports` map (and checks the declaration files
 * and `bin` targets exist). It fails when an `exports` map or a `files` list points at something that is
 * not in the tarball, or when a dependency of a package is missing from its `package.json`.
 *
 *   bun packages/testing/scripts/install-test.ts [--managers bun,npm,pnpm,yarn] [--build] [--keep]
 *
 * The packages must be built (`bun run build`); `--build` runs that first. Tarballs come from `bun pm pack`,
 * which turns `workspace:` and `catalog:` ranges into real versions. A package manager that is not on the
 * PATH runs through `bun x` instead, so the script needs nothing installed globally. The packages depend on
 * each other with exact versions that are not published, so the scratch project maps every `@canopy/*`
 * dependency to its tarball with the override field of each package manager. Imports run under Node.
 *
 * A package with prebuilt Node-API addons (a `napi` field) is installed from what its `build:native --pack`
 * wrote to its `packs/` folder: the root package, whose `optionalDependencies` name the addon of this platform
 * and the WebAssembly fallback, reaches them through the optional dependency path of each package manager.
 * The test checks the addon loads, then removes it and checks the package falls back to WebAssembly.
 */
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)))

type Manager = "bun" | "npm" | "pnpm" | "yarn"
const ALL: readonly Manager[] = ["bun", "npm", "pnpm", "yarn"]

/** What `bun x` runs for a package manager that is not installed. */
const FALLBACK: Readonly<Record<Exclude<Manager, "bun">, readonly string[]>> = {
  npm: ["npm@11"],
  pnpm: ["pnpm@10"],
  yarn: ["-p", "@yarnpkg/cli-dist@4", "yarn"],
}

interface PackageJson {
  name: string
  version: string
  private?: boolean
  exports?: Record<string, unknown>
  bin?: Record<string, string> | string
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  napi?: unknown
}

/** A tarball `build:native --pack` wrote, as `packs/packs.json` lists it. */
interface Packed {
  readonly name: string
  readonly file: string
}

/** A package with prebuilt addons and the name of its addon package for this platform. */
interface Addon {
  readonly name: string
  readonly native: string
}

interface Tarballs {
  /** The tarball of each published package, by name. */
  readonly files: Map<string, string>
  /** The tarballs only reached as optional dependencies, by name. */
  readonly optional: Map<string, string>
  readonly addons: Addon[]
}

interface Workspace {
  readonly dir: string
  readonly json: PackageJson
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage: install-test.ts [--managers bun,npm,pnpm,yarn] [--build] [--keep]\n`,
  )
  process.exit(2)
}

function parse(argv: readonly string[]): { managers: Manager[]; build: boolean; keep: boolean } {
  let managers: Manager[] = [...ALL]
  let build = false
  let keep = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--build") build = true
    else if (flag === "--keep") keep = true
    else if (flag === "--managers") {
      index += 1
      const value = argv[index] ?? usage("--managers needs a value")
      managers = value.split(",").map((name) => {
        if (!ALL.includes(name as Manager)) usage(`Unknown package manager ${name}`)
        return name as Manager
      })
    } else usage(`Unexpected argument ${flag ?? ""}`)
  }
  return { managers, build, keep }
}

function publishedPackages(): Workspace[] {
  const folder = join(root, "packages")
  const found: Workspace[] = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name, "package.json")
    if (!entry.isDirectory() || !existsSync(file)) continue
    const json = JSON.parse(readFileSync(file, "utf8")) as PackageJson
    if (json.private !== true) found.push({ dir: join(folder, entry.name), json })
  }
  return found.sort((a, b) => a.json.name.localeCompare(b.json.name))
}

/** Looks a program up on the PATH, with the extensions Windows adds. */
function find(program: string): string | undefined {
  const extensions =
    process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD").split(";") : [""]
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${program}${extension.toLowerCase()}`)
      if (dir !== "" && existsSync(candidate)) return candidate
    }
  }
  return undefined
}

interface Outcome {
  readonly code: number
  readonly output: string
}

/** Runs a program with an argument array; Windows command shims run through `cmd.exe`. */
function run(
  program: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Outcome> {
  const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(program)
  const [file, argv] = shim ? ["cmd.exe", ["/d", "/s", "/c", program, ...args]] : [program, args]
  return new Promise((done) => {
    const child = spawn(file, [...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    child.on("error", (error) => done({ code: 127, output: `${output}${error.message}` }))
    child.on("close", (code) => done({ code: code ?? 1, output }))
  })
}

const bunPath = (): string =>
  "Bun" in globalThis ? process.execPath : (find("bun") ?? usage("bun is not on the PATH"))

function managerCommand(manager: Manager): { program: string; prefix: readonly string[] } {
  if (manager === "bun") return { program: bunPath(), prefix: [] }
  const installed = find(manager)
  if (installed !== undefined) return { program: installed, prefix: [] }
  return { program: bunPath(), prefix: ["x", ...FALLBACK[manager]] }
}

/** The export targets of an `exports` map for the default (import) conditions, and its declaration files. */
function targets(value: unknown): { runtime: string[]; types: string[] } {
  const runtime: string[] = []
  const types: string[] = []
  const walk = (node: unknown, condition: string): void => {
    if (typeof node === "string") {
      if (condition === "types") types.push(node)
      else if (condition !== "@canopy/source") runtime.push(node)
      return
    }
    if (typeof node !== "object" || node === null) return
    for (const [key, child] of Object.entries(node))
      walk(child, key === "default" ? condition : key)
  }
  walk(value, "default")
  return { runtime, types }
}

function checkScript(packages: readonly Workspace[], addons: readonly Addon[]): string {
  const entries = packages.flatMap(({ json }) =>
    Object.entries(json.exports ?? {})
      .filter(([key]) => key !== "./package.json" && !key.includes("*"))
      .map(([key, value]) => ({
        specifier: key === "." ? json.name : `${json.name}${key.slice(1)}`,
        ...targets(value),
      })),
  )
  const bins = packages.flatMap(({ json }) =>
    Object.entries(typeof json.bin === "string" ? { [json.name]: json.bin } : (json.bin ?? {})).map(
      ([name, file]) => ({ package: json.name, name, file }),
    ),
  )
  return `import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
const require = createRequire(import.meta.url)
const entries = ${JSON.stringify(entries)}
const bins = ${JSON.stringify(bins)}
const failures = []
const folder = (name) => dirname(require.resolve(name + "/package.json"))
for (const entry of entries) {
  const base = folder(entry.specifier.split("/").slice(0, 2).join("/"))
  for (const file of [...entry.runtime, ...entry.types])
    if (!existsSync(join(base, file))) failures.push(entry.specifier + " lists " + file + ", which is not installed")
  if (entry.runtime.every((file) => /\\.(c|m)?js$/.test(file)))
    try {
      await import(entry.specifier)
    } catch (error) {
      failures.push("import " + entry.specifier + ": " + (error instanceof Error ? error.message.split("\\n")[0] : String(error)))
    }
}
for (const bin of bins) {
  const file = join(folder(bin.package), bin.file)
  if (!existsSync(file)) failures.push("bin " + bin.name + " points at " + bin.file + ", which is not installed")
  else if (!readFileSync(file, "utf8").startsWith("#!")) failures.push("bin " + bin.name + " has no shebang line")
}
const addons = ${JSON.stringify(addons.map((addon) => addon.name))}
const decides = (engine) =>
  engine.compileFilter({ a: { $gt: 1 } }).matches({ a: 2 }) && !engine.compileFilter({ a: 1 }).matches({ a: 2 })
for (const name of addons) {
  try {
    const { loadNativeEngine } = await import(name)
    const native = loadNativeEngine()
    const wasm = loadNativeEngine("wasm")
    if (native.kind !== "native") failures.push(name + " loaded " + native.kind + ", not its addon")
    if (wasm.kind !== "wasm") failures.push(name + " loaded " + wasm.kind + " when asked for WebAssembly")
    for (const engine of [native, wasm])
      if (!decides(engine)) failures.push(name + " on " + engine.kind + " decides a filter wrongly")
  } catch (error) {
    failures.push("load " + name + ": " + (error instanceof Error ? error.message.split("\\n")[0] : String(error)))
  }
}
process.stdout.write(entries.length + " entry points, " + bins.length + " bins and " + addons.length + " addons checked\\n")
if (failures.length > 0) {
  process.stderr.write(failures.join("\\n") + "\\n")
  process.exit(1)
}
`
}

/**
 * Removes the addon of this platform from each installed package with prebuilt addons, then checks the
 * package falls back to WebAssembly instead of failing. Runs in its own process, after `check.mjs` loaded
 * the addon.
 */
function fallbackScript(addons: readonly Addon[]): string {
  return `import { existsSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
const require = createRequire(import.meta.url)
const addons = ${JSON.stringify(addons)}
const failures = []
for (const addon of addons) {
  const own = createRequire(require.resolve(addon.name + "/package.json"))
  const folder = dirname(own.resolve(addon.native + "/package.json"))
  rmSync(folder, { recursive: true, force: true })
  if (existsSync(folder)) failures.push(addon.native + " is still installed in " + folder)
  try {
    const { loadNativeEngine } = await import(addon.name)
    const engine = loadNativeEngine()
    if (engine.kind !== "wasm") failures.push(addon.name + " loaded " + engine.kind + " without its addon")
    else if (!engine.compileFilter({ a: 1 }).matches({ a: 1 })) failures.push(addon.name + " on wasm decides a filter wrongly")
  } catch (error) {
    failures.push("fall back " + addon.name + ": " + (error instanceof Error ? error.message.split("\\n")[0] : String(error)))
  }
}
process.stdout.write(addons.length + " fallbacks to WebAssembly checked\\n")
if (failures.length > 0) {
  process.stderr.write(failures.join("\\n") + "\\n")
  process.exit(1)
}
`
}

/** The tarballs `build:native --pack` wrote for a package with prebuilt addons, its root package first. */
function packed(dir: string, name: string): Packed[] {
  const file = join(dir, "packs", "packs.json")
  if (!existsSync(file))
    usage(`${name} has no packed addons (run bun --filter ${name} build:native --pack)`)
  const list = JSON.parse(readFileSync(file, "utf8")) as Packed[]
  if (list[0]?.name !== name) usage(`${file} does not start with ${name}`)
  return list
}

async function pack(packages: readonly Workspace[], into: string): Promise<Tarballs> {
  await mkdir(into, { recursive: true })
  const files = new Map<string, string>()
  const optional = new Map<string, string>()
  const addons: Addon[] = []
  for (const { dir, json } of packages) {
    if (json.napi !== undefined) {
      const [own, ...rest] = packed(dir, json.name)
      for (const { file } of [own, ...rest])
        await copyFile(join(dir, "packs", file), join(into, file))
      if (own !== undefined) files.set(own.name, own.file)
      for (const { name, file } of rest) optional.set(name, file)
      const native = rest.find(({ name }) => !name.endsWith("-wasm32-wasi"))
      if (native === undefined) usage(`${json.name} was packed without the addon of this platform`)
      addons.push({ name: json.name, native: native.name })
      continue
    }
    const target = join(into, "raw", json.name.replace("/", "_"))
    await mkdir(target, { recursive: true })
    const result = await run(bunPath(), ["pm", "pack", "--destination", target], dir)
    const tarball = readdirSync(target).find((name) => name.endsWith(".tgz"))
    if (result.code !== 0 || tarball === undefined)
      throw new Error(`Packing ${json.name} failed:\n${result.output}`)
    const name = `${json.name.replace("@", "").replace("/", "-")}.tgz`
    await copyFile(join(target, tarball), join(into, name))
    files.set(json.name, name)
  }
  return { files, optional, addons }
}

function peers(packages: readonly Workspace[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { json } of packages)
    for (const [name, range] of Object.entries(json.peerDependencies ?? {}))
      if (!name.startsWith("@canopy/") && out[name] === undefined) out[name] = range
  return out
}

async function scratchProject(
  manager: Manager,
  directory: string,
  tarballs: Tarballs,
  packages: readonly Workspace[],
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await mkdir(join(directory, "tarballs"))
  const dependencies: Record<string, string> = { ...peers(packages) }
  const own: Record<string, string> = {}
  for (const [name, file] of [...tarballs.files, ...tarballs.optional]) {
    await copyFile(join(tarballsDir, file), join(directory, "tarballs", file))
    own[name] = `file:./tarballs/${file}`
    if (tarballs.files.has(name)) dependencies[name] = own[name]
  }
  const manifest: Record<string, unknown> = {
    name: `canopy-install-test-${manager}`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
    ...(manager === "npm" || manager === "bun" ? { overrides: own } : {}),
    ...(manager === "pnpm" ? { pnpm: { overrides: own } } : {}),
    ...(manager === "yarn" || manager === "bun" ? { resolutions: own } : {}),
  }
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  if (manager === "yarn")
    await writeFile(
      join(directory, ".yarnrc.yml"),
      "nodeLinker: node-modules\nenableImmutableInstalls: false\nenableTelemetry: false\n",
    )
  await writeFile(join(directory, "check.mjs"), checkScript(packages, tarballs.addons))
  await writeFile(join(directory, "fallback.mjs"), fallbackScript(tarballs.addons))
}

const INSTALL: Readonly<Record<Manager, readonly string[]>> = {
  bun: ["install", "--ignore-scripts"],
  npm: ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
  pnpm: ["install", "--ignore-scripts"],
  yarn: ["install"],
}

let tarballsDir = ""

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2))
  const packages = publishedPackages()
  if (options.build) {
    const built = await run(bunPath(), ["run", "build"], root)
    if (built.code !== 0) throw new Error(`The build failed:\n${built.output}`)
  }
  const missing = packages.flatMap(({ dir, json }) =>
    targets(json.exports)
      .runtime.filter((file) => file.startsWith("./dist/") && !existsSync(join(dir, file)))
      .map((file) => `${json.name}: ${file}`),
  )
  if (missing.length > 0)
    usage(`Not built (run bun run build or pass --build):\n${missing.join("\n")}`)

  const scratch = await mkdtemp(join(tmpdir(), "canopy-install-"))
  tarballsDir = join(scratch, "tarballs")
  const failures: string[] = []
  try {
    const tarballs = await pack(packages, tarballsDir)
    process.stdout.write(
      `Packed ${tarballs.files.size} packages and ${tarballs.optional.size} optional ones\n`,
    )
    for (const manager of options.managers) {
      const directory = join(scratch, manager)
      await scratchProject(manager, directory, tarballs, packages)
      const { program, prefix } = managerCommand(manager)
      process.stdout.write(`${manager}: installing\n`)
      const installed = await run(program, [...prefix, ...INSTALL[manager]], directory)
      if (installed.code !== 0) {
        failures.push(`${manager}: install failed\n${installed.output.trim()}`)
        continue
      }
      const node = find("node") ?? "node"
      const checked = await run(node, ["check.mjs"], directory)
      process.stdout.write(`${manager}: ${checked.output.trim().split("\n").at(-1) ?? ""}\n`)
      if (checked.code !== 0) {
        failures.push(`${manager}: ${checked.output.trim()}`)
        continue
      }
      if (tarballs.addons.length === 0) continue
      const fallback = await run(node, ["fallback.mjs"], directory)
      process.stdout.write(`${manager}: ${fallback.output.trim().split("\n").at(-1) ?? ""}\n`)
      if (fallback.code !== 0) failures.push(`${manager}: ${fallback.output.trim()}`)
    }
  } finally {
    if (options.keep) process.stdout.write(`Kept ${scratch}\n`)
    else await rm(scratch, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n\n")}\n`)
    process.exit(1)
  }
  process.stdout.write("Install test passed\n")
}

await main()
