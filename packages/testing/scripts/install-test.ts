/**
 * Install test: packs every published package, installs the tarballs into a scratch project with each
 * package manager, and imports every entry point of every `exports` map (and checks the declaration files
 * and `bin` targets exist), then compiles a TypeScript consumer that registers a schema against the installed
 * declarations with both `bundler` and `nodenext` module resolution. It fails when an `exports` map or a
 * `files` list points at something that is not in the tarball, when a dependency of a package is missing from
 * its `package.json`, or when the installed declarations stop typing the consumer.
 *
 *   bun packages/testing/scripts/install-test.ts [--managers bun,npm,pnpm,yarn] [--canopyd-packs <dir>] [--build] [--keep]
 *
 * The packages must be built (`bun run build`); `--build` runs that first. Tarballs come from `bun pm pack`,
 * which turns `workspace:` and `catalog:` ranges into real versions. A package manager that is not on the
 * PATH runs through `bun x` instead, so the script needs nothing installed globally. The packages depend on
 * each other with exact versions that are not published, so the test serves the tarballs from a registry on
 * localhost and points the `@canopy` scope of each package manager at it (`.npmrc`, or `.yarnrc.yml` for
 * Yarn); every other package comes from the default registry. canopy.js, the TypeScript library the server
 * packages depend on, lives in its own repository next to this one (`../Canopy.js`, or `CANOPY_JS_DIR`): it is
 * packed from there and pinned to that tarball with the override field of each package manager, since it is
 * not on npm yet. Imports run under Node. The package managers
 * run concurrently, each in its own folder with its own cache; every progress line starts with the name of the
 * manager, and a failure is printed at the end with the whole output of the step that failed.
 *
 * A package with prebuilt Node-API addons (a `napi` field) is installed from what its `build:native --pack`
 * or `build:native --assemble` wrote to its `packs/` folder: the root package, whose `optionalDependencies`
 * name the addon of this platform, possibly the addons of other platforms, and the WebAssembly fallback,
 * reaches them through the optional dependency path of each package manager. The test checks that exactly the
 * addon of this platform and the WebAssembly package are installed (the others are skipped by their `os`,
 * `cpu` and `libc` fields) and that the addon loads, then removes it and checks the package falls back to
 * WebAssembly.
 *
 * With `--canopyd-packs`, installs the assembled realtime launcher and checks that only the host's
 * optional executable package is installed, then resolves and runs both executables in every layout.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readTarball } from "../../native/scripts/verify.ts"
import { hostTarget, WASM_TARGET } from "../../native/src/targets.ts"
import { gatewayExecutable, gatewayPackage } from "../../realtime/src/gateway-package.ts"

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
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  napi?: unknown
}

/** A tarball `build:native --pack` wrote, as `packs/packs.json` lists it. */
interface Packed {
  readonly name: string
  readonly file: string
}

/** A package with prebuilt addons, the name of its addon package for this platform and all its platform packages. */
interface Addon {
  readonly name: string
  readonly native: string
  readonly wasm: string
  readonly platform: readonly string[]
}

interface Tarballs {
  /** The tarball of each published package, by name. */
  readonly files: Map<string, string>
  /** The absolute path of the canopy.js tarball. */
  readonly library: string
  /** The tarballs only reached as optional dependencies, by name. */
  readonly optional: Map<string, string>
  readonly addons: Addon[]
  readonly gateway?: GatewayRelease
}

interface GatewayRelease {
  readonly host: string
  readonly platforms: readonly string[]
}

