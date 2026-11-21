import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
  type Baseline,
  check,
  newBaseline,
  type Run,
  readBaseline,
  readGate,
} from "../scripts/gate.ts"

const run = (
  ratios: Record<string, number>,
  required: Record<string, { value: number; min: number }> = {},
): Run => ({ gate: { ratios, required }, source: "test" })

const baseline = (
  ratios: Record<string, number>,
  floors: Record<string, number> = {},
): Baseline => ({ source: "test", ratios, floors })

describe("floors", () => {
  it("fails a ratio below its floor even when the tolerance would admit it", () => {
    const outcome = check([run({ speedup: 2.9 })], baseline({}, { speedup: 3 }), {
      tolerance: 0.25,
    })
    expect(outcome.failures).toBe(1)
    expect(outcome.lines.some((line) => line.includes("BELOW") && line.includes("speedup"))).toBe(
      true,
    )
  })

  it("applies no tolerance when the ratio also has a baseline", () => {
    const outcome = check([run({ speedup: 2.5 })], baseline({ speedup: 3 }, { speedup: 3 }), {
      tolerance: 0.25,
    })
    expect(outcome.failures).toBe(1)
  })

  it("passes a ratio at or above its floor", () => {
    expect(
      check([run({ speedup: 3 })], baseline({}, { speedup: 3 }), { tolerance: 0 }).failures,
    ).toBe(0)
    expect(
      check([run({ speedup: 3.2 })], baseline({}, { speedup: 3 }), { tolerance: 0 }).failures,
    ).toBe(0)
  })

  it("judges the median of the runs, so one lucky run cannot carry a floor", () => {
    const runs = [run({ speedup: 2 }), run({ speedup: 3.5 }), run({ speedup: 2.5 })]
    expect(check(runs, baseline({}, { speedup: 3 }), { tolerance: 0.25 }).failures).toBe(1)
    const passing = [run({ speedup: 2 }), run({ speedup: 3.5 }), run({ speedup: 3.1 })]
    expect(check(passing, baseline({}, { speedup: 3 }), { tolerance: 0.25 }).failures).toBe(0)
  })

  it("takes the mean of the two middle runs for an even count", () => {
    const runs = [run({ speedup: 2.8 }), run({ speedup: 3.1 })]
    expect(check(runs, baseline({}, { speedup: 3 }), { tolerance: 0 }).failures).toBe(1)
  })

  it("never prints a ratio that misses its floor as reaching it", () => {
    const outcome = check([run({ speedup: 2.9999 })], baseline({}, { speedup: 3 }), {
      tolerance: 0,
    })
    expect(outcome.failures).toBe(1)
    expect(outcome.lines[0]).toContain("2.999")
  })

  it("fails a floored ratio that no run measured", () => {
    const outcome = check([run({ other: 5 })], baseline({}, { speedup: 3 }), { tolerance: 0.25 })
    expect(outcome.failures).toBe(1)
    expect(outcome.lines.some((line) => line.includes("MISSING") && line.includes("speedup"))).toBe(
      true,
    )
  })

  it("still fails floors and required values with reportRatios", () => {
    const outcome = check(
      [run({ speedup: 2, ratio: 0.1 }, { delivered: { value: 0.5, min: 1 } })],
      baseline({ ratio: 1 }, { speedup: 3 }),
      { tolerance: 0.25, reportRatios: true },
    )
    expect(outcome.failures).toBe(2)
  })
})

describe("ratios against a baseline", () => {
  it("fails more than the tolerance below the baseline and passes within it", () => {
    expect(check([run({ r: 0.74 })], baseline({ r: 1 }), { tolerance: 0.25 }).failures).toBe(1)
    expect(check([run({ r: 0.76 })], baseline({ r: 1 }), { tolerance: 0.25 }).failures).toBe(0)
  })

  it("judges the best of the runs", () => {
    const runs = [run({ r: 0.5 }), run({ r: 0.8 })]
    expect(check(runs, baseline({ r: 1 }), { tolerance: 0.25 }).failures).toBe(0)
  })

  it("reports without failing under reportRatios", () => {
    const outcome = check([run({ r: 0.1 })], baseline({ r: 1 }), {
      tolerance: 0.25,
      reportRatios: true,
    })
    expect(outcome.failures).toBe(0)
    expect(outcome.lines[0]).toContain("lower")
  })

  it("reports a ratio with no baseline and does not fail it", () => {
    const outcome = check([run({ fresh: 0.01 })], baseline({}), { tolerance: 0.25 })
    expect(outcome.failures).toBe(0)
    expect(outcome.lines[0]).toContain("new")
  })

  it("rejects a tolerance outside 0 to 1", () => {
    expect(() => check([], baseline({}), { tolerance: 1 })).toThrow()
    expect(() => check([], baseline({}), { tolerance: Number.NaN })).toThrow()
  })
})

