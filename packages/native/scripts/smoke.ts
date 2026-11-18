import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { hostTarget } from "../src/targets.ts"
import { readTarball } from "./verify.ts"

/**
 * Loads the addon of this platform from the tarballs `build.ts --pack` or `--assemble` wrote, without installing
 * anything, and checks it reports itself as native and decides filters. Runs on Node.js (24 or newer, which
 * strips the types), so it also runs where Bun does not, such as a plain Alpine container:
 *
 *   node packages/native/scripts/smoke.ts [packs folder]
 */
interface Packed {
  readonly name: string
  readonly file: string
}

interface Filter {
  matchesEjson(document: string): boolean
}

interface Addon {
  engine(): string
  readonly Filter: { fromEjson(text: string): Filter }
}

const folder = resolve(process.argv[2] ?? fileURLToPath(new URL("../packs", import.meta.url)))
const packs = JSON.parse(readFileSync(join(folder, "packs.json"), "utf8")) as Packed[]
const root = packs[0]
const target = hostTarget()
if (root === undefined || target === undefined)
  throw new Error(`No addon to load from ${folder} on ${process.platform} ${process.arch}`)
const name = `${root.name}-${target.suffix}`
const packed = packs.find((entry) => entry.name === name)
if (packed === undefined) throw new Error(`${folder} has no ${name}`)
const files = readTarball(join(folder, packed.file))
const manifest = JSON.parse(files.get("package/package.json")?.toString("utf8") ?? "{}") as {
  main?: string
}
const binary = manifest.main === undefined ? undefined : files.get(`package/${manifest.main}`)
if (manifest.main === undefined || binary === undefined)
  throw new Error(`${packed.file} has no addon`)

const scratch = mkdtempSync(join(tmpdir(), "canopy-smoke-"))
try {
  const file = join(scratch, manifest.main)
  writeFileSync(file, binary)
  const addon = createRequire(import.meta.url)(file) as Addon
  const failures: string[] = []
  if (addon.engine() !== "native") failures.push(`engine() is ${addon.engine()}, not native`)
  const filter = addon.Filter.fromEjson('{"total":{"$gte":100},"status":{"$in":["open","held"]}}')
  const cases: readonly [string, boolean][] = [
    ['{"total":120,"status":"open"}', true],
    ['{"total":{"$numberLong":"100"},"status":"held"}', true],
    ['{"total":99.5,"status":"open"}', false],
    ['{"total":120,"status":"closed"}', false],
    ['{"status":"open"}', false],
  ]
  for (const [document, expected] of cases)
    if (filter.matchesEjson(document) !== expected)
      failures.push(`${document} matched ${String(!expected)}, expected ${String(expected)}`)
  if (failures.length > 0) throw new Error(`${name}:\n${failures.join("\n")}`)
  process.stdout.write(
    `${name} loads on ${process.platform} ${process.arch} (Node.js ${process.versions.node}) and decides ${cases.length} documents\n`,
  )
} finally {
  // Windows keeps a loaded DLL locked until the process exits, so the copy stays in the temporary folder there.
  if (process.platform !== "win32") rmSync(scratch, { recursive: true, force: true })
}