interface Workspace {
  readonly dir: string
  readonly json: PackageJson
}

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage: install-test.ts [--managers bun,npm,pnpm,yarn] [--canopyd-packs <dir>] [--build] [--keep]\n`,
  )
  process.exit(2)
}

function parse(argv: readonly string[]): {
  managers: Manager[]
  build: boolean
  keep: boolean
  canopydPacks: string | undefined
} {
  let managers: Manager[] = [...ALL]
  let build = false
  let keep = false
  let canopydPacks: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--build") build = true
    else if (flag === "--keep") keep = true
    else if (flag === "--canopyd-packs") {
      index += 1
      canopydPacks = resolve(argv[index] ?? usage("--canopyd-packs needs a directory"))
    } else if (flag === "--managers") {
      index += 1
      const value = argv[index] ?? usage("--managers needs a value")
      managers = value.split(",").map((name) => {
        if (!ALL.includes(name as Manager)) usage(`Unknown package manager ${name}`)
        return name as Manager
      })
    } else usage(`Unexpected argument ${flag ?? ""}`)
  }
  return { managers, build, keep, canopydPacks }
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
  const [file, argv] = shim ? ["cmd.exe", ["/d", "/c", program, ...args]] : [program, args]
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

/** A program and the arguments that come before those of the package manager it runs. */
interface Command {
  readonly program: string
  readonly prefix: readonly string[]
}

/** How to run a package manager; Yarn 1 (preinstalled on CI images) is replaced by the current Yarn. */
async function managerCommand(manager: Manager): Promise<Command> {
  if (manager === "bun") return { program: bunPath(), prefix: [] }
  const installed = find(manager)
  const classic =
    manager === "yarn" &&
    installed !== undefined &&
    (await run(installed, ["--version"], root)).output.trim().startsWith("1.")
  if (installed !== undefined && !classic) return { program: installed, prefix: [] }
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
const addons = ${JSON.stringify(addons)}
const decides = (engine) =>
  engine.compileFilter({ a: { $gt: 1 } }).matches({ a: 2 }) && !engine.compileFilter({ a: 1 }).matches({ a: 2 })
for (const { name, native, wasm, platform } of addons) {
  const own = createRequire(require.resolve(name + "/package.json"))
  const installed = platform.filter((other) => {
    try {
      own.resolve(other + "/package.json")
      return true
    } catch {
      return false
    }
  })
  for (const other of installed)
    if (other !== native && other !== wasm) failures.push(other + " is installed on a platform it does not match")
  for (const wanted of [native, wasm])
    if (!installed.includes(wanted)) failures.push(wanted + " is not installed")
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
const addons = ${JSON.stringify(addons.map(({ name, native }) => ({ name, native })))}
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

async function pack(
  packages: readonly Workspace[],
  into: string,
  canopydPacks: string | undefined,
): Promise<Tarballs> {
  await mkdir(into, { recursive: true })
  const files = new Map<string, string>()
  const optional = new Map<string, string>()
  const addons: Addon[] = []
  let gateway: GatewayRelease | undefined
  for (const { dir, json } of packages) {
    if (canopydPacks !== undefined && ["@canopy/realtime", "@canopy/cli"].includes(json.name)) {
      const list = JSON.parse(await readFile(join(canopydPacks, "packs.json"), "utf8")) as Packed[]
      const launcher = list.find(({ name }) => name === json.name)
      if (launcher === undefined) throw new Error(`${canopydPacks} has no assembled ${json.name}`)
      const manifest = readTarball(join(canopydPacks, launcher.file)).get("package/package.json")
      if (manifest === undefined) throw new Error(`${launcher.file} has no package.json`)
      const { version, optionalDependencies } = JSON.parse(manifest.toString("utf8")) as PackageJson
      const platforms = list
        .map(({ name }) => name)
        .filter((name) => name.startsWith("@canopy/canopyd-"))
      assert.deepEqual(
        optionalDependencies,
        Object.fromEntries(platforms.map((name) => [name, version])),
        "The launcher should name every packed platform as an optional dependency",
      )
      const target = hostTarget() ?? usage("No prebuilt canopyd target for this host")
      const host = gatewayPackage(target)
      if (!platforms.includes(host)) throw new Error(`${canopydPacks} has no ${host}`)
      await copyFile(join(canopydPacks, launcher.file), join(into, launcher.file))
      files.set(launcher.name, launcher.file)
      if (gateway === undefined) {
        for (const { name, file } of list) {
          const destination =
            name === "@canopy/studio-assets"
              ? files
              : platforms.includes(name)
                ? optional
                : undefined
          if (destination === undefined) continue
          await copyFile(join(canopydPacks, file), join(into, file))
          destination.set(name, file)
        }
        gateway = { host, platforms }
      }
      continue
    }
    if (json.napi !== undefined) {
      const [own, ...rest] = packed(dir, json.name)
      for (const { file } of [own, ...rest])
        await copyFile(join(dir, "packs", file), join(into, file))
      if (own !== undefined) files.set(own.name, own.file)
      for (const { name, file } of rest) optional.set(name, file)
      const host = hostTarget()
      const native = rest.find(({ name }) => name === `${json.name}-${host?.suffix ?? ""}`)
      const wasm = rest.find(({ name }) => name === `${json.name}-${WASM_TARGET.suffix}`)
      if (host === undefined || native === undefined)
        usage(`${json.name} was packed without the addon of this platform`)
      if (wasm === undefined) usage(`${json.name} was packed without its WebAssembly package`)
      addons.push({
        name: json.name,
        native: native.name,
        wasm: wasm.name,
        platform: rest.map(({ name }) => name),
      })
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
  return { files, optional, addons, library: await packLibrary(into), ...(gateway && { gateway }) }
}

/** Packs canopy.js from its checkout next to this repository. Its `dist` must be built. */
async function packLibrary(into: string): Promise<string> {
  const dir = resolve(process.env["CANOPY_JS_DIR"] ?? join(root, "..", "Canopy.js"))
  if (!existsSync(join(dir, "dist", "client", "index.js")))
    usage(`canopy.js is not built in ${dir} (run bun run build there, or set CANOPY_JS_DIR)`)
  const target = join(into, "raw", "canopy.js")
  await mkdir(target, { recursive: true })
  const result = await run(bunPath(), ["pm", "pack", "--destination", target], dir)
  const tarball = readdirSync(target).find((name) => name.endsWith(".tgz"))
  if (result.code !== 0 || tarball === undefined)
    throw new Error(`Packing canopy.js failed:\n${result.output}`)
  const file = join(into, "canopy.js.tgz")
  await copyFile(join(target, tarball), file)
  return file
}

function peers(packages: readonly Workspace[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { json } of packages)
    for (const [name, range] of Object.entries(json.peerDependencies ?? {}))
      if (!name.startsWith("@canopy/") && out[name] === undefined) out[name] = range
  return out
}

/** The scope every published package is under, served by the local registry. */
const SCOPE = "canopy"

/** A local npm registry serving the packed tarballs of the scope. */
interface Registry {
  readonly url: string
  close(): Promise<void>
}

interface Served {
  readonly manifest: { readonly name: string; readonly version: string }
  readonly file: string
  readonly integrity: string
  readonly shasum: string
}

/**
 * Serves each tarball the way a registry publishes it: a document per package name with the manifest packed in
 * the tarball, so package managers see `os`, `cpu` and `libc` before they download anything, exactly as they
 * would from npm. Only the scope is pointed at it; every other package comes from the default registry.
 */
async function serve(dir: string, tarballs: Iterable<[string, string]>): Promise<Registry> {
  const documents = new Map<string, Served>()
  const files = new Map<string, Buffer>()
  for (const [name, file] of tarballs) {
    const bytes = await readFile(join(dir, file))
    const json = readTarball(join(dir, file)).get("package/package.json")
    if (json === undefined) throw new Error(`${file} has no package.json`)
    const manifest = JSON.parse(json.toString("utf8")) as Served["manifest"]
    if (manifest.name !== name) throw new Error(`${file} holds ${manifest.name}, not ${name}`)
    files.set(file, bytes)
    documents.set(name, {
      manifest,
      file,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
    })
  }
  let url = ""
  const published = new Date().toISOString()
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname)
    const tarball = path.startsWith("/-/") ? files.get(path.slice(3)) : undefined
    const entry = documents.get(path.slice(1))
    if (tarball !== undefined) {
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.end(tarball)
    } else if (entry !== undefined) {
      const { manifest } = entry
      const dist = {
        tarball: `${url}-/${entry.file}`,
        integrity: entry.integrity,
        shasum: entry.shasum,
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(
        JSON.stringify({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          time: { [manifest.version]: published },
          versions: { [manifest.version]: { ...manifest, dist } },
        }),
      )
    } else {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not found" }))
    }
  })
  await new Promise<void>((listening, failed) => {
    server.once("error", failed)
    server.listen(0, "127.0.0.1", listening)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("The registry has no port")
  url = `http://127.0.0.1:${address.port}/`
  return {
    url,
    close: () =>
      new Promise((closed) => {
        server.closeAllConnections()
        server.close(() => closed())
      }),
  }
}

