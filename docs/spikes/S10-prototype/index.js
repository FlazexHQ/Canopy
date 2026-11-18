import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const NATIVE_TARGETS = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64-gnu": "linux-x64-gnu",
  "linux-x64-musl": "linux-x64-musl",
  "linux-arm64-gnu": "linux-arm64-gnu",
  "linux-arm64-musl": "linux-arm64-musl",
}

function readEnv(name) {
  try {
    return process.env[name]
  } catch {
    return undefined
  }
}

function libc() {
  if (process.platform !== "linux") return ""
  try {
    const header = process.report?.getReport?.()?.header
    if (header) return header.glibcVersionRuntime ? "-gnu" : "-musl"
  } catch {}
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl") ? "-musl" : "-gnu"
  } catch {
    return "-gnu"
  }
}

function attempt(specifiers, errors) {
  for (const specifier of specifiers) {
    try {
      return { binding: require(specifier), from: specifier }
    } catch (error) {
      errors.push(error)
    }
  }
  return undefined
}

function load() {
  const wanted = readEnv("CANOPY_NATIVE_ENGINE") ?? "auto"
  const errors = []
  const target = NATIVE_TARGETS[`${process.platform}-${process.arch}${libc()}`]
  if (wanted !== "wasm" && target !== undefined) {
    const loaded = attempt(
      [`./canopy-native.${target}.node`, `@canopy-s10/native-${target}`],
      errors,
    )
    if (loaded) return loaded
  }
  if (wanted !== "native") {
    const loaded = attempt(["./wasi.cjs", "@canopy-s10/native-wasm32-wasi"], errors)
    if (loaded) return loaded
  }
  const error = new Error(
    `No Canopy native engine loads on ${process.platform} ${process.arch} (engine "${wanted}").`,
    { cause: errors },
  )
  error.code = "CANOPY_UNAVAILABLE"
  throw error
}

const loaded = load()

export const Filter = loaded.binding.Filter
export const FilterSet = loaded.binding.FilterSet
export const engine = loaded.binding.engine
export const noop = loaded.binding.noop
export const noopBytes = loaded.binding.noopBytes
export const loadedFrom = loaded.from
