import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { isAbsolute, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const env = process.env
const rustc = env["CANOPY_WASM_RUSTC"]
const cargoHome = env["CANOPY_WASM_CARGO_HOME"]
if (rustc === undefined || cargoHome === undefined)
  throw new Error("Missing split Wasm build environment")

function sourcePath(base: string, manifest: string): string | undefined {
  const path = relative(base, manifest).split(sep).join("/")
  if (isAbsolute(path) || path === ".." || path.startsWith("../")) return undefined
  return path
}

const args = process.argv.slice(2)
const manifest = env["CARGO_MANIFEST_DIR"]
const homeSource = manifest === undefined ? undefined : sourcePath(cargoHome, manifest)
const cargoSource =
  homeSource?.startsWith("registry/src/") || homeSource?.startsWith("git/checkouts/")
    ? homeSource
    : undefined
const workspaceSource =
  manifest === undefined || cargoSource !== undefined ? undefined : sourcePath(root, manifest)
const target = args.indexOf("--target")
const metadata = args.findIndex(
  (arg, index) => args[index - 1] === "-C" && arg.startsWith("metadata="),
)
if (
  manifest !== undefined &&
  target >= 0 &&
  args[target + 1] === "wasm32-unknown-unknown" &&
  metadata >= 0
) {
  if (workspaceSource === undefined && cargoSource === undefined) {
    throw new Error(`Unknown Cargo source directory: ${manifest}`)
  }
  const source =
    workspaceSource === undefined ? `cargo/${cargoSource}` : `workspace/${workspaceSource}`
  const features = args.filter(
    (arg, index) => args[index - 1] === "--cfg" && arg.startsWith("feature="),
  )
  const identity = [source, env["CARGO_PKG_VERSION"], ...features.sort()]
  // Cargo incorporates native build script and proc macro metadata into target crate identities.
  args[metadata] = `metadata=${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
}

const wrappers = [
  env["CANOPY_WASM_RUSTC_WRAPPER"],
  workspaceSource === undefined ? undefined : env["CANOPY_WASM_RUSTC_WORKSPACE_WRAPPER"],
].filter((arg): arg is string => arg !== undefined && arg !== "")
const [executable, ...rustcArgs] = [...wrappers, rustc, ...args]
if (executable === undefined) throw new Error("Missing Rust compiler")
const compilerEnv = { ...env }
// The Bun subprocess does not forward Cargo's jobserver file descriptors.
delete compilerEnv["CARGO_MAKEFLAGS"]
const result = spawnSync(executable, rustcArgs, { env: compilerEnv, stdio: "inherit" })
if (result.error !== undefined) throw result.error
process.exit(result.status ?? 1)
