import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { NATIVE_TARGETS, type NativeTarget } from "../../native/src/targets.ts"
import { gatewayPackage } from "../src/gateway-package.ts"
import {
  optionalDependencies,
  pack,
  type Release,
  STUDIO_PACKAGE,
  stagePlatformPackage,
  stageStudioPackage,
  tarballName,
  verifyLauncherTarball,
  verifyPlatformTarball,
  verifyStudioTarball,
} from "./canopyd-packages.ts"

/**
 * Packs the prebuilt `canopyd` and `canopy` executables as npm packages. Run with Bun:
 *
 *   bun packages/realtime/scripts/pack-canopyd.ts --target <triple> --binary <file> --cli-binary <file> [--glibc-baseline] [--out <dir>]
 *   bun packages/realtime/scripts/pack-canopyd.ts --assemble <dir> --studio-dir <build> [--partial] [--out <dir>]
 *
 * The first form packs the release builds of one target into `packs/` (or `--out <dir>`) as `@canopy/canopyd-<suffix>`
 * (the suffixes of `@canopy/native`), checks the tarball (with `--glibc-baseline`, also the glibc version a
 * Linux build links against) and lists it in `packs/packs.json`.
 *
 * `--assemble` takes the `packs/` folders of several such runs, downloaded anywhere under `<dir>`, checks every
 * platform package, and packs the release into `packs/`: the platform packages and `@canopy/realtime`, which
 * launches canopyd, with `optionalDependencies` naming all of them at its version. The Studio build goes
 * into one shared package at the same version. The optional dependencies
 * exist only in that tarball, so the repository installs without packages that are not published. It fails
 * when a target is missing, unless `--partial` allows a subset for local testing. Nothing is published.
 */
const root = fileURLToPath(new URL("..", import.meta.url))
const packs = join(root, "packs")
const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
  string,
  unknown
> & { name: string; version: string; license: string; repository: Release["repository"] }
const release: Release = {
  version: source.version,
  license: source.license,
  repository: source.repository,
}

/** A tarball in `packs/`, as `packs/packs.json` lists it. */
interface Packed {
  readonly name: string
  readonly file: string
}

function usage(message: string): never {
  throw new Error(
    `${message}\nUsage: pack-canopyd.ts --target <triple> --binary <file> --cli-binary <file> [--glibc-baseline] [--out <dir>]\n       pack-canopyd.ts --assemble <dir> --studio-dir <build> [--partial] [--out <dir>]`,
  )
}

function fail(problems: readonly string[]): void {
  if (problems.length > 0) throw new Error(`Packing failed:\n${problems.join("\n")}`)
}

