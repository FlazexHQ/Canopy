import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { GLIBC_BASELINE, type NativeTarget, WASM_TARGET } from "../src/targets.ts"

/** The files of a gzipped tarball, by path. */
export function readTarball(file: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(file))
  const files = new Map<string, Buffer>()
  const text = (start: number, length: number): string =>
    tar
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "")
  let offset = 0
  let longName: string | undefined
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8)
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = text(offset + 345, 155)
    const name = longName ?? (prefix === "" ? text(offset, 100) : `${prefix}/${text(offset, 100)}`)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    longName = undefined
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))
      longName = path?.[1]
    } else if (type === "0" || type === "\0") {
      files.set(name, Buffer.from(body))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

interface Manifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly os?: unknown
  readonly cpu?: unknown
  readonly libc?: unknown
  readonly main?: unknown
  readonly dependencies?: unknown
  readonly optionalDependencies?: unknown
}

function manifestOf(files: Map<string, Buffer>, tarball: string): Manifest {
  const json = files.get("package/package.json")
  if (json === undefined) throw new Error(`${tarball} has no package/package.json`)
  return JSON.parse(json.toString("utf8")) as Manifest
}

const same = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected)

function expect(problems: string[], label: string, actual: unknown, expected: unknown): void {
  if (!same(actual, expected))
    problems.push(`${label} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`)
}

/** The machine an addon was built for, read from its PE, ELF or Mach-O header. */
function machineOf(binary: Buffer): { format: string; cpu: string } | undefined {
  if (binary.length >= 64 && binary.toString("latin1", 0, 2) === "MZ") {
    const pe = binary.readUInt32LE(0x3c)
    if (binary.toString("latin1", pe, pe + 4) !== "PE\0\0") return undefined
    const machine = binary.readUInt16LE(pe + 4)
    return {
      format: "pe",
      cpu: machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : "other",
    }
  }
  if (binary.length >= 64 && binary.toString("latin1", 0, 4) === "\x7fELF") {
    if (binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(16) !== 3) return undefined
    const machine = binary.readUInt16LE(18)
    return { format: "elf", cpu: machine === 62 ? "x64" : machine === 183 ? "arm64" : "other" }
  }
  if (binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf) {
    const machine = binary.readUInt32LE(4)
    return {
      format: "macho",
      cpu: machine === 0x01000007 ? "x64" : machine === 0x0100000c ? "arm64" : "other",
    }
  }
  return undefined
}

const FORMAT: Readonly<Record<NativeTarget["os"], string>> = {
  win32: "pe",
  linux: "elf",
  darwin: "macho",
}

const version = (text: string): number[] => text.split(".").map(Number)
const newer = (a: number[], b: number[]): boolean => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/** What a platform or root package must contain. */
export interface Expected {
  /** The root package name, such as `@canopy/native`. */
  readonly root: string
  readonly version: string
  /** The `napi.binaryName` of the root package. */
  readonly binary: string
}

/**
 * Checks the tarball of a platform package: its name, version and `os`, `cpu` and `libc` fields, and that the
 * addon inside is a library for that operating system and processor. With `glibcBaseline`, a glibc addon
 * must need no glibc newer than `GLIBC_BASELINE`, and a musl addon must not reference glibc at all.
 */
export function verifyNative(
  tarball: string,
  target: NativeTarget,
  expected: Expected,
  glibcBaseline: boolean,
): string[] {
  const files = readTarball(tarball)
  const manifest = manifestOf(files, tarball)
  const problems: string[] = []
  const file = `${expected.binary}.${target.suffix}.node`
  expect(problems, "name", manifest.name, `${expected.root}-${target.suffix}`)
  expect(problems, "version", manifest.version, expected.version)
  expect(problems, "os", manifest.os, [target.os])
  expect(problems, "cpu", manifest.cpu, [target.cpu])
  expect(problems, "libc", manifest.libc, target.libc === undefined ? undefined : [target.libc])
  expect(problems, "main", manifest.main, file)
  const binary = files.get(`package/${file}`)
  if (binary === undefined) problems.push(`${file} is missing`)
  else {
    const machine = machineOf(binary)
    expect(problems, file, machine, { format: FORMAT[target.os], cpu: target.cpu })
    if (target.libc !== undefined && glibcBaseline) {
      const required = [...binary.toString("latin1").matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map(
        (match) => match[1] ?? "",
      )
      if (target.libc === "musl" && required.length > 0)
        problems.push(`${file} references glibc ${[...new Set(required)].join(", ")}`)
      if (target.libc === "glibc") {
        if (required.length === 0) problems.push(`${file} references no glibc symbol version`)
        const newest = required.reduce(
          (top, next) => (newer(version(next), version(top)) ? next : top),
          "0",
        )
        if (newer(version(newest), version(GLIBC_BASELINE)))
          problems.push(`${file} needs glibc ${newest}, newer than ${GLIBC_BASELINE}`)
      }
    }
  }
  return problems.map((problem) => `${tarball}: ${problem}`)
}

/**
 * Checks the tarball of the WebAssembly package: no `os` or `cpu` field, the module and its loader, and the
 * runtime packages as dependencies at the versions of the catalog.
 */
export function verifyWasm(
  tarball: string,
  expected: Expected,
  catalog: Readonly<Record<string, string>>,
): string[] {
  const files = readTarball(tarball)
  const manifest = manifestOf(files, tarball)
  const problems: string[] = []
  const file = `${expected.binary}.${WASM_TARGET.suffix}.wasm`
  expect(problems, "name", manifest.name, `${expected.root}-${WASM_TARGET.suffix}`)
  expect(problems, "version", manifest.version, expected.version)
  expect(problems, "os", manifest.os, undefined)
  expect(problems, "cpu", manifest.cpu, undefined)
  expect(problems, "main", manifest.main, "wasi.cjs")
  expect(
    problems,
    "dependencies",
    manifest.dependencies,
    Object.fromEntries(WASM_TARGET.dependencies.map((name) => [name, catalog[name]])),
  )
  if (!files.has("package/wasi.cjs")) problems.push("wasi.cjs is missing")
  const module = files.get(`package/${file}`)
  if (module === undefined) problems.push(`${file} is missing`)
  else if (module.toString("latin1", 0, 8) !== "\0asm\x01\0\0\0")
    problems.push(`${file} is not a WebAssembly module`)
  return problems.map((problem) => `${tarball}: ${problem}`)
}

/** Checks the tarball of the root package: built, and naming exactly `optional` as its optional dependencies. */
export function verifyRoot(
  tarball: string,
  expected: Expected,
  optional: Readonly<Record<string, string>>,
): string[] {
  const files = readTarball(tarball)
  const manifest = manifestOf(files, tarball)
  const problems: string[] = []
  expect(problems, "name", manifest.name, expected.root)
  expect(problems, "version", manifest.version, expected.version)
  expect(problems, "optionalDependencies", manifest.optionalDependencies, optional)
  for (const file of ["package/dist/index.js", "package/dist/index.d.ts"])
    if (!files.has(file)) problems.push(`${file.slice("package/".length)} is missing`)
  return problems.map((problem) => `${tarball}: ${problem}`)
}
