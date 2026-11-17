import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"

/**
 * Gates a benchmark on the `gate` section of its results file, as written by `packages/matcher/bench/
 * throughput.ts` and `packages/realtime/bench/fanout.ts`:
 *
 *   { "gate": { "ratios": { "<name>": 0.42 }, "required": { "<name>": { "value": 1, "min": 1 } } } }
 *
 * Ratios compare Canopy with a reference measured in the same run (hand written predicates, a plain change
 * stream), so the speed of the runner does not matter; higher is better. A ratio fails when it falls more
 * than `--tolerance` (default 0.25) below its committed baseline, or when a run did not measure it. Required values fail below their `min`
 * whatever the baseline says, for properties that must hold exactly (every change delivered).
 *
 * Given several results files (repeated runs), a check takes the best value of each ratio, so one noisy run
 * does not fail the gate, while a new baseline takes the lowest, so it is not set by a lucky run. Required
 * values must hold in every run.
 *
 *   node bench-gate.ts <results.json>... --baseline <baseline.json> [--tolerance 0.25]
 *   node bench-gate.ts <results.json>... --write-baseline <baseline.json>
 */
interface Gate {
  readonly ratios: Readonly<Record<string, number>>
  readonly required: Readonly<Record<string, { readonly value: number; readonly min: number }>>
}

interface Baseline {
  readonly source: string
  readonly ratios: Readonly<Record<string, number>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readGate(results: unknown, file: string): { gate: Gate; source: string } {
  if (!isRecord(results) || !isRecord(results["gate"]))
    throw new Error(`${file} has no gate section`)
  const gate = results["gate"]
  const ratios: Record<string, number> = {}
  const required: Record<string, { value: number; min: number }> = {}
  for (const [name, value] of Object.entries(isRecord(gate["ratios"]) ? gate["ratios"] : {})) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${file}: the ratio "${name}" is not a finite number`)
    ratios[name] = Math.round(value * 1000) / 1000
  }
  for (const [name, entry] of Object.entries(isRecord(gate["required"]) ? gate["required"] : {})) {
    if (!isRecord(entry) || typeof entry["value"] !== "number" || typeof entry["min"] !== "number")
      throw new Error(`${file}: the required value "${name}" needs a value and a min`)
    required[name] = { value: entry["value"], min: entry["min"] }
  }
  const runtime = typeof results["runtime"] === "string" ? results["runtime"] : "unknown runtime"
  const mongodb = typeof results["mongodb"] === "string" ? `, MongoDB ${results["mongodb"]}` : ""
  return { gate: { ratios, required }, source: `${runtime}${mongodb}` }
}

function readBaseline(value: unknown, file: string): Baseline {
  if (!isRecord(value) || !isRecord(value["ratios"])) throw new Error(`${file} is not a baseline`)
  const ratios: Record<string, number> = {}
  for (const [name, ratio] of Object.entries(value["ratios"]))
    if (typeof ratio === "number") ratios[name] = ratio
  return { source: typeof value["source"] === "string" ? value["source"] : "", ratios }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      tolerance: { type: "string", default: "0.25" },
      "write-baseline": { type: "string" },
    },
  })
  if (positionals.length === 0) throw new Error("Pass the results file of a benchmark")
  const runs = await Promise.all(
    positionals.map(async (file) => readGate(JSON.parse(await readFile(file, "utf8")), file)),
  )
  const target = values["write-baseline"]
  const pick = target === undefined ? Math.max : Math.min
  const ratios: Record<string, number> = {}
  const required: Record<string, { value: number; min: number }> = {}
  for (const { gate } of runs) {
    for (const [name, ratio] of Object.entries(gate.ratios))
      ratios[name] = name in ratios ? pick(ratios[name] ?? ratio, ratio) : ratio
    for (const [name, entry] of Object.entries(gate.required)) {
      const seen = required[name]
      if (seen === undefined || entry.value < seen.value) required[name] = entry
    }
  }
  const gate: Gate = { ratios, required }
  const source = `${runs[0]?.source ?? "unknown"}${runs.length > 1 ? `, lowest of ${runs.length} runs` : ""}`
  if (target !== undefined) {
    const baseline: Baseline = { source, ratios: gate.ratios }
    await writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`)
    process.stdout.write(`baseline written to ${target}\n`)
    return 0
  }
  const baselineFile = values.baseline
  if (baselineFile === undefined) throw new Error("Pass --baseline or --write-baseline")
  const baseline = readBaseline(JSON.parse(await readFile(baselineFile, "utf8")), baselineFile)
  const tolerance = Number(values.tolerance)
  if (!(tolerance >= 0 && tolerance < 1)) throw new Error("--tolerance must be from 0 to 1")
  let failures = 0
  for (const [name, { value, min }] of Object.entries(gate.required)) {
    const ok = value >= min
    if (!ok) failures += 1
    process.stdout.write(`  ${ok ? "ok      " : "FAILED  "} ${name}: ${value} (at least ${min})\n`)
  }
  for (const [name, ratio] of Object.entries(gate.ratios)) {
    const floor = baseline.ratios[name]
    if (floor === undefined) {
      process.stdout.write(`  new      ${name}: ${ratio.toFixed(3)} (no baseline)\n`)
      continue
    }
    const ok = ratio >= floor * (1 - tolerance)
    if (!ok) failures += 1
    process.stdout.write(
      `  ${ok ? "ok      " : "REGRESSED"} ${name}: ${ratio.toFixed(3)} (baseline ${floor.toFixed(3)})\n`,
    )
  }
  for (const name of Object.keys(baseline.ratios))
    if (!(name in gate.ratios)) {
      failures += 1
      process.stdout.write(`  MISSING  ${name}: in the baseline but not measured\n`)
    }
  process.stdout.write(
    failures === 0
      ? `every gate passed (tolerance ${tolerance * 100}%)\n`
      : `${failures} gate(s) failed\n`,
  )
  return failures === 0 ? 0 : 1
}

process.exitCode = await main()
