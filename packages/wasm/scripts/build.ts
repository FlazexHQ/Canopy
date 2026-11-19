import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Builds the WebAssembly port into `generated/`: compiles the `canopy-wasm` crate for
 * `wasm32-unknown-unknown`, then runs wasm-bindgen for the web target, which Cloudflare Workers, browsers,
 * Bun, Node and Deno all load.
 *
 *   bun scripts/build.ts
 *
 * The wasm-bindgen CLI must be the version of the `wasm-bindgen` crate in `Cargo.lock`. One on the PATH is
 * used when its version matches; otherwise the release archive of this platform is downloaded once into
 * `target/wasm-bindgen/`, checked against the SHA-256 recorded below, and used from there.
 */
const packageDir = fileURLToPath(new URL("..", import.meta.url))
const root = join(packageDir, "..", "..")
const generated = join(packageDir, "generated")
const TARGET = "wasm32-unknown-unknown"

/** SHA-256 of each wasm-bindgen release archive, by version and target. Update with `Cargo.lock`. */
const ARCHIVES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "0.2.130": {
    "x86_64-unknown-linux-musl": "9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f",
    "aarch64-unknown-linux-gnu": "cc8dd8e90aa9111758168d30c63a14b7f0276997d9d60d3e160a1fb5e7d3b919",
    "x86_64-apple-darwin": "eb209c115b7cb95832423c1aa3f4d06d6c53f63ef74fc4b6fb79ef0b2eea5f10",
    "aarch64-apple-darwin": "b90ddb9357f584b1af897d58ad77e4cce2b48fc17e2a967bc249a87f72809444",
    "x86_64-pc-windows-msvc": "844d23f1b56097549b936dd2e0d561fadebc1e8c9e985d5068b6b919654104ad",
  },
}

const HOSTS: Readonly<Record<string, string>> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
}

function run(command: string, args: readonly string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`)
  return result.stdout
}

function lockedVersion(crate: string): string {
  const lock = readFileSync(join(root, "Cargo.lock"), "utf8").replaceAll("\r\n", "\n")
  const match = new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`).exec(
    lock,
  )
  if (match?.[1] === undefined) throw new Error(`Cargo.lock does not list ${crate}`)
  return match[1]
}

function versionOf(command: string): string | undefined {
  try {
    return run(command, ["--version"]).trim()
  } catch {
    return undefined
  }
}

async function download(version: string): Promise<string> {
  const install = `cargo install wasm-bindgen-cli --version ${version} --locked`
  const host = HOSTS[`${process.platform}-${process.arch}`]
  const sha256 = host === undefined ? undefined : ARCHIVES[version]?.[host]
  if (host === undefined || sha256 === undefined) {
    throw new Error(`No recorded wasm-bindgen ${version} archive for this platform: ${install}`)
  }
  const name = `wasm-bindgen-${version}-${host}`
  const dir = join(root, "target", "wasm-bindgen")
  const binary = join(dir, name, process.platform === "win32" ? "wasm-bindgen.exe" : "wasm-bindgen")
  if (existsSync(binary)) return binary
  const url = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${name}.tar.gz`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}: ${install}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== sha256) throw new Error(`${url} has SHA-256 ${actual}, expected ${sha256}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.tar.gz`), archive)
  run("tar", ["-xzf", `${name}.tar.gz`], dir)
  return binary
}

async function main(): Promise<void> {
  const version = lockedVersion("wasm-bindgen")
  const bindgen =
    versionOf("wasm-bindgen") === `wasm-bindgen ${version}`
      ? "wasm-bindgen"
      : await download(version)
  run("rustup", ["target", "add", TARGET])
  run("cargo", ["build", "--release", "--locked", "--target", TARGET, "-p", "canopy-wasm"])
  rmSync(generated, { recursive: true, force: true })
  const input = join(root, "target", TARGET, "release", "canopy_wasm.wasm")
  run(bindgen, [
    input,
    "--target",
    "web",
    "--out-dir",
    generated,
    "--out-name",
    "canopy_wasm",
    "--no-typescript",
  ])
}

await main()
