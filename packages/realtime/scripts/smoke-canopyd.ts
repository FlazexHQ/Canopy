import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readTarball } from "../../native/scripts/verify.ts"
import { hostTarget } from "../../native/src/targets.ts"
import { gatewayPackage, packagedGateway } from "../src/gateway-package.ts"

/**
 * Unpacks the `canopyd` platform package of this machine from the tarballs `pack-canopyd.ts` wrote into a
 * scratch `node_modules` (without permission bits, as a package manager may), finds it the way the CLI does
 * and runs `canopyd --help`. Runs on Node.js (24 or newer, which strips the types), so it also runs where Bun
 * does not, such as a plain Alpine container:
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

const scratch = mkdtempSync(join(tmpdir(), "canopyd-smoke-"))
try {
  const home = join(scratch, "node_modules", ...name.split("/"))
  for (const [path, body] of readTarball(join(folder, packed.file))) {
    if (!path.startsWith("package/")) continue
    const file = join(home, path.slice("package/".length))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  const binary = packagedGateway(target, scratch)
  if (binary === undefined) throw new Error(`${name} does not resolve from ${scratch}`)
  const result = spawnSync(binary, ["--help"], { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(
      `${binary} --help exited with ${String(result.status ?? result.error)}\n${result.stderr}`,
    )
  process.stdout.write(
    `${name} resolves and runs on ${process.platform} ${process.arch}${target.libc === undefined ? "" : ` (${target.libc})`}\n`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
