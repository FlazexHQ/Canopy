import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { readTarball } from "../../native/scripts/verify.ts"

/**
 * The native release workflow owns @canopy/native, its platform packages including the WASI fallback,
 * @canopy/realtime, @canopy/cli, @canopy/studio-assets and every @canopy/canopyd platform package. Changesets versions
 * the workspace packages.
 * Publish their assembled tarballs so the launchers include the platform optional dependencies.
 */

const registry = "https://registry.npmjs.org/"
const launchers = new Set(["@canopy/native", "@canopy/realtime", "@canopy/cli"])

function readManifest(file: string) {
  const json = readTarball(file).get("package/package.json")
  if (json === undefined) throw new Error(`${file} has no package/package.json`)
  const value: unknown = JSON.parse(json.toString("utf8"))
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`${file} has an invalid package manifest`)
  }
  const license =
    "license" in value && typeof value.license === "string" ? value.license.trim() : ""
  return { file, name: value.name, version: value.version, license }
}

async function isPublished(name: string, version: string): Promise<boolean> {
  const response = await fetch(
    `${registry}${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) },
  )
  if (response.status === 404) return false
  if (!response.ok)
    throw new Error(`Registry lookup for ${name}@${version} returned ${response.status}`)
  return true
}

function runNpm(args: readonly string[]): void {
  let command = "npm"
  let argv = [...args]
  if (process.platform === "win32") {
    const npmCli = (process.env["PATH"] ?? "")
      .split(delimiter)
      .map((folder) => join(folder, "node_modules", "npm", "bin", "npm-cli.js"))
      .find(existsSync)
    if (npmCli === undefined) throw new Error("Cannot find npm-cli.js on PATH")
    command = "node"
    argv = [resolve(npmCli), ...argv]
  }
  const result = spawnSync(command, argv, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`npm publish for ${args[1]} failed (${result.status ?? result.signal})`)
  }
}

/** Preflights every tarball before running npm in publish order. Publishing requires an explicit opt in. */
export async function publishTarballs(
  folders: readonly string[],
  publish: boolean,
  operations = { isPublished, runNpm, warn: console.warn },
): Promise<void> {
  const packages = folders.flatMap((folder) => {
    const files = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
      .map(({ name }) => resolve(folder, name))
      .sort()
    if (files.length === 0) throw new Error(`No tarballs in ${folder}`)
    return files.map(readManifest)
  })
  const unlicensed = packages.filter(({ license }) => license === "" || license === "UNLICENSED")
  if (unlicensed.length > 0) {
    const message = `Missing license or UNLICENSED: ${unlicensed.map(({ name }) => name).join(", ")}`
    if (publish) throw new Error(message)
    operations.warn(message)
  }

  const order = (name: string) =>
    name === "@canopy/studio-assets" ? 0 : launchers.has(name) ? 2 : 1
  packages.sort((a, b) => order(a.name) - order(b.name))
  for (const { file, name, version } of packages) {
    if (publish && (await operations.isPublished(name, version))) {
      process.stdout.write(`Skipping ${name}@${version}, already published\n`)
      continue
    }
    operations.runNpm([
      "publish",
      file,
      "--access",
      "public",
      "--registry",
      registry,
      "--ignore-scripts",
      ...(publish ? ["--provenance"] : ["--dry-run", "--offline", "--force"]),
    ])
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { publish: { type: "boolean", default: false } },
    allowPositionals: true,
  })
  if (positionals.length === 0) throw new Error("Pass the folders containing the release tarballs")
  await publishTarballs(positionals, values.publish)
}
