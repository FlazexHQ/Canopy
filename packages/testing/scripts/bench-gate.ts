import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { check, newBaseline, readBaseline, readGate } from "./gate.ts"

/**
 * Gates a benchmark on the `gate` section of its results file, as written by `packages/matcher/bench/
 * throughput.ts`, `packages/matcher/bench/event-cost.ts` and `packages/realtime/bench/fanout.ts`:
 *
 *   { "gate": { "ratios": { "<name>": 0.42 }, "required": { "<name>": { "value": 1, "min": 1 } } } }
 *
 * Ratios compare Canopy with a reference measured in the same run (hand written predicates, a plain change
 * stream, the other engine), so the speed of the runner does not matter; higher is better. The baseline gives
 * each ratio either a committed value it may not fall more than `--tolerance` (default 0.25) below, judged on
 * the best of the runs, or a floor (`floors`) it must reach with no tolerance, judged on the median of the
 * runs, for requirements such as "the Rust matcher at least 3 times the TypeScript matcher". A ratio in the
 * baseline that no run measured fails. Required values must reach their `min` in every run, for properties
 * that must hold exactly (every change delivered). `--report-ratios` reports ratios below their baseline
 * without failing, for runs the baseline was not measured for (another engine); floors and required values
 * still fail.
 *
 * A new baseline takes the lowest value of each ratio across the runs, so it is not set by a lucky run, and
 * keeps the floors of the file it replaces.
 *
 *   node bench-gate.ts <results.json>... --baseline <baseline.json> [--tolerance 0.25] [--report-ratios]
 *   node bench-gate.ts <results.json>... --write-baseline <baseline.json>
 */
async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"))
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      tolerance: { type: "string", default: "0.25" },
      "report-ratios": { type: "boolean", default: false },
      "write-baseline": { type: "string" },
    },
  })
  if (positionals.length === 0) throw new Error("Pass the results file of a benchmark")
  const runs = await Promise.all(
    positionals.map(async (file) => readGate(await readJson(file), file)),
  )
  const target = values["write-baseline"]
  if (target !== undefined) {
    let previous: ReturnType<typeof readBaseline> | undefined
    try {
      previous = readBaseline(await readJson(target), target)
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    const { source, ratios, floors } = newBaseline(runs, previous)
    const written =
      Object.keys(floors).length === 0 ? { source, ratios } : { source, ratios, floors }
    await writeFile(target, `${JSON.stringify(written, null, 2)}\n`)
    process.stdout.write(`baseline written to ${target}\n`)
    return 0
  }
  const baselineFile = values.baseline
  if (baselineFile === undefined) throw new Error("Pass --baseline or --write-baseline")
  const baseline = readBaseline(await readJson(baselineFile), baselineFile)
  process.stdout.write(`${runs.map((run) => run.source).join("; ")}\n`)
  const outcome = check(runs, baseline, {
    tolerance: Number(values.tolerance),
    reportRatios: values["report-ratios"],
  })
  process.stdout.write(`${outcome.lines.join("\n")}\n`)
  return outcome.failures === 0 ? 0 : 1
}

process.exitCode = await main()