describe("required values", () => {
  it("must hold in every run", () => {
    const runs = [
      run({}, { delivered: { value: 1, min: 1 } }),
      run({}, { delivered: { value: 0.99, min: 1 } }),
    ]
    expect(check(runs, baseline({}), { tolerance: 0.25 }).failures).toBe(1)
  })
})

describe("reading files", () => {
  it("rejects a results file without a gate or with a ratio that is not finite", () => {
    expect(() => readGate({}, "x.json")).toThrow(/no gate/)
    expect(() => readGate({ gate: { ratios: { r: Number.POSITIVE_INFINITY } } }, "x.json")).toThrow(
      /finite/,
    )
    expect(() => readGate({ gate: { required: { r: { value: 1 } } } }, "x.json")).toThrow(/min/)
  })

  it("keeps the unrounded ratio, so rounding cannot lift it over a floor", () => {
    expect(readGate({ gate: { ratios: { r: 2.9996 } } }, "x.json").gate.ratios["r"]).toBe(2.9996)
  })

  it("rejects floors that are not positive numbers", () => {
    expect(() => readBaseline({ ratios: {}, floors: { r: "3" } }, "b.json")).toThrow(/floor/)
    expect(() => readBaseline({ ratios: {}, floors: { r: 0 } }, "b.json")).toThrow(/floor/)
    expect(readBaseline({ ratios: { r: 1 } }, "b.json").floors).toEqual({})
  })
})

describe("new baselines", () => {
  it("take the lowest run, round to three decimals and keep the previous floors", () => {
    const written = newBaseline(
      [run({ r: 0.81234, speedup: 3.4 }), run({ r: 0.7, speedup: 3.2 })],
      baseline({ r: 1 }, { speedup: 3 }),
    )
    expect(written.ratios).toEqual({ r: 0.7 })
    expect(written.floors).toEqual({ speedup: 3 })
    expect(written.source).toContain("lowest of 2 runs")
  })
})

describe("the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "canopy-bench-gate-"))
  const script = fileURLToPath(new URL("../scripts/bench-gate.ts", import.meta.url))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const gate = (ratio: number, ...args: string[]): number => {
    const results = join(dir, `results-${ratio}.json`)
    writeFileSync(
      results,
      JSON.stringify({ runtime: "test", gate: { ratios: { speedup: ratio } } }),
    )
    const file = join(dir, "baseline.json")
    writeFileSync(file, JSON.stringify({ source: "test", ratios: {}, floors: { speedup: 3 } }))
    const child = spawnSync(process.execPath, [script, results, ...args, "--baseline", file], {
      encoding: "utf8",
    })
    return child.status ?? -1
  }

  it("exits 1 below a floor and 0 above it", () => {
    expect(gate(2.4)).toBe(1)
    expect(gate(3.1)).toBe(0)
  })

  it("writes a baseline that keeps the floors", () => {
    const file = join(dir, "written.json")
    writeFileSync(file, JSON.stringify({ source: "old", ratios: {}, floors: { speedup: 3 } }))
    const results = join(dir, "write.json")
    writeFileSync(results, JSON.stringify({ gate: { ratios: { speedup: 3.3, r: 0.5 } } }))
    const child = spawnSync(process.execPath, [script, results, "--write-baseline", file])
    expect(child.status).toBe(0)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      source: "unknown runtime",
      ratios: { r: 0.5 },
      floors: { speedup: 3 },
    })
  })
})
