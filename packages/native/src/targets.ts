import { readFileSync } from "node:fs"

/** A platform with a prebuilt addon, published as `@canopy/native-<suffix>`. */
export interface NativeTarget {
  /** The package and file suffix, as in `@canopy/native-linux-x64-gnu` and `canopy-native.linux-x64-gnu.node`. */
  readonly suffix: string
  /** The Rust target triple the addon is built for. */
  readonly triple: string
  /** The `process.platform` the addon runs on, also the `os` field of its package. */
  readonly os: "win32" | "darwin" | "linux"
  /** The `process.arch` the addon runs on, also the `cpu` field of its package. */
  readonly cpu: "x64" | "arm64"
  /** The C library of a Linux addon, also the `libc` field of its package. */
  readonly libc?: "glibc" | "musl"
}

/** Every platform with a prebuilt addon. */
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

/** The C library of this Linux process, or `undefined` on other platforms. */
function hostLibc(): NativeTarget["libc"] {
  if (process.platform !== "linux") return undefined
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
    if (report?.header !== undefined) return report.header.glibcVersionRuntime ? "glibc" : "musl"
  } catch {}
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl") ? "musl" : "glibc"
  } catch {
    return "glibc"
  }
}

/** The prebuilt addon for this process, or `undefined` when its platform has none. */
export function hostTarget(): NativeTarget | undefined {
  const libc = hostLibc()
  return NATIVE_TARGETS.find(
    (target) =>
      target.os === process.platform && target.cpu === process.arch && target.libc === libc,
  )
}
