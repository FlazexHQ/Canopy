import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import process from "node:process"
import * as bsonCodec from "../../node_modules/bson/lib/bson.mjs"
import { replay } from "./replay.mjs"

const root = new URL("../../../", import.meta.url)
const vectors = async (name) =>
  JSON.parse(await readFile(new URL(`conformance/${name}.json`, root), "utf8"))
const generated = (module, suffix) =>
  new URL(`packages/wasm/generated/${module}/canopy_${module}${suffix}`, root)
for (const mode of ["wasm", "js"]) {
  const wasm = globalThis.WebAssembly
  try {
    if (mode === "js") globalThis.WebAssembly = undefined
    const suffix = mode === "wasm" ? ".js" : "_js.js"
    const client = await import(generated("client", suffix))
    const authoring = await import(generated("authoring", suffix))
    if (mode === "wasm") {
      for (const [name, binding] of [
        ["client", client],
        ["authoring", authoring],
      ]) {
        binding.initSync({ module: await readFile(generated(name, "_bg.wasm")) })
      }
    }
    const loadDocuments = async () => {
      const { loadTransforms } = await import(new URL("./load.js", generated("transforms", suffix)))
      const source =
        mode === "wasm" ? await readFile(generated("transforms", "_bg.wasm")) : undefined
      if (mode === "wasm") {
        await assert.rejects(loadTransforms(new Uint8Array()))
      }
      const first = loadTransforms(source)
      assert.equal(loadTransforms(source), first)
      return first
    }
    const counts = await replay({ client, loadDocuments, authoring, vectors, assert, bsonCodec })
    process.stdout.write(`${JSON.stringify(counts)}\n`)
    process.stdout.write(`${mode} conformance passed\n`)
  } finally {
    globalThis.WebAssembly = wasm
  }
}
