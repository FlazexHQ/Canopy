/** The `gate` section of one benchmark results file. */
interface Gate {
  /** Ratios where higher is better, measured against a reference in the same run. */
  readonly ratios: Readonly<Record<string, number>>
  /** Values that must reach their `min` in every run. */
  readonly required: Readonly<Record<string, { readonly value: number; readonly min: number }>>
}

/** The gate of one run and a description of where it ran. */
export interface Run {
  readonly gate: Gate
  readonly source: string
}

/** A committed baseline. */
export interface Baseline {
  readonly source: string
  /** Ratios a run may not fall below by more than the tolerance. */
  readonly ratios: Readonly<Record<string, number>>
  /** Absolute minimums of ratios, for requirements: no tolerance applies to them. */
  readonly floors: Readonly<Record<string, number>>
}

/** The lines a check prints and how many of its gates failed. */
export interface Outcome {
  readonly lines: readonly string[]
  readonly failures: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads the gate section of a results file. Throws when it is missing or malformed. */
export function readGate(results: unknown, file: string): Run {
  if (!isRecord(results) || !isRecord(results["gate"]))
    throw new Error(`${file} has no gate section`)
  const gate = results["gate"]
  const ratios: Record<string, number> = {}
  const required: Record<string, { value: number; min: number }> = {}
  for (const [name, value] of Object.entries(isRecord(gate["ratios"]) ? gate["ratios"] : {})) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${file}: the ratio "${name}" is not a finite number`)
    ratios[name] = value
  }
  for (const [name, entry] of Object.entries(isRecord(gate["required"]) ? gate["required"] : {})) {
    if (!isRecord(entry) || typeof entry["value"] !== "number" || typeof entry["min"] !== "number")
      throw new Error(`${file}: the required value "${name}" needs a value and a min`)
    required[name] = { value: entry["value"], min: entry["min"] }
  }
  const runtime = typeof results["runtime"] === "string" ? results["runtime"] : "unknown runtime"
  const engine = typeof results["engine"] === "string" ? `, engine ${results["engine"]}` : ""
  const mongodb = typeof results["mongodb"] === "string" ? `, MongoDB ${results["mongodb"]}` : ""
  return { gate: { ratios, required }, source: `${runtime}${engine}${mongodb}` }
}

function numbers(value: unknown, file: string, section: string): Record<string, number> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${file}: ${section} is not an object`)
  const out: Record<string, number> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0)
      throw new Error(`${file}: ${section} "${name}" is not a positive number`)
    out[name] = entry
  }
  return out
}

/** Reads a baseline file. `floors` is optional; every value must be a positive number. */
export function readBaseline(value: unknown, file: string): Baseline {
  if (!isRecord(value) || !isRecord(value["ratios"])) throw new Error(`${file} is not a baseline`)
  return {
    source: typeof value["source"] === "string" ? value["source"] : "",
    ratios: numbers(value["ratios"], file, "the ratio"),
    floors: numbers(value["floors"], file, "the floor"),
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2
}

function collect(runs: readonly Run[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const { gate } of runs)
    for (const [name, ratio] of Object.entries(gate.ratios)) {
      const seen = out.get(name)
      if (seen === undefined) out.set(name, [ratio])
      else seen.push(ratio)
    }
  return out
}

function worstRequired(runs: readonly Run[]): Record<string, { value: number; min: number }> {
  const out: Record<string, { value: number; min: number }> = {}
  for (const { gate } of runs)
    for (const [name, entry] of Object.entries(gate.required)) {
      const seen = out[name]
      if (seen === undefined || entry.value < seen.value) out[name] = entry
    }
  return out
}

/** Rounds down, so a ratio that misses its floor never prints as reaching it. */
const shown = (ratio: number): string => (Math.floor(ratio * 1000) / 1000).toFixed(3)

/**
 * Checks runs against a baseline. Required values must hold in every run. A ratio with a baseline takes its
 * best value across the runs (noise only slows a run down) and fails more than `tolerance` below the baseline.
 * A ratio with a floor takes its median across the runs, so one lucky run cannot carry a requirement, and fails
 * below the floor with no tolerance. A ratio in the baseline that no run measured fails. With `reportRatios`,
 * ratios below their baseline are reported but do not fail; floors and required values still do.
 */
export function check(
  runs: readonly Run[],
  baseline: Baseline,
  options: { readonly tolerance: number; readonly reportRatios?: boolean },
): Outcome {
  const { tolerance } = options
  if (!(tolerance >= 0 && tolerance < 1)) throw new Error("The tolerance must be from 0 to 1")
  const lines: string[] = []
  let failures = 0
  for (const [name, { value, min }] of Object.entries(worstRequired(runs))) {
    const ok = value >= min
    if (!ok) failures += 1
    lines.push(`  ${ok ? "ok       " : "FAILED   "} ${name}: ${value} (at least ${min})`)
  }
  const measured = collect(runs)
  for (const [name, values] of measured) {
    const reference = baseline.ratios[name]
    const floor = baseline.floors[name]
    if (floor !== undefined) {
      const value = median(values)
      const ok = value >= floor
      if (!ok) failures += 1
      lines.push(
        `  ${ok ? "ok       " : "BELOW    "} ${name}: ${shown(value)} (median of ${values.length}, at least ${floor})`,
      )
    }
    if (reference !== undefined) {
      const value = Math.max(...values)
      const ok = value >= reference * (1 - tolerance)
      if (!ok && options.reportRatios !== true) failures += 1
      const label = ok ? "ok       " : options.reportRatios === true ? "lower    " : "REGRESSED"
      lines.push(`  ${label} ${name}: ${shown(value)} (baseline ${reference.toFixed(3)})`)
    }
    if (floor === undefined && reference === undefined)
      lines.push(`  new       ${name}: ${shown(Math.max(...values))} (no baseline)`)
  }
  for (const name of new Set([...Object.keys(baseline.ratios), ...Object.keys(baseline.floors)]))
    if (!measured.has(name)) {
      failures += 1
      lines.push(`  MISSING   ${name}: in the baseline but not measured`)
    }
  lines.push(
    failures === 0
      ? `every gate passed (tolerance ${tolerance * 100}%)`
      : `${failures} gate(s) failed`,
  )
  return { lines, failures }
}

/**
 * The baseline a set of runs sets: the lowest value of each ratio across the runs (so a lucky run does not set
 * it), rounded to three decimals, keeping the floors of the previous baseline and leaving floored ratios out.
 */
export function newBaseline(runs: readonly Run[], previous: Baseline | undefined): Baseline {
  const floors = previous?.floors ?? {}
  const ratios: Record<string, number> = {}
  for (const [name, values] of collect(runs))
    if (!(name in floors)) ratios[name] = Math.round(Math.min(...values) * 1000) / 1000
  const first = runs[0]?.source ?? "unknown"
  return {
    source: `${first}${runs.length > 1 ? `, lowest of ${runs.length} runs` : ""}`,
    ratios,
    floors,
  }
}
