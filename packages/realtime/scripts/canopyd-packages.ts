import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FORMAT, linkProblems, machineOf, readTarball } from "../../native/scripts/verify.ts"
import type { NativeTarget } from "../../native/src/targets.ts"
import { gatewayExecutable, gatewayPackage } from "../src/gateway-package.ts"

/** The platform independent package containing the built Studio. */
export const STUDIO_PACKAGE = "@canopy/studio-assets"

const studioIndex = "./index.html"
const studioExports = { [studioIndex]: "./app/index.html" }
const studioNotices = "THIRD-PARTY-NOTICES.md"

function cliExecutable(os: NativeTarget["os"]): string {
  return os === "win32" ? "canopy.exe" : "canopy"
}

function platformExports(target: NativeTarget): Record<string, string> {
  const gateway = gatewayExecutable(target.os)
  return {
    "./package.json": "./package.json",
    "./canopy": `./${cliExecutable(target.os)}`,
    [`./${gateway}`]: `./${gateway}`,
  }
}

/** The version and license every `canopyd` platform package takes from `@canopy/realtime`. */
export interface Release {
  readonly version: string
  readonly license: string
  readonly repository: { type: string; url: string; directory: string }
}

/** The `package.json` of the platform package for `target`. */
export function platformManifest(target: NativeTarget, release: Release): Record<string, unknown> {
  return {
    name: gatewayPackage(target),
    version: release.version,
    license: release.license,
    repository: release.repository,
    description: `The Canopy CLI and data plane, prebuilt for ${target.triple}`,
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc === undefined ? {} : { libc: [target.libc] }),
    files: [gatewayExecutable(target.os), cliExecutable(target.os)],
    exports: platformExports(target),
    dependencies: { [STUDIO_PACKAGE]: release.version },
    preferUnplugged: true,
  }
}

function readme(target: NativeTarget): string {
  const platform = `${target.os} ${target.cpu}${target.libc === undefined ? "" : ` with ${target.libc}`}`
  return `# ${gatewayPackage(target)}

The \`canopy\` CLI and \`canopyd\` data plane, prebuilt for \`${target.triple}\`. Package managers install this
package only on ${platform}, as an optional dependency of \`@canopy/cli\` and \`@canopy/realtime\`. Resolve the \`./canopy\`
export to locate the CLI executable.
Resolve \`${STUDIO_PACKAGE}/index.html\` from this package and pass its parent directory as
\`CANOPY_STUDIO_DIR\` to serve Studio.
`
}

/**
 * Writes the platform package for `target` into `folder`, replacing what was there: its `package.json` (with
 * `os`, `cpu` and, on Linux, `libc`, so package managers install only the matching one), both executables,
 * and a README.
 */
export function stagePlatformPackage(
  target: NativeTarget,
  binaries: { readonly gateway: string; readonly cli: string },
  folder: string,
  release: Release,
): void {
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, "package.json"),
    `${JSON.stringify(platformManifest(target, release), null, 2)}\n`,
  )
  for (const [source, name] of [
    [binaries.gateway, gatewayExecutable(target.os)],
    [binaries.cli, cliExecutable(target.os)],
  ] as const) {
    const executable = join(folder, name)
    copyFileSync(source, executable)
    if (target.os !== "win32") chmodSync(executable, 0o755)
  }
  writeFileSync(join(folder, "README.md"), readme(target))
}

