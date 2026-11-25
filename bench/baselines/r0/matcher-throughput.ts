import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { deserialize } from "bson"
import { benchDocument, runtimeName, SCENARIOS } from "../../workloads/matcher/scenarios.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, "../../..")
const canopyJsDist = resolve(rootDir, "../Canopy.js/dist")

const fullMatcherModule = await import(
  pathToFileURL(resolve(canopyJsDist, "core/matcher/index.js")).href
)
const liteMatcherModule = await import(
  pathToFileURL(resolve(canopyJsDist, "core/matcher/lite.js")).href
)
const fullCompile = fullMatcherModule.compileFilter
const liteCompile = liteMatcherModule.compileFilter

// 1. Load conformance/matcher/filters.json
const filtersFile = JSON.parse(
  readFileSync(resolve(rootDir, "conformance/matcher/filters.json"), "utf8"),
)

const rawDocs: string[] = filtersFile.documents
const conformanceDocs = rawDocs.map((b64) =>
  deserialize(Buffer.from(b64, "base64"), { promoteValues: false, bsonRegExp: true }),
)

interface CompiledCase {
  compiled: { matches: (doc: unknown) => boolean }
  expectedMatches: number
}

const compiledFullCases: CompiledCase[] = []
const compiledLiteCases: CompiledCase[] = []

for (const c of filtersFile.cases) {
  if (c.matches === undefined) continue
  const filter = deserialize(Buffer.from(c.filter, "base64"), {
    promoteValues: false,
    bsonRegExp: true,
  })

  // Count expected matches from bitmask
  let expected = 0
  const mask = c.matches
  for (let i = 0; i < conformanceDocs.length; i++) {
    const byteIdx = (i >> 3) * 2
    const hex = mask.slice(byteIdx, byteIdx + 2)
    const val = Number.parseInt(hex, 16)
    if (((val >> (i & 7)) & 1) === 1) {
      expected++
    }
  }

  try {
    const full = fullCompile(filter)
    compiledFullCases.push({ compiled: full, expectedMatches: expected })
  } catch {}

  try {
    const lite = liteCompile(filter)
    compiledLiteCases.push({ compiled: lite, expectedMatches: expected })
  } catch {}
}

function measureConformance(
  cases: CompiledCase[],
  docs: unknown[],
  rounds = 5,
): {
  filterCount: number
  docCount: number
  totalEvaluationsPerPass: number
  matchedCount: number
  docsMatchedPerSec: number
  msPerPass: number
  nsPerDoc: number
} {
  const totalEvaluations = cases.length * docs.length

  // Warmup
  for (const c of cases) {
    for (const d of docs) {
      c.compiled.matches(d)
    }
  }

  let bestMs = Number.POSITIVE_INFINITY
  let lastMatched = 0

  for (let r = 0; r < rounds; r++) {
    let matched = 0
    const start = performance.now()
    for (const c of cases) {
      for (const d of docs) {
        if (c.compiled.matches(d)) matched++
      }
    }
    const elapsed = performance.now() - start
    if (elapsed < bestMs) {
      bestMs = elapsed
    }
    lastMatched = matched
  }

  const docsMatchedPerSec = Math.round(totalEvaluations / (bestMs / 1000))
  const nsPerDoc = (bestMs * 1e6) / totalEvaluations

  return {
    filterCount: cases.length,
    docCount: docs.length,
    totalEvaluationsPerPass: totalEvaluations,
    matchedCount: lastMatched,
    docsMatchedPerSec,
    msPerPass: bestMs,
    nsPerDoc,
  }
}

// 2. Measure on the 6 scenarios of scenarios.ts on 1,000 documents
const DOCS_COUNT_1K = 1000
const docs1k = Array.from({ length: DOCS_COUNT_1K }, (_, i) => benchDocument(i))

interface ScenarioResult {
  name: string
  docsMatchedPerSec: number
  nsPerDoc: number
  matched: number
  handWrittenRatio: number
}

const scenarioResults: Record<string, ScenarioResult> = {}

for (const [name, { filter, handWritten }] of Object.entries(SCENARIOS)) {
  const compiled = fullCompile(filter)

  // Warmup
  for (const d of docs1k) {
    compiled.matches(d)
    handWritten(d)
  }

  let bestCompiledMs = Number.POSITIVE_INFINITY
  let compiledMatched = 0
  for (let r = 0; r < 7; r++) {
    let matched = 0
    const start = performance.now()
    for (const d of docs1k) {
      if (compiled.matches(d)) matched++
    }
    const elapsed = performance.now() - start
    if (elapsed < bestCompiledMs) bestCompiledMs = elapsed
    compiledMatched = matched
  }

  let bestRefMs = Number.POSITIVE_INFINITY
  let _refMatched = 0
  for (let r = 0; r < 7; r++) {
    let matched = 0
    const start = performance.now()
    for (const d of docs1k) {
      if (handWritten(d)) matched++
    }
    const elapsed = performance.now() - start
    if (elapsed < bestRefMs) bestRefMs = elapsed
    _refMatched = matched
  }

  const docsMatchedPerSec = Math.round(DOCS_COUNT_1K / (bestCompiledMs / 1000))
  const nsPerDoc = (bestCompiledMs * 1e6) / DOCS_COUNT_1K
  const handWrittenRatio = bestRefMs / bestCompiledMs

  scenarioResults[name] = {
    name,
    docsMatchedPerSec,
    nsPerDoc,
    matched: compiledMatched,
    handWrittenRatio,
  }
}

const fullConformance = measureConformance(compiledFullCases, conformanceDocs)
const liteConformance = measureConformance(compiledLiteCases, conformanceDocs)

const report = {
  runtime: runtimeName(),
  conformance: {
    full: fullConformance,
    lite: liteConformance,
  },
  scenarios_1k: scenarioResults,
}

const outFile = process.env["CANOPY_MATCHER_OUT"]
if (outFile) {
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`)
}
