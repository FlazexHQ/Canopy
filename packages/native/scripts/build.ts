import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Builds the Rust port into this package: the addon of the host (`canopy-native.<target>.node`) and, unless
 * `--native-only` is given, the WebAssembly fallback (`canopy-native.wasm32-wasi.wasm`), which the loader
 * finds next to `wasi.cjs`. `--target <triple>` builds the addon for another target instead of the host.
 * `--pack` also packs the npm packages a release publishes into `packs/`: one per built native target (`os`,
 * `cpu` and `libc` set so package managers install only the matching one), the WebAssembly package and the
 * root package whose `optionalDependencies` name them. Run with Bun: `bun scripts/build.ts [options]`.
 */
const root = fileURLToPath(new URL("..", import.meta.url))
const args = process.argv.slice(2)
const pack = args.includes("--pack")
const nativeOnly = args.includes("--native-only")
const targetIndex = args.indexOf("--target")
const requested = targetIndex === -1 ? undefined : args[targetIndex + 1]

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
  {
    suffix: "linux-x64-gnu",
    triple: "x86_64-unknown-linux-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  },
  {
    suffix: "linux-x64-musl",
    triple: "x86_64-unknown-linux-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
  },
  {
    suffix: "linux-arm64-gnu",
    triple: "aarch64-unknown-linux-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  },
  {
    suffix: "linux-arm64-musl",
    triple: "aarch64-unknown-linux-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
  },
]

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

const report = process.report?.getReport() as
  | { header?: { glibcVersionRuntime?: string } }
  | undefined
const hostLibc =
  process.platform === "linux"
    ? report?.header?.glibcVersionRuntime
      ? "glibc"
      : "musl"
    : undefined
const target =
  requested === undefined
    ? TARGETS.find(
        (t) => t.os === process.platform && t.cpu === process.arch && t.libc === hostLibc,
      )
    : TARGETS.find((t) => t.triple === requested)
if (target === undefined) {
  throw new Error(`no native target for ${requested ?? `${process.platform} ${process.arch}`}`)
}

napiBuild(["--target", target.triple])
if (!nativeOnly) napiBuild(["--target", "wasm32-wasip1-threads"])

if (pack) {
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  > & {
    name: string
    version: string
    license: string
    devDependencies: Record<string, string>
    napi: { binaryName: string }
  }
  const catalog = (
    JSON.parse(readFileSync(join(root, "..", "..", "package.json"), "utf8")) as {
      workspaces: { catalog: Record<string, string> }
    }
  ).workspaces.catalog
  const packs = join(root, "packs")
  const staging = join(packs, "staging")
  rmSync(packs, { recursive: true, force: true })
  const stage = (
    name: string,
    manifest: Record<string, unknown>,
    files: readonly string[],
  ): void => {
    const folder = join(staging, name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, "package.json"),
      `${JSON.stringify({ version: source.version, license: source.license, ...manifest }, null, 2)}\n`,
    )
    for (const file of files) copyFileSync(join(root, file), join(folder, file))
    writeFileSync(
      join(folder, "README.md"),
      `# ${String(manifest["name"])}\n\n${String(manifest["description"])}\n`,
    )
    run(process.execPath, ["pm", "pack", "--destination", packs, "--quiet", "--cwd", folder])
  }
  const binary = source.napi.binaryName
  const file = `${binary}.${target.suffix}.node`
  stage(
    target.suffix,
    {
      name: `${source.name}-${target.suffix}`,
      description: `${source.name} for ${target.triple}`,
      os: [target.os],
      cpu: [target.cpu],
      ...(target.libc === undefined ? {} : { libc: [target.libc] }),
      main: file,
      files: [file],
    },
    [file],
  )
  const optional: Record<string, string> = { [`${source.name}-${target.suffix}`]: source.version }
  if (!nativeOnly) {
    const wasm = `${binary}.wasm32-wasi.wasm`
    optional[`${source.name}-wasm32-wasi`] = source.version
    stage(
      "wasm32-wasi",
      {
        name: `${source.name}-wasm32-wasi`,
        description: `${source.name} as WebAssembly (wasm32-wasip1-threads), the fallback on every platform`,
        main: "wasi.cjs",
        files: ["wasi.cjs", wasm],
        dependencies: Object.fromEntries(
          ["@napi-rs/wasm-runtime", "@emnapi/core", "@emnapi/runtime"].map((name) => [
            name,
            catalog[name],
          ]),
        ),
      },
      ["wasi.cjs", wasm],
    )
  }
  process.stdout.write(`packed ${Object.keys(optional).join(", ")} into ${packs}\n`)
}
