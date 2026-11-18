import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Builds the addon for the host and for `wasm32-wasip1-threads`, then packs the npm packages a release would
 * publish into `packs/`: one package per native target (`os`, `cpu` and `libc` set so package managers install
 * only the matching one), the WebAssembly package (installed everywhere, no `cpu` field) and the root package
 * whose `optionalDependencies` name them all. Run with Bun: `bun scripts/build.ts [--placeholders]`.
 *
 * `--placeholders` also packs empty packages for the native targets this host cannot build, so the install
 * test can check that each package manager skips the ones for other platforms. They are never published.
 */
const root = fileURLToPath(new URL("..", import.meta.url))
const packs = join(root, "packs")
const staging = join(packs, "staging")
const placeholders = process.argv.includes("--placeholders")
const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const scope = source.name
const version = source.version
const binary = source.napi.binaryName

interface Target {
  readonly suffix: string
  readonly triple: string
  readonly os: string
  readonly cpu: string
  readonly libc?: string
}

const TARGETS: readonly Target[] = [
  { suffix: "win32-x64-msvc", triple: "x86_64-pc-windows-msvc", os: "win32", cpu: "x64" },
  { suffix: "win32-arm64-msvc", triple: "aarch64-pc-windows-msvc", os: "win32", cpu: "arm64" },
  { suffix: "darwin-x64", triple: "x86_64-apple-darwin", os: "darwin", cpu: "x64" },
  { suffix: "darwin-arm64", triple: "aarch64-apple-darwin", os: "darwin", cpu: "arm64" },
  { suffix: "linux-x64-gnu", triple: "x86_64-unknown-linux-gnu", os: "linux", cpu: "x64", libc: "glibc" },
  { suffix: "linux-x64-musl", triple: "x86_64-unknown-linux-musl", os: "linux", cpu: "x64", libc: "musl" },
  { suffix: "linux-arm64-gnu", triple: "aarch64-unknown-linux-gnu", os: "linux", cpu: "arm64", libc: "glibc" },
  { suffix: "linux-arm64-musl", triple: "aarch64-unknown-linux-musl", os: "linux", cpu: "arm64", libc: "musl" },
]

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`)
}

const napi = join(root, "node_modules", "@napi-rs", "cli", "dist", "cli.js")
const napiBuild = (extra: readonly string[]) =>
  run(process.execPath, [napi, "build", "--platform", "--release", "--no-js", "--dts", "binding.d.ts", ...extra], root)

const glibc = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
const libc = process.platform === "linux" ? (glibc?.header?.glibcVersionRuntime ? "glibc" : "musl") : undefined
const host = TARGETS.find(
  (target) => target.os === process.platform && target.cpu === process.arch && target.libc === libc,
)
if (host === undefined) throw new Error(`no native target for ${process.platform} ${process.arch}`)

napiBuild([])
napiBuild(["--target", "wasm32-wasip1-threads"])

rmSync(packs, { recursive: true, force: true })

function stage(name: string, manifest: Record<string, unknown>, files: readonly string[]): void {
  const folder = join(staging, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, "package.json"),
    `${JSON.stringify({ version, license: source.license, ...manifest }, null, 2)}\n`,
  )
  for (const file of files) copyFileSync(join(root, file), join(folder, file))
  writeFileSync(join(folder, "README.md"), `# ${String(manifest["name"])}

${String(manifest["description"])}
`)
  run(process.execPath, ["pm", "pack", "--destination", packs, "--quiet"], folder)
}

const optional: Record<string, string> = {}
for (const target of TARGETS) {
  const built = target === host
  if (!built && !placeholders) continue
  const file = `${binary}.${target.suffix}.node`
  optional[`${scope}-${target.suffix}`] = version
  stage(
    target.suffix,
    {
      name: `${scope}-${target.suffix}`,
      description: built ? `${source.name} for ${target.triple}` : `Placeholder for ${target.triple}`,
      os: [target.os],
      cpu: [target.cpu],
      ...(target.libc === undefined ? {} : { libc: [target.libc] }),
      ...(built ? { main: file, files: [file] } : { files: ["README.md"] }),
    },
    built ? [file] : [],
  )
}

const wasm = `${binary}.wasm32-wasi.wasm`
optional[`${scope}-wasm32-wasi`] = version
stage(
  "wasm32-wasi",
  {
    name: `${scope}-wasm32-wasi`,
    description: `${source.name} as WebAssembly (wasm32-wasip1-threads), the fallback on every platform`,
    main: "wasi.cjs",
    files: ["wasi.cjs", wasm],
    dependencies: {
      "@napi-rs/wasm-runtime": source.devDependencies["@napi-rs/wasm-runtime"],
      "@emnapi/core": source.devDependencies["@emnapi/core"],
      "@emnapi/runtime": source.devDependencies["@emnapi/runtime"],
    },
  },
  ["wasi.cjs", wasm],
)

const { devDependencies: _dev, scripts: _scripts, napi: _napi, ...published } = source
stage("root", { ...published, optionalDependencies: optional }, ["index.js", "index.d.ts"])
process.stdout.write(`packed ${Object.keys(optional).length + 1} packages into ${packs}\n`)