/** Stages the built Studio and its third party notices as a platform independent package. */
export function stageStudioPackage(build: string, folder: string, release: Release): void {
  const manifest = {
    name: STUDIO_PACKAGE,
    version: release.version,
    license: release.license,
    repository: { ...release.repository, directory: "apps/studio" },
    description: "The built Canopy Studio web app for the native release",
    files: ["app", studioNotices],
    exports: studioExports,
    preferUnplugged: true,
  }
  cpSync(build, join(folder, "app"), {
    recursive: true,
    filter: (source) => source !== join(build, studioNotices),
  })
  copyFileSync(join(build, studioNotices), join(folder, studioNotices))
  writeFileSync(join(folder, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The `optionalDependencies` that name the platform packages of `targets` at `version`. */
export function optionalDependencies(
  targets: readonly NativeTarget[],
  version: string,
): Record<string, string> {
  return Object.fromEntries(targets.map((target) => [gatewayPackage(target), version]))
}

/** The file `bun pm pack` and `npm pack` write for a package. */
export function tarballName(name: string, version: string): string {
  return `${name.replace("@", "").replace("/", "-")}-${version}.tgz`
}

/** Packs the package in `folder` into `destination` with Bun (the executable `bun`). */
export function pack(bun: string, folder: string, destination: string): void {
  const result = spawnSync(bun, ["pm", "pack", "--destination", destination, "--quiet"], {
    cwd: folder,
    stdio: "inherit",
  })
  if (result.status !== 0)
    throw new Error(`bun pm pack in ${folder} failed with ${String(result.status ?? result.error)}`)
}

interface Manifest {
  readonly bin?: unknown
  readonly preferUnplugged?: unknown
  readonly name?: unknown
  readonly version?: unknown
  readonly os?: unknown
  readonly cpu?: unknown
  readonly libc?: unknown
  readonly exports?: unknown
  readonly dependencies?: unknown
  readonly optionalDependencies?: unknown
}

function manifestOf(files: Map<string, Buffer>): Manifest | undefined {
  const json = files.get("package/package.json")
  return json === undefined ? undefined : (JSON.parse(json.toString("utf8")) as Manifest)
}

function expect(problems: string[], label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    problems.push(`${label} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`)
}

/**
 * Checks the tarball of the platform package for `target`: its name, version and `os`, `cpu` and `libc`
 * fields, its exports, and both executables' format, processor and execute bits outside Windows.
 * With `glibcBaseline`, a glibc build must need no glibc newer than the
 * baseline of the native addons, and a musl build must not reference glibc at all.
 */
export function verifyPlatformTarball(
  tarball: string,
  target: NativeTarget,
  release: Release,
  glibcBaseline: boolean,
): string[] {
  const modes = new Map<string, number>()
  const files = readTarball(tarball, modes)
  const manifest = manifestOf(files)
  if (manifest === undefined) return [`${tarball}: package.json is missing`]
  const problems: string[] = []
  expect(problems, "name", manifest.name, gatewayPackage(target))
  expect(problems, "version", manifest.version, release.version)
  expect(problems, "os", manifest.os, [target.os])
  expect(problems, "cpu", manifest.cpu, [target.cpu])
  expect(problems, "libc", manifest.libc, target.libc === undefined ? undefined : [target.libc])
  expect(problems, "preferUnplugged", manifest.preferUnplugged, true)
  expect(problems, "exports", manifest.exports, platformExports(target))
  expect(problems, "dependencies", manifest.dependencies, { [STUDIO_PACKAGE]: release.version })
  for (const file of [gatewayExecutable(target.os), cliExecutable(target.os)]) {
    const binary = files.get(`package/${file}`)
    if (binary === undefined) {
      problems.push(`${file} is missing`)
      continue
    }
    expect(problems, file, machineOf(binary, [2, 3]), {
      format: FORMAT[target.os],
      cpu: target.cpu,
    })
    if (target.os !== "win32" && ((modes.get(`package/${file}`) ?? 0) & 0o111) !== 0o111)
      problems.push(`${file} is not executable`)
    if (target.libc !== undefined && glibcBaseline)
      problems.push(...linkProblems(binary, file, target))
  }
  return problems.map((problem) => `${tarball}: ${problem}`)
}

/** Checks the Studio package export, built assets and third party notices. */
export function verifyStudioTarball(tarball: string, release: Release): string[] {
  const files = readTarball(tarball)
  const manifest = manifestOf(files)
  if (manifest === undefined) return [`${tarball}: package.json is missing`]
  const problems: string[] = []
  expect(problems, "name", manifest.name, STUDIO_PACKAGE)
  expect(problems, "version", manifest.version, release.version)
  expect(problems, "exports", manifest.exports, studioExports)
  for (const field of ["os", "cpu", "libc", "dependencies"] as const)
    expect(problems, field, manifest[field], undefined)
  for (const file of ["app/index.html", studioNotices])
    if (!files.get(`package/${file}`)?.length) problems.push(`${file} is missing or empty`)
  if (
    ![...files.keys()].some(
      (file) => file.startsWith("package/app/assets/") && file.endsWith(".js"),
    )
  )
    problems.push("Studio JavaScript is missing")
  return problems.map((problem) => `${tarball}: ${problem}`)
}

/**
 * Checks the tarball of `@canopy/realtime`: its name and version, built, and naming exactly `optional` as its
 * optional dependencies.
 */
export function verifyLauncherTarball(
  tarball: string,
  name: string,
  version: string,
  optional: Readonly<Record<string, string>>,
): string[] {
  const files = readTarball(tarball)
  const manifest = manifestOf(files)
  if (manifest === undefined) return [`${tarball}: package.json is missing`]
  const problems: string[] = []
  expect(problems, "name", manifest.name, name)
  expect(problems, "version", manifest.version, version)
  expect(problems, "optionalDependencies", manifest.optionalDependencies, optional)
  for (const file of ["dist/index.js", "dist/index.d.ts", "dist/gateway-package.js"])
    if (!files.has(`package/${file}`)) problems.push(`${file} is missing`)
  return problems.map((problem) => `${tarball}: ${problem}`)
}

/** Checks that the CLI tarball contains only the generated executable launcher and its metadata. */
export function verifyCliTarball(
  tarball: string,
  name: string,
  version: string,
  optional: Readonly<Record<string, string>>,
): string[] {
  const files = readTarball(tarball)
  const manifest = manifestOf(files)
  if (manifest === undefined) return [`${tarball}: package.json is missing`]
  const problems: string[] = []
  expect(problems, "name", manifest.name, name)
  expect(problems, "version", manifest.version, version)
  expect(problems, "dependencies", manifest.dependencies, undefined)
  expect(problems, "optionalDependencies", manifest.optionalDependencies, optional)
  expect(problems, "preferUnplugged", manifest.preferUnplugged, true)
  expect(problems, "bin", manifest.bin, { canopy: "./dist/launcher.mjs" })
  expect(problems, "exports", manifest.exports, { "./package.json": "./package.json" })
  if (!files.get("package/dist/launcher.mjs")?.toString("utf8").startsWith("#!/usr/bin/env node"))
    problems.push("The CLI launcher must start with a Node shebang")
  for (const file of files.keys()) {
    if (!["package/package.json", "package/README.md", "package/dist/launcher.mjs"].includes(file))
      problems.push(`Unexpected CLI package file: ${file}`)
  }
  return problems.map((problem) => `${tarball}: ${problem}`)
}