function packTarget(
  triple: string,
  gateway: string,
  cli: string,
  glibcBaseline: boolean,
  destination: string,
): void {
  const target =
    NATIVE_TARGETS.find((candidate) => candidate.triple === triple) ??
    usage(`No canopyd target ${triple}`)
  for (const binary of [gateway, cli]) {
    if (!existsSync(binary)) usage(`No file ${binary}`)
  }
  const packed: Packed = {
    name: gatewayPackage(target),
    file: tarballName(gatewayPackage(target), release.version),
  }
  const list = join(destination, "packs.json")
  const tarball = join(destination, packed.file)
  rmSync(list, { force: true })
  rmSync(tarball, { force: true })
  mkdirSync(destination, { recursive: true })
  const staging = mkdtempSync(join(destination, "canopyd-stage-"))
  const packageFolder = join(staging, "package")
  try {
    stagePlatformPackage(
      target,
      { gateway: resolve(gateway), cli: resolve(cli) },
      packageFolder,
      release,
    )
    pack(process.execPath, packageFolder, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  fail(verifyPlatformTarball(tarball, target, release, glibcBaseline))
  writeFileSync(list, `${JSON.stringify([packed], null, 2)}\n`)
  process.stdout.write(`packed ${packed.name} into ${destination}\n`)
}

function run(command: string, commandArgs: readonly string[]): void {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" })
  if (result.status !== 0)
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${String(result.status)}`)
}

/** Packs `@canopy/realtime` naming the platform packages of `targets`, checks it and writes `packs.json`. */
function packLauncher(targets: readonly NativeTarget[], destination: string, studio: Packed): void {
  run(process.execPath, ["run", "build"])
  const optional = optionalDependencies(targets, release.version)
  const manifest = join(root, "package.json")
  const original = readFileSync(manifest, "utf8")
  try {
    writeFileSync(
      manifest,
      `${JSON.stringify({ ...source, optionalDependencies: optional }, null, 2)}\n`,
    )
    pack(process.execPath, root, destination)
  } finally {
    writeFileSync(manifest, original)
  }
  const own: Packed = { name: source.name, file: tarballName(source.name, release.version) }
  fail(verifyLauncherTarball(join(destination, own.file), source.name, release.version, optional))
  const all = [
    own,
    ...targets.map((target) => ({
      name: gatewayPackage(target),
      file: tarballName(gatewayPackage(target), release.version),
    })),
    studio,
  ]
  writeFileSync(join(destination, "packs.json"), `${JSON.stringify(all, null, 2)}\n`)
  process.stdout.write(`packed ${all.map(({ name }) => name).join(", ")} into ${destination}\n`)
}

function assemble(folder: string, studioDir: string, partial: boolean, destination: string): void {
  const input = resolve(folder)
  for (const directory of [input, studioDir]) {
    const inside = relative(destination, directory)
    if (!isAbsolute(inside) && inside.split(sep)[0] !== "..")
      usage(`--assemble cannot read from ${destination}, which it writes to`)
  }
  const found = new Map<string, string>()
  const lists = readdirSync(input, { recursive: true, encoding: "utf8" }).filter(
    (path) => basename(path) === "packs.json",
  )
  for (const list of lists) {
    const entries = JSON.parse(readFileSync(join(input, list), "utf8")) as Packed[]
    for (const { name, file } of entries) {
      if (name === source.name) continue
      if (file !== tarballName(name, release.version))
        throw new Error(
          `${list} lists ${file} for ${name}, expected ${tarballName(name, release.version)}`,
        )
      const path = join(input, dirname(list), file)
      const previous = found.get(name)
      if (previous !== undefined)
        throw new Error(`${name} is packed twice: ${previous} and ${path}`)
      found.set(name, path)
    }
  }
  const wanted = NATIVE_TARGETS.map((target) => gatewayPackage(target))
  const unknown = [...found.keys()].filter((name) => !wanted.includes(name))
  if (unknown.length > 0) throw new Error(`Unknown packages in ${input}: ${unknown.join(", ")}`)
  const missing = wanted.filter((name) => !found.has(name))
  if (missing.length > 0 && !partial)
    throw new Error(`Missing from ${input}: ${missing.join(", ")} (--partial allows a subset)`)
  if (found.size === 0) throw new Error(`No packs.json under ${input}`)
  mkdirSync(destination, { recursive: true })
  const studio = { name: STUDIO_PACKAGE, file: tarballName(STUDIO_PACKAGE, release.version) }
  const outputs = new Set([
    studio.file,
    tarballName(source.name, release.version),
    ...[...found.keys()].map((name) => tarballName(name, release.version)),
  ])
  const stale = readdirSync(destination).filter(
    (file) => file.endsWith(".tgz") && !outputs.has(file),
  )
  if (stale.length > 0)
    usage(
      `Unexpected tarballs in ${destination}: ${stale.join(", ")}. Use a fresh --out directory.`,
    )
  rmSync(join(destination, "packs.json"), { force: true })
  const targets: NativeTarget[] = []
  const problems: string[] = []
  for (const target of NATIVE_TARGETS) {
    const path = found.get(gatewayPackage(target))
    if (path === undefined) continue
    const tarball = join(destination, tarballName(gatewayPackage(target), release.version))
    copyFileSync(path, tarball)
    problems.push(...verifyPlatformTarball(tarball, target, release, true))
    targets.push(target)
  }
  fail(problems)
  if (missing.length > 0) process.stdout.write(`partial release, without ${missing.join(", ")}\n`)
  const staging = mkdtempSync(join(destination, "studio-stage-"))
  try {
    stageStudioPackage(studioDir, staging, release)
    pack(process.execPath, staging, destination)
    fail(verifyStudioTarball(join(destination, studio.file), release))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  packLauncher(targets, destination, studio)
}

const argv = process.argv.slice(2)
let triple: string | undefined
let binary: string | undefined
let cliBinary: string | undefined
let out: string | undefined
let folder: string | undefined
let studioDir: string | undefined
let glibcBaseline = false
let partial = false
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  if (flag === "--glibc-baseline") glibcBaseline = true
  else if (flag === "--partial") partial = true
  else if (
    ["--target", "--binary", "--cli-binary", "--out", "--assemble", "--studio-dir"].includes(
      flag ?? "",
    )
  ) {
    index += 1
    const value = argv[index] ?? usage(`${flag} needs a value`)
    if (flag === "--target") triple = value
    else if (flag === "--binary") binary = value
    else if (flag === "--cli-binary") cliBinary = value
    else if (flag === "--out") out = value
    else if (flag === "--studio-dir") studioDir = value
    else folder = value
  } else usage(`Unexpected argument ${flag ?? ""}`)
}
const destination = out === undefined ? packs : resolve(out)
if (folder !== undefined) {
  if (triple !== undefined || binary !== undefined || cliBinary !== undefined || glibcBaseline)
    usage("--assemble takes no target options")
  assemble(folder, resolve(studioDir ?? usage("--studio-dir is required")), partial, destination)
} else {
  if (partial) usage("--partial needs --assemble")
  if (studioDir !== undefined) usage("--studio-dir needs --assemble")
  packTarget(
    triple ?? usage("--target is required"),
    binary ?? usage("--binary is required"),
    cliBinary ?? usage("--cli-binary is required"),
    glibcBaseline,
    destination,
  )
}
