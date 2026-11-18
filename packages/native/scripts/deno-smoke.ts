/**
 * Checks the loader under Deno: without `--allow-ffi` it must take the WebAssembly build without asking for
 * the permission, and with it the native addon. Run from the repository root after the build:
 *
 *   deno run --no-prompt --allow-read --allow-env --allow-sys --node-modules-dir=manual packages/native/scripts/deno-smoke.ts wasm
 *   deno run --no-prompt --allow-read --allow-env --allow-sys --allow-ffi --node-modules-dir=manual packages/native/scripts/deno-smoke.ts native
 */
import { loadNativeEngine } from "@canopy/native"

interface DenoRuntime {
  readonly args: readonly string[]
  readonly permissions: { querySync(descriptor: { name: "ffi" }): { state: string } }
  exit(code: number): never
}

const deno = (globalThis as { Deno?: DenoRuntime }).Deno
if (deno === undefined) throw new Error("Run this script with Deno")
const expected = deno.args[0]
if (expected !== "native" && expected !== "wasm") {
  throw new Error("Pass the engine the loader must take: native or wasm")
}

const engine = loadNativeEngine()
const filter = engine.compileFilter({ a: { $gt: 1 } })
const decides = filter.matches({ a: 2 }) && !filter.matches({ a: 1 })
const ffi = deno.permissions.querySync({ name: "ffi" }).state
process.stdout.write(`Deno, ffi ${ffi}: loaded ${engine.kind}, expected ${expected}\n`)
if (engine.kind !== expected || !decides) deno.exit(1)
