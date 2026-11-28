import { compileFilter } from "../../../packages/matcher/src/lite.ts"
import { canonicalString, parse } from "../../../packages/protocol/src/ejson.ts"
import { benchDocument, SCENARIOS } from "../../workloads/matcher/scenarios.ts"
import { assert } from "./assertions.mjs"

function measure(name, unit, operations, expected, iterations, unitsPerIteration = 1) {
  for (const operation of operations) assert.equal(operation(), expected, name)
  const samples = [[], []]
  for (let round = 0; round < 5; round++) {
    for (let slot = 0; slot < operations.length; slot++) {
      const mode = (round + slot) % operations.length
      const operation = operations[mode]
      let total = 0
      const start = Date.now()
      for (let iteration = 0; iteration < iterations; iteration++) total += operation()
      const elapsed = Date.now() - start
      assert.equal(total, iterations * expected, name)
      samples[mode].push((elapsed * 1000) / (iterations * unitsPerIteration))
    }
  }
  const [typescript, wasm2js] = samples.map((times) => times.sort((a, b) => a - b)[2])
  print(JSON.stringify({ name, unit, typescript, wasm2js, ratio: wasm2js / typescript }))
}

export function benchmark({ client, bsonCodec, protocol }) {
  print("Desktop Hermes CLI measurements (median of five samples per implementation)")
  const documents = Array.from({ length: 1000 }, (_, index) => benchDocument(index))
  const payloads = documents.map((document) => bsonCodec.serialize(document))
  const joined = new Uint8Array(payloads.reduce((size, payload) => size + payload.length, 0))
  let offset = 0
  for (const payload of payloads) {
    joined.set(payload, offset)
    offset += payload.length
  }
  const page = client.DocumentPage.fromBson(joined)
  try {
    for (const [name, { filter, handWritten }] of Object.entries(SCENARIOS)) {
      if (name === "dotted path") continue
      const compiled = compileFilter(filter)
      const wasmFilter = client.Filter.fromEjson(
        bsonCodec.EJSON.stringify(filter, { relaxed: false }),
      )
      try {
        const expected = documents.map((document) => Number(handWritten(document)))
        assert.deepEqual(
          documents.map((document) => Number(compiled.matches(document))),
          expected,
        )
        assert.deepEqual(Array.from(page.matchFilter(wasmFilter)), expected)
        const typescript = () => {
          let matches = 0
          for (const document of documents) matches += Number(compiled.matches(document))
          return matches
        }
        const wasm2js = () => {
          let matches = 0
          for (const decision of page.matchFilter(wasmFilter)) matches += decision
          return matches
        }
        measure(
          name,
          "us/1000 documents",
          [typescript, wasm2js],
          expected.reduce((total, decision) => total + decision, 0),
          50,
        )
      } finally {
        wasmFilter.free()
      }
    }
  } finally {
    page.free()
  }

  const frames = protocol.steps
    .flatMap((step) => step.server ?? [])
    .map((frame) => JSON.stringify(frame))
  const typescript = (text) => canonicalString(parse(text))
  const expected = frames.map(typescript)
  assert.deepEqual(frames.map(client.canonicalEjson), expected)
  const scan = (codec) => () => {
    let size = 0
    for (const frame of frames) size += codec(frame).length
    return size
  }
  const operations = [scan(typescript), scan(client.canonicalEjson)]
  for (const operation of operations) {
    for (let iteration = 0; iteration < 100; iteration++) operation()
  }
  measure(
    `canonical EJSON (${frames.length} frames)`,
    "us/frame",
    operations,
    expected.reduce((size, frame) => size + frame.length, 0),
    1000,
    frames.length,
  )
}
