import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import ts from "typescript"

const require = createRequire(
  new URL("../../../examples/express-dropin/package.json", import.meta.url),
)
const { build } = require("esbuild")

const { values } = parseArgs({
  options: {
    hermes: { type: "string" },
    hermesc: { type: "string" },
    legacy: { type: "boolean" },
    bench: { type: "boolean" },
  },
})
const binary = values.hermes ?? process.env.CANOPY_HERMES
const compiler = values.hermesc ?? process.env.CANOPY_HERMESC
if (!binary || !compiler) {
  throw new Error("Set --hermes and --hermesc or CANOPY_HERMES and CANOPY_HERMESC")
}

const root = fileURLToPath(new URL("../../../", import.meta.url))
const fixtures = [
  "authoring/policy/publishing",
  "authoring/policy/vectors",
  "matcher/filters",
  "matcher/projections",
  "matcher/sorts",
  "matcher/updates",
  "policy/policy",
  "policy/pipeline",
  "protocol/07-typed-values",
  "query/query",
  "schema/schema",
]
const fixtureText = Object.fromEntries(
  await Promise.all(
    fixtures.map(async (name) => [
      name,
      await readFile(join(root, "conformance", `${name}.json`), "utf8"),
    ]),
  ),
)
const target = join(root, "target")
await mkdir(target, { recursive: true })
const directory = await mkdtemp(join(target, "r2-hermes-"))

function run(executable, args) {
  const result = spawnSync(resolve(executable), args, { encoding: "utf8" })
  if (result.error) throw result.error
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.status !== 0) {
    throw new Error(`${executable} failed with ${result.signal ?? `exit status ${result.status}`}`)
  }
  return result.stdout
}

try {
  const bundle = join(directory, "replay.js")
  const bytecode = join(directory, "replay.hbc")
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import "./bench/baselines/r2/hermes-host.mjs"
import * as bsonCodec from "./bench/node_modules/bson/lib/bson.mjs"
import { assert } from "./bench/baselines/r2/assertions.mjs"
import { replay } from "./bench/baselines/r2/replay.mjs"
const fixtureText = ${JSON.stringify(fixtureText)}
const vectors = (name) => JSON.parse(fixtureText[name])
const pending = new Set(Object.keys(fixtureText))
let active = []
async function main() {
  assert.equal(typeof WebAssembly, "undefined")
  const client = await import("./packages/wasm/generated/client/canopy_client_js.js")
  const authoring = await import("./packages/wasm/generated/authoring/canopy_authoring_js.js")
  const loadDocuments = () => import("./packages/wasm/generated/transforms/canopy_transforms_js.js")
  const counts = await replay({
    client, authoring, loadDocuments, vectors, assert, bsonCodec,
    start: (...names) => { active = names },
    pass: (name, count) => {
      assert.ok(pending.delete(name), name)
      active = active.filter((entry) => entry !== name)
      print("PASS " + name + " (" + count + ")")
    },
  })
  assert.equal(pending.size, 0)
  print(JSON.stringify(counts))
  ${
    values.bench
      ? `
  const { benchmark } = await import("./bench/baselines/r2/hermes-bench.mjs")
  benchmark({ client, bsonCodec, protocol: vectors("protocol/07-typed-values") })
  `
      : ""
  }
  print("Hermes wasm2js replay completed successfully")
}
main().catch((error) => {
  for (const name of pending) print((active.includes(name) ? "FAIL " : "NOT RUN ") + name)
  print(error.stack || String(error))
  quit(1)
})
`,
    },
    outfile: bundle,
    target: "es2016",
    supported: { bigint: true },
    conditions: ["@canopy/source"],
    bundle: true,
    format: "iife",
    plugins: values.legacy
      ? [
          {
            name: "hermes-legacy-bson",
            setup(build) {
              build.onLoad({ filter: /[/\\]bson\.mjs$/ }, async ({ path }) => ({
                contents: ts.transpileModule(await readFile(path, "utf8"), {
                  compilerOptions: {
                    target: ts.ScriptTarget.ES5,
                    module: ts.ModuleKind.ESNext,
                    downlevelIteration: true,
                  },
                }).outputText,
                loader: "js",
              }))
            },
          },
        ]
      : [],
  })
  const flags = values.legacy ? ["-Xes6-class"] : []
  run(compiler, [...flags, "-w", "-O", "-emit-binary", "-out", bytecode, bundle])
  const stdout = run(binary, [...flags, bytecode])
  if (!stdout.split(/\r?\n/).includes("Hermes wasm2js replay completed successfully")) {
    throw new Error("Hermes exited before completing the replay")
  }
} finally {
  await rm(directory, { recursive: true })
}
