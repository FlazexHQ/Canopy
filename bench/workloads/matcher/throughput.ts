import { writeFile } from "node:fs/promises"
import { compileFilter, compileSort, compileSortKeys } from "@canopy/matcher"
import { type BenchDocument, benchDocument, runtimeName, SCENARIOS } from "./scenarios.ts"

/**
 * In process matcher throughput: compiles representative filters once and evaluates them against an
 * in memory array of documents, the work realtime does for every change event and candidate observer.
 *
 * Each filter also runs as a hand written predicate over the same documents. The matched counts must be
 * equal, and the compiled ÷ hand written speed is the ratio `packages/testing/scripts/bench-gate.ts`
 * compares with `bench/baselines/matcher/baseline.json`, so the gate does not depend on the speed of the runner.
 *
 * Environment: `CANOPY_BENCH_DOCS` (default 1000000) and `CANOPY_BENCH_OUT`.
 */
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "1000000")
const OUT = process.env["CANOPY_BENCH_OUT"]
const docs = Array.from({ length: DOCS }, (_, i) => benchDocument(i))

/** The best of three timed passes over every document, after a warm up pass. */
function time(matches: (doc: BenchDocument) => boolean): { ms: number; matched: number } {
  for (const doc of docs.slice(0, 100_000)) matches(doc)
  let best = Number.POSITIVE_INFINITY
  let matched = 0
  for (let round = 0; round < 3; round += 1) {
    matched = 0
    const start = performance.now()
    for (const doc of docs) if (matches(doc)) matched += 1
    best = Math.min(best, performance.now() - start)
  }
  return { ms: best, matched }
}

const results: {
  name: string
  evalsPerSecond: number
  nsPerEval: number
  matched: number
  nativeMatched: number
  ratio: number
}[] = []
for (const [name, { filter, handWritten }] of Object.entries(SCENARIOS)) {
  const compiled = compileFilter(filter)
  const measured = time((doc) => compiled.matches(doc))
  const reference = time(handWritten)
  const evalsPerSecond = Math.round(DOCS / (measured.ms / 1000))
  const ratio = reference.ms / measured.ms
  results.push({
    name,
    evalsPerSecond,
    nsPerEval: (measured.ms * 1e6) / DOCS,
    matched: measured.matched,
    nativeMatched: reference.matched,
    ratio,
  })
  process.stderr.write(
    `${name.padEnd(28)} ${(evalsPerSecond / 1e6).toFixed(2)} M evals/s, ${measured.matched} matched (hand written ${reference.matched}), ${(ratio * 100).toFixed(0)}% of hand written speed\n`,
  )
}

const compileStart = performance.now()
const compileRounds = 100_000
for (let i = 0; i < compileRounds; i += 1)
  compileFilter({ ownerId: `u${i}`, amount: { $gte: i % 100 } })
const compileMicros = ((performance.now() - compileStart) * 1000) / compileRounds

const sortDocs = docs.slice(0, Math.min(DOCS, 200_000))
const comparator = compileSort({ amount: -1 })
const comparatorStart = performance.now()
;[...sortDocs].sort(comparator)
const comparatorMs = performance.now() - comparatorStart
const keyed = compileSortKeys({ amount: -1 })
const sortStart = performance.now()
keyed.sort([...sortDocs])
const sortMs = performance.now() - sortStart

const runtime = runtimeName()
const gate = {
  ratios: Object.fromEntries(results.map((result) => [`matcher ${result.name}`, result.ratio])),
  required: Object.fromEntries(
    results.map((result) => [
      `matcher ${result.name} agrees with the hand written predicate`,
      { value: result.matched === result.nativeMatched ? 1 : 0, min: 1 },
    ]),
  ),
}
const text = `${JSON.stringify({ runtime, docs: DOCS, results, compileMicros, sort: { docs: sortDocs.length, ms: sortMs, comparatorMs }, gate }, null, 2)}\n`
process.stderr.write(
  `compile ${compileMicros.toFixed(2)} us per filter, sort ${sortDocs.length}: ${sortMs.toFixed(0)} ms with keys, ${comparatorMs.toFixed(0)} ms with a comparator\n`,
)
if (OUT === undefined) process.stdout.write(text)
else await writeFile(OUT, text)
