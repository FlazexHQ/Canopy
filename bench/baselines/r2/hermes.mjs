import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const [binary, shimDirectory, ...flags] = process.argv.slice(2)
if (!binary || !shimDirectory) {
  throw new Error(
    "Usage: bun hermes.mjs <Hermes executable> <directory containing shim node_modules> [Hermes flags]",
  )
}

const require = createRequire(join(resolve(shimDirectory), "package.json"))
const { transform } = require("esbuild")
const root = fileURLToPath(new URL("../../../", import.meta.url))
const fixtures = [
  "authoring/policy/publishing",
  "authoring/policy/vectors",
  "matcher/filters",
  "matcher/projections",
  "matcher/sorts",
  "matcher/updates",
  "policy/policy",
  "protocol/07-typed-values",
  "query/query",
  "schema/schema",
]
const importPath = (path) => JSON.stringify(join(root, path))
const fixtureText = await Promise.all(
  fixtures.map((name) => readFile(join(root, "conformance", `${name}.json`), "utf8")),
)

const directory = await mkdtemp(join(tmpdir(), "canopy-r2-hermes-"))
try {
  const entry = join(directory, "entry.mjs")
  await writeFile(
    entry,
    `
import ${JSON.stringify(require.resolve("fast-text-encoding"))}
import base64 from ${JSON.stringify(require.resolve("base64-js"))}
import * as bsonCodec from ${importPath("bench/node_modules/bson/lib/bson.mjs")}
import { assert } from ${importPath("bench/baselines/r2/assertions.mjs")}
import { replay } from ${importPath("bench/baselines/r2/replay.mjs")}
${fixtureText.map((text, index) => `const fixture${index} = ${JSON.stringify(text)}`).join("\n")}

globalThis.atob ??= (text) => Array.from(base64.toByteArray(text), (byte) => String.fromCharCode(byte)).join("")
globalThis.btoa ??= (text) => base64.fromByteArray(Uint8Array.from(text, (char) => char.charCodeAt(0)))

async function run() {
  assert.equal(typeof WebAssembly, "undefined")
  const client = await import(${importPath("packages/wasm/generated/client/canopy_client_js.js")})
  const authoring = await import(${importPath("packages/wasm/generated/authoring/canopy_authoring_js.js")})
  const loadDocuments = () => import(${importPath("packages/wasm/generated/transforms/canopy_transforms_js.js")})
  const fixtures = { ${fixtures.map((name, index) => `${JSON.stringify(name)}: fixture${index}`).join(", ")} }
  const counts = await replay({ client, authoring, loadDocuments, vectors: (name) => JSON.parse(fixtures[name]), assert, bsonCodec })
  print("Hermes wasm2js conformance passed " + JSON.stringify(counts))
}
run().catch((error) => print(error.stack || String(error)))
`,
  )
  await Bun.build({ entrypoints: [entry], outdir: directory, naming: "replay.js", format: "iife" })
  const bundle = join(directory, "replay.js")
  const { code } = await transform(await readFile(bundle, "utf8"), { target: "es2020" })
  await writeFile(bundle, code)
  const script = process.platform === "win32" ? bundle.replaceAll("\\", "/") : bundle
  const result = spawnSync(resolve(binary), [...flags, script], { encoding: "utf8" })
  if (result.error) throw result.error
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.status !== 0 || !result.stdout.includes("Hermes wasm2js conformance passed ")) {
    throw new Error(`Hermes replay failed with exit status ${result.status}`)
  }
} finally {
  await rm(directory, { recursive: true })
}
