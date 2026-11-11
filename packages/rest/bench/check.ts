import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

/**
 * Guards the gains of the scale benchmark. Reads the JSON that `scale.ts` writes (`CANOPY_BENCH_OUT`) and
 * compares each Canopy ÷ driver throughput ratio with the committed baseline. Ratios rather than absolute
 * numbers, so the speed of the runner does not matter. Fails when a ratio falls more than `--tolerance`
 * (default 0.2, that is 20%) below its baseline, and lists scenarios that have no baseline yet.
 *
 *   node bench/check.ts <results.json> [--baseline bench/baseline.json] [--tolerance 0.2]
 *   node bench/check.ts <results.json> --write-baseline bench/baseline.json
 */
interface Ratios {
  readonly [scenario: string]: { readonly reference: string; readonly ratio: number }
}

interface Results {
  readonly runtime: string
  readonly mongodb: string
  readonly tiers: readonly { readonly docs: number; readonly ratios?: Ratios }[]
}

interface Baseline {
  readonly source: string
  readonly tiers: Readonly<Record<string, Readonly<Record<string, number>>>>
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      tolerance: { type: "string", default: "0.2" },
      "write-baseline": { type: "string" },
    },
  })
  const [file] = positionals
  if (file === undefined) throw new Error("Pass the results file of scale.ts")
  const results = JSON.parse(await readFile(file, "utf8")) as Results
  const measured: Record<string, Record<string, number>> = {}
  for (const tier of results.tiers) {
    const ratios: Record<string, number> = {}
    for (const [scenario, entry] of Object.entries(tier.ratios ?? {}))
      ratios[scenario] = Math.round(entry.ratio * 1000) / 1000
    measured[String(tier.docs)] = ratios
  }
  const target = values["write-baseline"]
  if (target !== undefined) {
    const baseline: Baseline = {
      source: `${results.runtime}, MongoDB ${results.mongodb}`,
      tiers: measured,
    }
    await writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`)
    process.stdout.write(`baseline written to ${target}\n`)
    return 0
  }
  const tolerance = Number(values.tolerance)
  const baselineFile = values.baseline ?? fileURLToPath(new URL("baseline.json", import.meta.url))
  const baseline = JSON.parse(await readFile(baselineFile, "utf8")) as Baseline
  let failures = 0
  for (const [tier, ratios] of Object.entries(measured)) {
    const expected = baseline.tiers[tier] ?? {}
    for (const [scenario, ratio] of Object.entries(ratios)) {
      const floor = expected[scenario]
      if (floor === undefined) {
        process.stdout.write(`  new      ${tier} ${scenario}: ${ratio.toFixed(3)} (no baseline)\n`)
        continue
      }
      const ok = ratio >= floor * (1 - tolerance)
      if (!ok) failures += 1
      process.stdout.write(
        `  ${ok ? "ok      " : "REGRESSED"} ${tier} ${scenario}: ${ratio.toFixed(3)} (baseline ${floor.toFixed(3)})\n`,
      )
    }
  }
  process.stdout.write(
    failures === 0
      ? "every ratio is within the tolerance of its baseline\n"
      : `${failures} ratio(s) fell more than ${tolerance * 100}% below the baseline\n`,
  )
  return failures === 0 ? 0 : 1
}

process.exitCode = await main()