/**
 * A TypeScript consumer of the packed declarations: it declares collections with `canopy.js/schema`,
 * registers the schema with the client and reads through `canopy.js/rest`. The `@ts-expect-error` lines
 * fail the compile when the registered types stop reaching the installed packages.
 */
const CONSUMER = `import { createClient, type Doc, type Id, type ObjectId } from "canopy.js"
import { createRestClient } from "canopy.js/rest"
import { collection, defineSchema, t } from "canopy.js/schema"

export const schema = defineSchema(
  collection("todos", { title: t.string(), done: t.bool().default(false) }),
  collection("notes", { _id: t.string(), body: t.string() }),
)

declare module "canopy.js" {
  interface Register {
    schema: typeof schema
  }
}

export type Todo = Doc<"todos">

export function consume(): Promise<unknown> {
  const client = createClient({ url: "http://localhost:3000", publishableKey: "pk", schema })
  const id: Id<"todos"> = client.from("todos").insert({ title: "Ship" }).id
  const objectId: ObjectId = id
  void objectId
  // @ts-expect-error notes take caller supplied string ids
  void client.from("notes").insert({ body: "No id" })
  // @ts-expect-error the schema option is required once a schema is registered
  void createClient({ url: "http://localhost:3000", publishableKey: "pk" })
  const rest = createRestClient({ url: "http://localhost:3000", publishableKey: "pk", schema })
  return rest
    .from("todos")
    .find({ done: false })
    .fields({ title: 1 })
    .page()
    .then((page) => {
      const title: string | undefined = page.data[0]?.title
      // @ts-expect-error the projection omits done
      void page.data[0]?.done
      return title
    })
}
`

