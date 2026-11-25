import { match } from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { hostTarget } from "../../native/src/targets.ts"
import { gatewayPackage, packagedGateway } from "../src/gateway-package.ts"

/**
 * Installs this machine's platform tarball from `pack-canopyd.ts` with npm and checks help for both
 * binaries and the CLI version. Runs on Node.js 24 or newer, including on Alpine Linux:
 *
 *   node packages/realtime/scripts/smoke-canopyd.ts [packs folder]
 */
interface Packed {
  readonly name: string
  readonly file: string
}

const folder = resolve(process.argv[2] ?? fileURLToPath(new URL("../packs", import.meta.url)))
const packs = JSON.parse(readFileSync(join(folder, "packs.json"), "utf8")) as Packed[]
const target = hostTarget()
if (target === undefined)
  throw new Error(`No prebuilt canopyd for ${process.platform} ${process.arch}`)
const name = gatewayPackage(target)
const packed = packs.find((entry) => entry.name === name)
if (packed === undefined) throw new Error(`${folder} has no ${name}`)

function run(binary: string, flag: string): string {
  const result = spawnSync(binary, [flag], { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(
      `${binary} ${flag} exited with ${String(result.status ?? result.error)}\n${result.stderr}`,
    )
  return result.stdout + result.stderr
}

const scratch = mkdtempSync(join(tmpdir(), "canopyd-smoke-"))
try {
  const manifest = join(scratch, "package.json")
  writeFileSync(manifest, '{"private":true}\n')
  const npm = process.platform === "win32" ? process.execPath : "npm"
  const npmArgs =
    process.platform === "win32"
      ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
      : []
  const install = spawnSync(
    npm,
    [
      ...npmArgs,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--cache",
      join(scratch, "npm-cache"),
      join(folder, packed.file),
    ],
    { cwd: scratch, stdio: "inherit" },
  )
  if (install.error !== undefined) throw install.error
  if (install.status !== 0) throw new Error(`npm install failed with ${String(install.status)}`)
  const binary = packagedGateway(target, scratch)
  if (binary === undefined) throw new Error(`${name} does not resolve from ${scratch}`)
  const cli = createRequire(manifest).resolve(`${name}/canopy`)
  if (process.platform !== "win32") chmodSync(cli, 0o755)
  match(run(binary, "--help"), /Usage: canopyd\b/)
  match(run(cli, "--version").trim(), /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/)
  match(run(cli, "--help"), /Usage: canopy\s/)
  process.stdout.write(`${name} passed canopy --version, canopy --help and canopyd --help\n`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
