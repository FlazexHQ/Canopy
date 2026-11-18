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

function checkScript(packages: readonly Workspace[]): string {
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
process.stdout.write(entries.length + " entry points and " + bins.length + " bins checked\\n")
if (failures.length > 0) {
  process.stderr.write(failures.join("\\n") + "\\n")
  process.exit(1)
}
`
}

async function pack(packages: readonly Workspace[], into: string): Promise<Map<string, string>> {
  await mkdir(into, { recursive: true })
  const files = new Map<string, string>()
  for (const { dir, json } of packages) {
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
  return files
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
  tarballs: ReadonlyMap<string, string>,
  packages: readonly Workspace[],
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await mkdir(join(directory, "tarballs"))
  const dependencies: Record<string, string> = { ...peers(packages) }
  for (const [name, file] of tarballs) {
    await copyFile(join(tarballsDir, file), join(directory, "tarballs", file))
    dependencies[name] = `file:./tarballs/${file}`
  }
  const own = Object.fromEntries([...tarballs].map(([name]) => [name, dependencies[name]]))
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
  await writeFile(join(directory, "check.mjs"), checkScript(packages))
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
    process.stdout.write(`Packed ${tarballs.size} packages\n`)
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
      const checked = await run(find("node") ?? "node", ["check.mjs"], directory)
      process.stdout.write(`${manager}: ${checked.output.trim().split("\n").at(-1) ?? ""}\n`)
      if (checked.code !== 0) failures.push(`${manager}: ${checked.output.trim()}`)
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
