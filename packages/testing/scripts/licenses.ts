/**
 * Checks the licenses of everything the published packages install: their dependencies, optional
 * dependencies and peer dependencies, then the dependencies and optional dependencies of those, through
 * node_modules (peers of third party packages are the app's choice and are not followed). Each must be
 * MIT, Apache 2.0, a BSD license or ISC (an SPDX `OR` expression passes when one side does), or be listed
 * in `EXCEPTIONS` with the reason it was accepted. The platform packages of `@canopy/native` are packed at
 * release time and are not workspace members, so the dependencies of its WebAssembly package (`WASM_TARGET`)
 * are resolved from `packages/native` and checked the same way. Run from the repository root after
 * `bun install`:
 *
 *   bun packages/testing/scripts/licenses.ts
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { WASM_TARGET } from "../../native/src/targets.ts"

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
])

/** Packages accepted outside the allowed set, with the maintainer's reason. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  "fractional-indexing":
    "CC0-1.0, a public domain dedication; a dependency of @tanstack/db, the peer of @canopy/tanstack-db",
}

interface Manifest {
  readonly name?: string
  readonly version?: string
  readonly private?: boolean
  readonly license?: unknown
  readonly licenses?: unknown
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest
}

/** The SPDX expression of a manifest, from `license` or the old `licenses` array. */
function licenseOf(manifest: Manifest): string | undefined {
  const { license, licenses } = manifest
  if (typeof license === "string") return license
  if (license !== null && typeof license === "object" && "type" in license)
    return String((license as { type: unknown }).type)
  if (Array.isArray(licenses))
    return licenses
      .map((entry: unknown) =>
        entry !== null && typeof entry === "object" && "type" in entry
          ? String((entry as { type: unknown }).type)
          : String(entry),
      )
      .join(" OR ")
  return undefined
}

/** Whether an SPDX expression is within the allowed set. */
function allowed(expression: string): boolean {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1")
  const alternatives = text.split(/\s+OR\s+/i)
  if (alternatives.length > 1) return alternatives.some(allowed)
  const required = text.split(/\s+AND\s+/i)
  if (required.length > 1) return required.every(allowed)
  return ALLOWED.has(text.replace(/[()]/g, "").trim())
}

/** The folder of package `name` as Node would find it from `from`, following symlinks. */
function locate(from: string, name: string): string | undefined {
  let dir = from
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name)
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function main(): void {
  const root = resolve(process.argv[2] ?? ".")
  const packagesDir = join(root, "packages")
  const published = readdirSync(packagesDir)
    .map((entry) => join(packagesDir, entry))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .filter((dir) => readManifest(dir).private !== true)

  const seen = new Map<string, { license: string | undefined; via: string }>()
  const missing: string[] = []
  const queue: { dir: string; via: string; own: boolean }[] = published.map((dir) => ({
    dir: realpathSync(dir),
    via: readManifest(dir).name ?? dir,
    own: true,
  }))
  const visit = (
    from: string,
    via: string,
    names: Iterable<string>,
    required: Set<string>,
  ): void => {
    for (const name of names) {
      const dir = locate(from, name)
      if (dir === undefined) {
        if (required.has(name)) missing.push(`${name} (from ${via})`)
        continue
      }
      const found = readManifest(dir)
      if (name.startsWith("@canopy/")) {
        if (!seen.has(dir)) {
          seen.set(dir, { license: "workspace", via })
          queue.push({ dir, via: name, own: true })
        }
        continue
      }
      const id = `${found.name ?? name}@${found.version ?? "?"}`
      if (seen.has(id)) continue
      seen.set(id, { license: licenseOf(found), via })
      queue.push({ dir, via: id, own: false })
    }
  }
  const native = join(packagesDir, "native")
  const wasm = `${readManifest(native).name ?? "native"}-${WASM_TARGET.suffix}`
  visit(realpathSync(native), wasm, WASM_TARGET.dependencies, new Set(WASM_TARGET.dependencies))
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    const manifest = readManifest(next.dir)
    const names = {
      ...(next.own ? manifest.peerDependencies : {}),
      ...manifest.optionalDependencies,
      ...manifest.dependencies,
    }
    visit(next.dir, next.via, Object.keys(names), new Set(Object.keys(manifest.dependencies ?? {})))
  }

  const refused = [...seen]
    .filter(([, entry]) => entry.license !== "workspace")
    .filter(([id]) => EXCEPTIONS[id.slice(0, id.lastIndexOf("@"))] === undefined)
    .filter(([, entry]) => entry.license === undefined || !allowed(entry.license))
  const checked = [...seen.values()].filter((entry) => entry.license !== "workspace").length
  for (const name of missing) process.stderr.write(`not installed: ${name}\n`)
  for (const [id, entry] of refused)
    process.stderr.write(`${id}: ${entry.license ?? "no license"} (needed by ${entry.via})\n`)
  if (refused.length > 0 || missing.length > 0) {
    process.stderr.write(
      `\n${refused.length} of ${checked} packages have a license outside MIT, Apache 2.0, BSD and ISC.\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${checked} packages installed by the published packages, all allowed.\n`)
}

if (import.meta.main ?? process.argv[1]?.endsWith("licenses.ts")) main()
