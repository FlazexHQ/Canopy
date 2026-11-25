import { benchDocument, SCENARIOS } from "../../workloads/matcher/scenarios.ts"
import { compileFilter as fullFilter } from "./reference/matcher/index.ts"
import { compileFilter as liteFilter } from "./reference/matcher/lite.ts"
import { applyUpdate } from "./reference/matcher/update-lite.ts"

const documentCount = 1000
const scansPerPass = 10
const updatesPerBatch = 200

function measure(typescript, wasm, { passes, operations, scale, summarize, reverse }) {
  const samples = { typescript: [], wasm: [] }
  const implementations = reverse
    ? [
        ["wasm", wasm],
        ["typescript", typescript],
      ]
    : [
        ["typescript", typescript],
        ["wasm", wasm],
      ]

  for (const [, prepare] of implementations) {
    for (let warmup = 0; warmup < 3; warmup += 1) prepare()()
  }
  for (let pass = 0; pass < passes; pass += 1) {
    for (let offset = 0; offset < implementations.length; offset += 1) {
      const [name, prepare] = implementations[(pass + offset) % implementations.length]
      const run = prepare()
      const start = performance.now()
      run()
      samples[name].push(((performance.now() - start) * scale) / operations)
    }
  }
  const ts = summarize(samples.typescript)
  const rust = summarize(samples.wasm)
  if (!(ts > 0 && rust > 0)) throw new Error("Timing resolution is too low")
  return { typescript: ts, wasm: rust, ratio: rust / ts }
}

function median(samples) {
  const sorted = samples.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function scan(documents, mode, matches, expectedHits) {
  const batches = Array.from({ length: scansPerPass }, () =>
    mode === "cold" ? documents.map((_, index) => benchDocument(index)) : documents,
  )
  return () => {
    let hits = 0
    for (const batch of batches) hits += matches(batch)
    if (hits !== scansPerPass * expectedHits) throw new Error("Unexpected match count")
  }
}

function updateBatch(apply, document, spec, mode) {
  const chained = mode === "chained"
  return () => {
    const inputs =
      mode === "fresh"
        ? Array.from({ length: updatesPerBatch }, () => ({
            document: { ...document, tags: [...document.tags] },
            spec: { $set: { ...spec.$set }, $inc: { ...spec.$inc } },
          }))
        : undefined
    return () => {
      let result = document
      for (let index = 0; index < updatesPerBatch; index += 1) {
        const input = inputs?.[index]
        result = apply(input?.document ?? (chained ? result : document), input?.spec ?? spec)
      }
      const expected = chained ? document.n + updatesPerBatch : document.n + 1
      if (result.n !== expected || result.title !== "edited") {
        throw new Error("Unexpected optimistic update result")
      }
    }
  }
}

export function runWorkload(engine, reverse) {
  if (engine.kind !== "wasm") throw new Error(`Expected the Wasm engine, got ${engine.kind}`)
  const documents = Array.from({ length: documentCount }, (_, index) => benchDocument(index))
  const matchCold = {}
  const matchWarm = {}
  for (const [name, { filter, handWritten }] of Object.entries(SCENARIOS)) {
    const reference = name === "dotted path" ? "full" : "lite"
    const ts = (reference === "full" ? fullFilter : liteFilter)(filter)
    const rust = engine.compileFilter(filter)
    try {
      const expected = documents.map(handWritten)
      for (const decisions of [
        documents.map((doc) => ts.matches(doc)),
        rust.matchAll(documents),
        rust.matchAll(documents),
      ]) {
        if (decisions.length !== expected.length)
          throw new Error(`Wrong decision count for ${name}`)
        for (const [index, decision] of expected.entries()) {
          if (decisions[index] !== decision)
            throw new Error(`${name} disagrees for document ${index}`)
        }
      }
      const hits = expected.filter(Boolean).length
      for (const mode of reverse ? ["warm", "cold"] : ["cold", "warm"]) {
        const match = mode === "cold" ? matchCold : matchWarm
        match[name] = {
          reference,
          ...measure(
            () =>
              scan(
                documents,
                mode,
                (batch) => {
                  let count = 0
                  for (const doc of batch) count += Number(ts.matches(doc))
                  return count
                },
                hits,
              ),
            () =>
              scan(
                documents,
                mode,
                (batch) => {
                  let count = 0
                  for (const decision of rust.matchAll(batch)) count += Number(decision)
                  return count
                },
                hits,
              ),
            {
              passes: 15,
              operations: documentCount * scansPerPass,
              scale: 1e6,
              summarize: (samples) => Math.min(...samples),
              reverse,
            },
          ),
        }
      }
    } finally {
      rust.free()
    }
  }

  const document = {
    _id: "6728f0c2a1b2c3d4e5f60711",
    title: "a note",
    body: "some text in the note",
    n: 1,
    tags: ["a", "b"],
    public: true,
  }
  const spec = { $set: { title: "edited" }, $inc: { n: 1 } }
  const rustUpdate = (doc, update) => engine.applyUpdate(doc, update)
  const update = {}
  for (const mode of ["single", "chained", "fresh"]) {
    update[mode] = measure(
      updateBatch(applyUpdate, document, spec, mode),
      updateBatch(rustUpdate, document, spec, mode),
      { passes: 30, operations: updatesPerBatch, scale: 1000, summarize: median, reverse },
    )
  }
  return { matchCold, matchWarm, update }
}
