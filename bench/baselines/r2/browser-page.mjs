import * as bsonCodec from "/bson.mjs"
import { assert } from "./assertions.mjs"
import { replay } from "./replay.mjs"

const moduleUrl = (name, suffix) => `/generated/${name}/canopy_${name}${suffix}`

async function run(mode) {
  const suffix = mode === "js" ? "_js.js" : ".js"
  const client = await import(moduleUrl("client", suffix))
  if (mode === "blocked") {
    try {
      await client.default()
    } catch (error) {
      assert.ok(error instanceof WebAssembly.CompileError, String(error))
      assert.ok(/Content Security Policy|blocked by CSP/i.test(error.message), String(error))
      return { blocked: String(error) }
    }
    throw new Error("Strict CSP allowed the Wasm client to initialize")
  }

  const authoring = await import(moduleUrl("authoring", suffix))
  if (mode === "wasm") {
    await client.default()
    await authoring.default()
  } else {
    globalThis.WebAssembly = undefined
  }
  const vectors = async (name) => {
    const response = await fetch(`/conformance/${name}.json`)
    assert.ok(response.ok, `${name}: HTTP ${response.status}`)
    return response.json()
  }
  const loadDocuments = async () => {
    const { loadTransforms } = await import("/generated/transforms/load.js")
    const first = loadTransforms()
    assert.equal(loadTransforms(), first)
    return first
  }
  return replay({ client, loadDocuments, authoring, vectors, assert, bsonCodec })
}

globalThis.replayResult = run(new URL(location.href).searchParams.get("mode")).then(
  (result) => ({ result }),
  (error) => ({ error: String(error), stack: error.stack }),
)