/** The module resolution modes the consumer compiles under: bundlers, and Node.js with ESM. */
const RESOLUTIONS = {
  bundler: { module: "esnext", moduleResolution: "bundler" },
  nodenext: { module: "nodenext", moduleResolution: "nodenext" },
} as const

function consumerConfig(resolution: keyof typeof RESOLUTIONS): string {
  const config = {
    compilerOptions: {
      ...RESOLUTIONS[resolution],
      target: "es2023",
      lib: ["es2023", "dom", "dom.iterable"],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    },
    files: ["consumer.ts"],
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

async function scratchProject(
  manager: Manager,
  directory: string,
  registry: string,
  tarballs: Tarballs,
  packages: readonly Workspace[],
  pnp = false,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  const dependencies: Record<string, string> = { ...peers(packages) }
  for (const { json } of packages) dependencies[json.name] = json.version
  const library = `file:${tarballs.library.replaceAll("\\", "/")}`
  dependencies["canopy.js"] = library
  const manifest = {
    name: `canopy-install-test-${manager}`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
    overrides: { "canopy.js": library },
    pnpm: { overrides: { "canopy.js": library } },
    resolutions: { "canopy.js": library },
  }
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  if (manager === "yarn") {
    await writeFile(join(directory, "yarn.lock"), "")
    await writeFile(
      join(directory, ".yarnrc.yml"),
      [
        `nodeLinker: ${pnp ? "pnp" : "node-modules"}`,
        "enableImmutableInstalls: false",
        "enableScripts: false",
        "enableTelemetry: false",
        "npmPreapprovedPackages:",
        `  - "@${SCOPE}/*"`,
        "unsafeHttpWhitelist:",
        '  - "127.0.0.1"',
        "npmScopes:",
        `  ${SCOPE}:`,
        `    npmRegistryServer: "${registry.replace(/\/$/, "")}"`,
        "",
      ].join("\n"),
    )
  } else {
    await writeFile(join(directory, ".npmrc"), `@${SCOPE}:registry=${registry}\n`)
  }
}

/**
 * Caches kept for one run: every run publishes the same versions with new content on a new port, and Bun
 * and Yarn would reuse what they cached from an earlier run (Yarn its registry documents, whose tarball URLs
 * name a port nothing listens on any more).
 */
const CACHE: Readonly<Record<Manager, (scratch: string) => Record<string, string>>> = {
  bun: (scratch) => ({ BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache") }),
  npm: () => ({}),
  pnpm: () => ({}),
  yarn: (scratch) => ({ YARN_GLOBAL_FOLDER: join(scratch, "yarn-global") }),
}

const INSTALL: Readonly<Record<Manager, readonly string[]>> = {
  bun: ["install", "--ignore-scripts"],
  npm: ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"],
  pnpm: ["install", "--ignore-scripts", "--config.node-linker=isolated"],
  yarn: ["install"],
}

function gatewayScript({ host, platforms }: GatewayRelease, pnp: boolean): string {
  return `import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join } from "node:path"

delete process.env.CANOPYD_BIN
delete process.env.CANOPY_GATEWAY_BIN
delete process.env.CANOPY_BINARY
delete process.env.PATH
delete process.env.Path
const { findGatewayBinary } = await import("@canopy/realtime")
const require = createRequire(import.meta.url)
const launcher = createRequire(require.resolve("@canopy/realtime"))
const host = ${JSON.stringify(host)}
const installed = ${JSON.stringify(platforms)}.filter((name) => {
  try {
    launcher.resolve(name + "/package.json")
    return true
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error
    return false
  }
})
assert.deepEqual(installed, [host], "Only the host package should resolve from the launcher")

const diskRoot = ${JSON.stringify(pnp ? ".yarn/unplugged" : "node_modules")}
assert.ok(existsSync(diskRoot), diskRoot + " is missing")
const onDisk = new Set()
for (const entry of readdirSync(diskRoot, { recursive: true, withFileTypes: true })) {
  if (entry.name.startsWith("canopyd-") && basename(entry.parentPath) === "@canopy")
    onDisk.add("@canopy/" + entry.name)
}
assert.deepEqual([...onDisk], [host], "Only the host package should be installed on disk")

const binary = findGatewayBinary()
assert.ok(binary, "findGatewayBinary did not find canopyd")
const expected = join(dirname(launcher.resolve(host + "/package.json")), ${JSON.stringify(
    gatewayExecutable(process.platform),
  )})
assert.equal(realpathSync(binary), realpathSync(expected))
const result = spawnSync(binary, ["--help"], { encoding: "utf8" })
assert.ifError(result.error)
assert.equal(result.status, 0, result.stderr)
assert.match(result.stdout + result.stderr, /Usage: canopyd/)
const cliManifest = require.resolve("@canopy/cli/package.json")
const cli = join(dirname(cliManifest), JSON.parse(readFileSync(cliManifest, "utf8")).bin.canopy)
const studio = createRequire(cli).resolve("@canopy/studio-assets/index.html")
assert.ok(existsSync(studio), "The Studio entry point must be a physical file")
for (const [flag, pattern] of [
  ["--version", /^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.+-]+)?$/],
  ["--help", /Usage: canopy\\s/],
]) {
  const checked = spawnSync(process.execPath, [...process.execArgv, cli, flag], { encoding: "utf8" })
  assert.ifError(checked.error)
  assert.equal(checked.status, 0, checked.stderr)
  assert.match((checked.stdout + checked.stderr).trim(), pattern)
}
process.stdout.write(host + " resolves and runs through both launchers\\n")
`
}

/** The last line of a program's output, for the progress lines. */
const lastLine = (output: string): string => output.trim().split("\n").at(-1)?.trim() ?? ""

/**
 * Installs the tarballs with one package manager in its own folder, then imports every entry point and checks
 * the WebAssembly fallback. Every manager has its own folder and cache (see {@link CACHE}; npm and pnpm keep
 * their own default caches, which no other manager touches) and they share only the registry, which serves
 * read only documents, and the Bun cache of the `bun x` fallbacks, which the caller fills before the managers
 * start. So the managers run concurrently. Progress lines start with the manager's name.
 *
 * @returns the failure, naming the manager and holding the whole output of the step that failed, or
 *   `undefined` when every check passed. It never rejects, so one manager failing cannot stop the others.
 */
async function testManager(
  manager: Manager,
  command: Command,
  directory: string,
  scratch: string,
  registry: string,
  tarballs: Tarballs,
  packages: readonly Workspace[],
): Promise<string | undefined> {
  const started = Date.now()
  const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)} s`
  try {
    await scratchProject(manager, directory, registry, tarballs, packages)
    process.stdout.write(`${manager}: installing\n`)
    const env = { ...process.env, ...CACHE[manager](scratch) }
    const { program, prefix } = command
    const layout = manager === "bun" ? ["--linker", "hoisted"] : []
    const installed = await run(
      program,
      [...prefix, ...INSTALL[manager], ...layout],
      directory,
      env,
    )
    if (installed.code !== 0)
      return `${manager}: install failed after ${elapsed()}\n${installed.output.trim()}`
    process.stdout.write(`${manager}: installed in ${elapsed()}\n`)
    const node = find("node") ?? "node"
    if (tarballs.gateway !== undefined) {
      const extra = manager === "bun" ? "isolated" : manager === "yarn" ? "pnp" : undefined
      await writeFile(join(directory, "gateway.mjs"), gatewayScript(tarballs.gateway, false))
      const checked = await run(node, ["gateway.mjs"], directory)
      if (checked.code !== 0) return `${manager}: canopyd check failed\n${checked.output.trim()}`
      process.stdout.write(`${manager}: ${lastLine(checked.output)}\n`)
      if (extra !== undefined) {
        const alternate = join(scratch, extra)
        const launcher = packages.filter(({ json }) =>
          ["@canopy/realtime", "@canopy/cli"].includes(json.name),
        )
        await scratchProject(manager, alternate, registry, tarballs, launcher, extra === "pnp")
        const flags = manager === "bun" ? ["--linker", "isolated"] : []
        const installed = await run(
          program,
          [...prefix, ...INSTALL[manager], ...flags],
          alternate,
          env,
        )
        if (installed.code !== 0)
          return `${manager} ${extra}: install failed\n${installed.output.trim()}`
        await writeFile(
          join(alternate, "gateway.mjs"),
          gatewayScript(tarballs.gateway, extra === "pnp"),
        )
        const checked =
          extra === "pnp"
            ? await run(program, [...prefix, "node", "gateway.mjs"], alternate, env)
            : await run(node, ["gateway.mjs"], alternate)
        if (checked.code !== 0)
          return `${manager} ${extra}: canopyd check failed\n${checked.output.trim()}`
        process.stdout.write(`${manager} ${extra}: ${lastLine(checked.output)}\n`)
      }
    }
    await writeFile(join(directory, "check.mjs"), checkScript(packages, tarballs.addons))
    const checked = await run(node, ["check.mjs"], directory)
    process.stdout.write(`${manager}: ${lastLine(checked.output)}\n`)
    if (checked.code !== 0) return `${manager}: check failed\n${checked.output.trim()}`
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc")
    await writeFile(join(directory, "consumer.ts"), CONSUMER)
    for (const resolution of Object.keys(RESOLUTIONS) as (keyof typeof RESOLUTIONS)[]) {
      await writeFile(join(directory, `tsconfig.${resolution}.json`), consumerConfig(resolution))
      const compiled = await run(node, [tsc, "-p", `tsconfig.${resolution}.json`], directory)
      if (compiled.code !== 0)
        return `${manager}: the consumer does not compile with ${resolution} resolution\n${compiled.output.trim()}`
      process.stdout.write(`${manager}: the consumer compiles with ${resolution} resolution\n`)
    }
    if (tarballs.addons.length > 0) {
      await writeFile(join(directory, "fallback.mjs"), fallbackScript(tarballs.addons))
      const fallback = await run(node, ["fallback.mjs"], directory)
      process.stdout.write(`${manager}: ${lastLine(fallback.output)}\n`)
      if (fallback.code !== 0) return `${manager}: fallback failed\n${fallback.output.trim()}`
    }
    process.stdout.write(`${manager}: passed in ${elapsed()}\n`)
    return undefined
  } catch (error: unknown) {
    const reason = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return `${manager}: failed after ${elapsed()}\n${reason}`
  }
}

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

  const outside = packages.filter(({ json }) => !json.name.startsWith(`@${SCOPE}/`))
  if (outside.length > 0)
    usage(`Published outside @${SCOPE}: ${outside.map(({ json }) => json.name).join(", ")}`)

  const target = join(root, "target")
  await mkdir(target, { recursive: true })
  const scratch = await mkdtemp(join(target, "install-test-"))
  const failures: string[] = []
  let registry: Registry | undefined
  try {
    const tarballsDir = join(scratch, "tarballs")
    const tarballs = await pack(packages, tarballsDir, options.canopydPacks)
    process.stdout.write(
      `Packed ${tarballs.files.size} packages and ${tarballs.optional.size} optional ones\n`,
    )
    registry = await serve(tarballsDir, [...tarballs.files, ...tarballs.optional])
    // One at a time, so the `bun x` fallbacks fill the shared Bun cache before the managers run concurrently.
    await writeFile(join(scratch, "package.json"), '{"private":true}\n')
    const commands = new Map<Manager, Command>()
    for (const manager of options.managers) {
      const command = await managerCommand(manager)
      const ready = await run(command.program, [...command.prefix, "--version"], scratch)
      if (ready.code !== 0) failures.push(`${manager}: does not run\n${ready.output.trim()}`)
      else {
        process.stdout.write(`${manager}: version ${lastLine(ready.output)}\n`)
        commands.set(manager, command)
      }
    }
    const url = registry.url
    const results = await Promise.all(
      [...commands].map(([manager, command]) =>
        testManager(manager, command, join(scratch, manager), scratch, url, tarballs, packages),
      ),
    )
    for (const failure of results) if (failure !== undefined) failures.push(failure)
  } finally {
    await registry?.close()
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
