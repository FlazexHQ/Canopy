import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

/**
 * Gates a `cargo mutants` run on its mutation score, as Stryker's `break` threshold gates the TypeScript
 * packages. The score is the share of viable mutants the tests detect: caught and timed out mutants over
 * caught, timed out and missed ones (unviable mutants do not build and do not count). Prints every missed
 * mutant, so a run that passes still lists the gaps.
 *
 *   node mutants-gate.ts <mutants.out folder> --break <percent>
 */
interface Outcomes {
  readonly caught: number
  readonly missed: number
  readonly timeout: number
  readonly unviable: number
  readonly outcomes: readonly { readonly scenario: unknown; readonly summary: string }[]
}

function isOutcomes(value: unknown): value is Outcomes {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    ["caught", "missed", "timeout", "unviable"].every((key) => typeof record[key] === "number") &&
    Array.isArray(record["outcomes"])
  )
}

function mutantName(scenario: unknown): string {
  if (typeof scenario !== "object" || scenario === null) return String(scenario)
  const mutant = (scenario as { Mutant?: { name?: unknown } }).Mutant
  return typeof mutant?.name === "string" ? mutant.name : JSON.stringify(scenario)
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { break: { type: "string" } },
  })
  const folder = positionals[0]
  const threshold = Number(values.break)
  if (folder === undefined || values.break === undefined || !Number.isFinite(threshold)) {
    throw new Error("Usage: mutants-gate.ts <mutants.out folder> --break <percent>")
  }
  const parsed: unknown = JSON.parse(await readFile(join(folder, "outcomes.json"), "utf8"))
  if (!isOutcomes(parsed)) throw new Error(`${folder}/outcomes.json is not a cargo mutants report`)
  const detected = parsed.caught + parsed.timeout
  const viable = detected + parsed.missed
  if (viable === 0) {
    process.stdout.write("No viable mutants were tested\n")
    return 1
  }
  for (const outcome of parsed.outcomes) {
    if (outcome.summary === "MissedMutant")
      process.stdout.write(`missed: ${mutantName(outcome.scenario)}\n`)
  }
  const score = (detected / viable) * 100
  process.stdout.write(
    `${String(detected)} of ${String(viable)} viable mutants detected (${score.toFixed(1)} %), ` +
      `${String(parsed.unviable)} unviable; break at ${String(threshold)} %\n`,
  )
  return score >= threshold ? 0 : 1
}

process.exitCode = await main()
