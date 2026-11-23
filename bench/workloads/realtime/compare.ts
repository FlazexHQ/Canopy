import { readFile, writeFile } from "node:fs/promises"

/**
 * Compares `fanout.ts` results across engines: for each scenario, the median over the runs of each engine of
 * the delivery latency, the engine time per event and the CPU use, and the ratio of each engine to `ts`. It
 * only reports, so a run on a new engine shows where it stands without a target to gate on.
 *
 *   node compare.ts <fanout results.json>... [--out <comparison.json>]
 */
interface Scenario {
  readonly name: string
  readonly delivery: { readonly p50: number; readonly p99: number }
  readonly engineMs: number
  readonly cpuPercent: number
}

const METRICS = {
  "delivery p50 ms": (s: Scenario) => s.delivery.p50,
  "delivery p99 ms": (s: Scenario) => s.delivery.p99,
  "engine ms per event": (s: Scenario) => s.engineMs,
  "cpu %": (s: Scenario) => s.cpuPercent,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function scenarios(value: unknown, file: string): { engine: string; results: Scenario[] } {
  if (!isRecord(value) || !Array.isArray(value["results"]))
    throw new Error(`${file} is not a fanout results file`)
  const engine = typeof value["engine"] === "string" ? value["engine"] : "ts"
  const results = value["results"].map((entry: unknown): Scenario => {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      !isRecord(entry["delivery"]) ||
      typeof entry["delivery"]["p50"] !== "number" ||
      typeof entry["delivery"]["p99"] !== "number" ||
      typeof entry["engineMs"] !== "number" ||
      typeof entry["cpuPercent"] !== "number"
    )
      throw new Error(`${file} has a malformed scenario`)
    return {
      name: entry["name"],
      delivery: { p50: entry["delivery"]["p50"], p99: entry["delivery"]["p99"] },
      engineMs: entry["engineMs"],
      cpuPercent: entry["cpuPercent"],
    }
  })
  return { engine, results }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2
}

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const out = outIndex === -1 ? undefined : args[outIndex + 1]
const files = args.filter((_, i) => i !== outIndex && i !== outIndex + 1)
if (files.length === 0) throw new Error("Pass the results files of fanout.ts")

const byEngine = new Map<string, Map<string, Scenario[]>>()
for (const file of files) {
  const { engine, results } = scenarios(JSON.parse(await readFile(file, "utf8")), file)
  const engineRuns = byEngine.get(engine) ?? new Map<string, Scenario[]>()
  byEngine.set(engine, engineRuns)
  for (const result of results)
    engineRuns.set(result.name, [...(engineRuns.get(result.name) ?? []), result])
}

const comparison: Record<string, Record<string, Record<string, number>>> = {}
const reference = byEngine.get("ts")
for (const [engine, runs] of byEngine) {
  for (const [name, results] of runs) {
    const row: Record<string, number> = {}
    for (const [metric, read] of Object.entries(METRICS)) {
      const value = median(results.map(read))
      row[metric] = value
      const base = reference?.get(name)
      if (engine !== "ts" && base !== undefined)
        row[`${metric} ÷ ts`] = value / median(base.map(read))
    }
    comparison[name] = { ...comparison[name], [engine]: row }
  }
}

for (const [name, engines] of Object.entries(comparison)) {
  process.stdout.write(`${name}\n`)
  for (const [engine, row] of Object.entries(engines)) {
    const cells = Object.entries(row).map(([metric, value]) => `${metric} ${value.toFixed(2)}`)
    process.stdout.write(`  ${engine.padEnd(7)} ${cells.join(", ")}\n`)
  }
}
if (out !== undefined) await writeFile(out, `${JSON.stringify(comparison, null, 2)}\n`)
