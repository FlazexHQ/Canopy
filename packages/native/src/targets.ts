import { readFileSync } from "node:fs"

/**
 * A platform with prebuilt binaries: the addon published as `@canopy/native-<suffix>` and the `canopyd`
 * executable published as `@canopy/canopyd-<suffix>`.
 */
export interface NativeTarget {
  /** The package and file suffix, as in `@canopy/native-linux-x64-gnu` and `canopy-native.linux-x64-gnu.node`. */
  readonly suffix: string
  /** The Rust target triple the binaries are built for. */
  readonly triple: string
  /** The `process.platform` the binaries run on, also the `os` field of their packages. */
  readonly os: "win32" | "darwin" | "linux"
  /** The `process.arch` the binaries run on, also the `cpu` field of their packages. */
  readonly cpu: "x64" | "arm64"
  /** The C library of a Linux target, also the `libc` field of its packages. */
  readonly libc?: "glibc" | "musl"
}

/** Every platform with a prebuilt addon and a prebuilt `canopyd`. */
export const NATIVE_TARGETS: readonly NativeTarget[] = [
  { suffix: "win32-x64-msvc", triple: "x86_64-pc-windows-msvc", os: "win32", cpu: "x64" },
  { suffix: "win32-arm64-msvc", triple: "aarch64-pc-windows-msvc", os: "win32", cpu: "arm64" },
  { suffix: "darwin-x64", triple: "x86_64-apple-darwin", os: "darwin", cpu: "x64" },
  { suffix: "darwin-arm64", triple: "aarch64-apple-darwin", os: "darwin", cpu: "arm64" },
  {
    suffix: "linux-x64-gnu",
    triple: "x86_64-unknown-linux-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  },
  {
    suffix: "linux-x64-musl",
    triple: "x86_64-unknown-linux-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
  },
  {
    suffix: "linux-arm64-gnu",
    triple: "aarch64-unknown-linux-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  },
  {
    suffix: "linux-arm64-musl",
    triple: "aarch64-unknown-linux-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
  },
]

/**
 * The WebAssembly build, published as `@canopy/native-wasm32-wasi` without `os` or `cpu` so it installs
 * everywhere, with the runtime packages `wasi.cjs` loads it with as its dependencies.
 */
export const WASM_TARGET = {
  suffix: "wasm32-wasi",
  triple: "wasm32-wasip1-threads",
  dependencies: ["@napi-rs/wasm-runtime", "@emnapi/core", "@emnapi/runtime"],
} as const

/**
 * The oldest glibc the Linux glibc addons support: a cross build links against this version, and a release
 * refuses an addon that needs a newer one.
 */
export const GLIBC_BASELINE = "2.17"

/**
 * The C library of a Linux process: glibc when `report` (what `process.report.getReport()` returns) names a
 * glibc runtime version, musl when it has a header without one, and otherwise what `ldd` (the text of
 * `/usr/bin/ldd`) names, glibc when neither can be read.
 */
export function linuxLibc(report: () => unknown, ldd: () => string): "glibc" | "musl" {
  try {
    const header = (report() as { header?: { glibcVersionRuntime?: unknown } } | undefined)?.header
    if (header !== undefined) return header.glibcVersionRuntime ? "glibc" : "musl"
  } catch {}
  try {
    return ldd().includes("musl") ? "musl" : "glibc"
  } catch {
    return "glibc"
  }
}

/** The C library of this Linux process, or `undefined` on other platforms. */
function hostLibc(): NativeTarget["libc"] {
  if (process.platform !== "linux") return undefined
  return linuxLibc(
    () => process.report?.getReport(),
    () => readFileSync("/usr/bin/ldd", "utf8"),
  )
}

/** The prebuilt target for an operating system, processor and, on Linux, C library, if there is one. */
export function targetFor(
  os: string,
  cpu: string,
  libc: NativeTarget["libc"],
): NativeTarget | undefined {
  return NATIVE_TARGETS.find(
    (target) => target.os === os && target.cpu === cpu && target.libc === libc,
  )
}

/** The prebuilt target for this process, or `undefined` when its platform has none. */
export function hostTarget(): NativeTarget | undefined {
  return targetFor(process.platform, process.arch, hostLibc())
}
