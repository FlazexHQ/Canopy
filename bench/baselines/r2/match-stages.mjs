import { benchDocument } from "../../workloads/matcher/scenarios.ts"

const count = 1000
const scans = 10

function measure(prepare, reverse) {
  const samples = []
  for (let pass = 0; pass < 18; pass += 1) {
    const batch = Array.from({ length: scans }, prepare)
    if (reverse) batch.reverse()
    const start = performance.now()
    const results = batch.map(({ run }) => run())
    const ns = ((performance.now() - start) * 1e6) / (count * scans)
    for (const [index, { finish }] of batch.entries()) finish?.(results[index])
    if (pass >= 3) samples.push(ns)
  }
  return Math.min(...samples)
}

// Isolated stages for the slot buffer baseline. The pinned glue uses export2 and export3 for allocation.
export function matchStages(binding, wasm, encodeDocument, reverse) {
  const documents = Array.from({ length: count }, (_, index) => benchDocument(index))
  const parts = documents.map(encodeDocument)
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  function join() {
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }
    return joined.subarray(0, offset)
  }
  join()
  const cache = new binding.DocumentCache()
  const filter = binding.Filter.fromBson(encodeDocument({ ownerId: "u42" }))
  const slots = cache.retain(joined)
  function verify(decisions) {
    if (decisions.length !== count) throw new Error("Wrong decision count")
    for (const [index, doc] of documents.entries()) {
      if (decisions[index] !== Number(doc.ownerId === "u42")) throw new Error("Wrong decision")
    }
  }
  const stages = {
    encode: () => ({ run: () => documents.map(encodeDocument) }),
    join: () => ({ run: join }),
    copy: () => ({
      run() {
        const ptr = wasm.__wbindgen_export2(joined.length, 1) >>> 0
        new Uint8Array(wasm.memory.buffer).set(joined, ptr)
        return ptr
      },
      finish: (ptr) => wasm.__wbindgen_export3(ptr, joined.length, 1),
    }),
    retainWithCopy: () => ({
      run: () => cache.retain(joined),
      finish: (added) => cache.release(added),
    }),
    seen: () => {
      const keys = documents.map((doc) => ({ ...doc }))
      const seen = new WeakSet()
      return {
        run: () => {
          for (const key of keys) seen.add(key)
        },
      }
    },
    slots: () => {
      const keys = documents.map((doc) => ({ ...doc }))
      const slotsByKey = new WeakMap()
      const registry = new FinalizationRegistry(() => {})
      return {
        run() {
          for (const [index, key] of keys.entries()) {
            slotsByKey.set(key, slots[index])
            registry.register(key, slots[index])
          }
        },
      }
    },
    firstMatchWithCopy: () => ({ run: () => filter.matchConcatenated(joined), finish: verify }),
    ownedMatch: () => ({ run: () => cache.matchFilter(filter, slots), finish: verify }),
  }
  try {
    const entries = Object.entries(stages)
    if (reverse) entries.reverse()
    const result = Object.fromEntries(
      entries.map(([name, prepare]) => [name, measure(prepare, reverse)]),
    )
    return {
      ...result,
      retainNetCopy: result.retainWithCopy - result.copy,
      firstMatchNetCopy: result.firstMatchWithCopy - result.copy,
    }
  } finally {
    filter.free()
    cache.free()
  }
}
