import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Replays the filter vectors MongoDB recorded (`crates/canopy-matcher/tests/vectors/filters.json`) through the
 * loaded engine, with each document matched alone, as an array of buffers and as one concatenated buffer, and
 * checks the error paths. Usage:
 *
 *   <runtime> scripts/smoke.mjs [--module <specifier or path>] [--vectors <path>] [--expect native|wasm]
 */
const options = { module: undefined, vectors: undefined, expect: undefined }
for (let i = 2; i < process.argv.length; i += 2) {
  options[process.argv[i].replace(/^--/, "")] = process.argv[i + 1]
}
const vectorsPath =
  options.vectors ??
  new URL("../../../../crates/canopy-matcher/tests/vectors/filters.json", import.meta.url)
const asPath = (text) => text.startsWith(".") || isAbsolute(text)
const specifier =
  options.module === undefined
    ? new URL("../index.js", import.meta.url).href
    : asPath(options.module)
      ? pathToFileURL(resolve(options.module)).href
      : options.module

const { Filter, engine, loadedFrom } = await import(specifier)
const failures = []
const fail = (message) => {
  if (failures.length < 20) console.error(message)
  failures.push(message)
}

if (options.expect !== undefined && engine() !== options.expect) {
  fail(`engine is ${engine()}, expected ${options.expect}`)
}

const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"))
const documents = vectors.documents.map((text) => new Uint8Array(Buffer.from(text, "base64")))
const concatenated = new Uint8Array(Buffer.concat(documents))
const bit = (mask, index) => (Number.parseInt(mask.slice((index >> 3) * 2, (index >> 3) * 2 + 2), 16) >> (index & 7)) & 1

let compared = 0
let refused = 0
let unsupported = 0
for (const [caseIndex, testCase] of vectors.cases.entries()) {
  let filter
  try {
    filter = Filter.fromBson(new Uint8Array(Buffer.from(testCase.filter, "base64")))
  } catch (error) {
    if (error.code !== "CANOPY_INVALID_QUERY") fail(`case ${caseIndex}: unexpected code ${error.code}`)
    if (error.message.startsWith("UnsupportedQueryError:")) unsupported += 1
    else if (testCase.error !== undefined) refused += 1
    else fail(`case ${caseIndex}: MongoDB answered, the engine refused it (${error.message})`)
    continue
  }
  if (testCase.error !== undefined) {
    fail(`case ${caseIndex}: MongoDB refused it (${testCase.error}), the engine accepted it`)
    continue
  }
  compared += 1
  const many = filter.matchMany(documents)
  const joined = filter.matchConcatenated(concatenated)
  for (const [index, document] of documents.entries()) {
    const expected = bit(testCase.matches, index)
    const single = filter.matches(document) ? 1 : 0
    if (single !== expected || many[index] !== expected || joined[index] !== expected) {
      fail(
        `case ${caseIndex}, document ${index}: MongoDB ${expected}, single ${single}, many ${many[index]}, concatenated ${joined[index]}`,
      )
    }
  }
}

const owner = Filter.fromEjson('{"ownerId": "u42", "amount": {"$gte": {"$numberLong": "100"}}}')
const broken = documents[0].slice(0, documents[0].length - 1)
const batch = owner.matchMany([documents[0], broken])
if (batch[1] !== 2) fail(`a malformed document in a batch gave ${batch[1]}, expected 2 (undecided)`)
const expectThrow = (label, run) => {
  try {
    run()
    fail(`${label}: no error`)
  } catch (error) {
    if (error.code !== "CANOPY_INVALID_QUERY") fail(`${label}: code ${error.code}`)
  }
}
expectThrow("malformed single document", () => owner.matches(broken))
expectThrow("truncated concatenated batch", () => owner.matchConcatenated(concatenated.slice(0, 7)))
expectThrow("invalid EJSON", () => Filter.fromEjson('{"a": {"$numberLong": "x"}}'))
expectThrow("unknown operator", () => Filter.fromEjson('{"a": {"$nope": 1}}'))

const runtime = globalThis.Deno ? `Deno ${Deno.version.deno}` : globalThis.Bun ? `Bun ${Bun.version}` : `Node ${process.versions.node}`
process.stdout.write(
  `${runtime}: engine ${engine()} from ${loadedFrom}; ${compared} filters x ${documents.length} documents agree with MongoDB in 3 call shapes (${refused} refused by both, ${unsupported} unsupported); ${failures.length} failures
`,
)
if (failures.length > 0) process.exit(1)
