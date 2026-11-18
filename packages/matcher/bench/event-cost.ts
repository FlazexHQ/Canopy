import { writeFile } from "node:fs/promises"
import { arch, cpus, platform } from "node:os"
import { loadNativeEngine, type NativeEngine } from "@canopy/native"
import { deserialize, serialize } from "bson"
import { compileFilter } from "../src/index.ts"
import { benchDocument, runtimeName, SCENARIOS } from "./scenarios.ts"

/**
 * The matcher's cost per change event on each engine, in one process and over one set of BSON events (the
 * documents and filters of `scenarios.ts`), as the realtime engine receives them from the driver. `ts`
 * decodes each event with `deserialize(bytes, { promoteValues: false, bsonRegExp: true })` (exact BSON types,
 * as the engine reads events), then runs the TypeScript matcher. `rust per event` calls the Rust addon's
 * `matchesBson(bytes)` once per event. `rust matchMany` makes one call per batch with an array of its events,
 * and `rust batched` one `matchConcatenated` call per batch with its events laid end to end in one buffer,
 * the shape a batch of change events has on the wire.
 *
 * Every timed pass covers every event, and the engines run in a rotated order in each round, so neither the
 * order nor a slow moment favors one of them; each engine's figure is the median of its rounds. Every pass
 * must match exactly the events the TypeScript matcher matches.
 *
 * The `gate` section, checked by `packages/testing/scripts/bench-gate.ts` against `bench/event-baseline.json`,
 * holds the Rust over TypeScript ratio of events per second per scenario, per event (`rust per event ÷ ts`,
 * floored at 3) and batched (`rust batched ÷ ts`, reported). The WebAssembly build, when it loads, is measured
 * after the others and only reported: per event on the first `CANOPY_BENCH_WASM_EVENTS` events (default 20000,
 * since each call costs tens of microseconds), and batched on all of them.
 *
 * Environment: `CANOPY_BENCH_DOCS` (default 200000), `CANOPY_BENCH_ROUNDS` (default 7), `CANOPY_BENCH_BATCH`
 * (events per batch call, default 1000), `CANOPY_BENCH_WASM_EVENTS` and `CANOPY_BENCH_OUT`.
 */
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "200000")
const ROUNDS = Number(process.env["CANOPY_BENCH_ROUNDS"] ?? "7")
const BATCH = Number(process.env["CANOPY_BENCH_BATCH"] ?? "1000")
const WASM_EVENTS = Math.min(DOCS, Number(process.env["CANOPY_BENCH_WASM_EVENTS"] ?? "20000"))
const OUT = process.env["CANOPY_BENCH_OUT"]
const OPTIONS = { promoteValues: false, bsonRegExp: true }

for (const [name, value] of Object.entries({ DOCS, ROUNDS, BATCH, WASM_EVENTS }))
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a whole number from 1`)

const log = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

const events = Array.from({ length: DOCS }, (_, i) => new Uint8Array(serialize(benchDocument(i))))

interface Batches {
  readonly arrays: readonly Uint8Array[][]
  readonly joined: readonly Uint8Array[]
}

function batches(of: readonly Uint8Array[]): Batches {
  const arrays: Uint8Array[][] = []
  const joined: Uint8Array[] = []
  for (let start = 0; start < of.length; start += BATCH) {
    const slice = of.slice(start, start + BATCH)
    arrays.push(slice)
    const buffer = new Uint8Array(slice.reduce((total, bytes) => total + bytes.length, 0))
    let offset = 0
    for (const bytes of slice) {
      buffer.set(bytes, offset)
      offset += bytes.length
    }
    joined.push(buffer)
  }
  return { arrays, joined }
}

/** The matches in the one byte results of a batch call; an undecided result (2) is not a match. */
function countMatches(results: Uint8Array, undecided: { count: number }): number {
  let matched = 0
  for (const result of results) {
    if (result === 1) matched += 1
    else if (result !== 0) undecided.count += 1
  }
  return matched
}

/** One way of matching every event of a set, returning how many matched. */
interface Mode {
  readonly name: string
  readonly run: () => number
}

interface Measured {
  readonly events: number
  readonly matched: number
  readonly medianMs: number
  readonly bestMs: number
  readonly worstMs: number
  readonly eventsPerSecond: number
  readonly nsPerEvent: number
}

/**
 * Runs each mode once to warm it up and count its matches, then times `rounds` passes of every mode, rotating
 * which mode goes first in each round.
 */
function measure(modes: readonly Mode[], eventCount: number, rounds: number): Measured[] {
  const matched = modes.map((mode) => mode.run())
  const times = modes.map((): number[] => [])
  for (let round = 0; round < rounds; round += 1) {
    for (let step = 0; step < modes.length; step += 1) {
      const index = (round + step) % modes.length
      const mode = modes[index]
      if (mode === undefined) continue
      const start = performance.now()
      const count = mode.run()
      times[index]?.push(performance.now() - start)
      if (count !== matched[index])
        throw new Error(`${mode.name} matched ${count} events, then ${matched[index]}`)
    }
  }
  return modes.map((_, index) => {
    const sorted = [...(times[index] ?? [])].sort((x, y) => x - y)
    const middle = sorted.length / 2
    const medianMs =
      sorted.length % 2 === 1
        ? (sorted[Math.floor(middle)] ?? Number.NaN)
        : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2
    return {
      events: eventCount,
      matched: matched[index] ?? 0,
      medianMs,
      bestMs: sorted[0] ?? Number.NaN,
      worstMs: sorted.at(-1) ?? Number.NaN,
      eventsPerSecond: Math.round(eventCount / (medianMs / 1000)),
      nsPerEvent: (medianMs * 1e6) / eventCount,
    }
  })
}

function tsMode(filter: unknown, of: readonly Uint8Array[]): Mode {
  const compiled = compileFilter(filter)
  return {
    name: "ts",
    run: () => {
      let matched = 0
      for (const bytes of of) if (compiled.matches(deserialize(bytes, OPTIONS))) matched += 1
      return matched
    },
  }
}

function rustModes(
  engine: NativeEngine,
  filter: unknown,
  perEvent: readonly Uint8Array[],
  batched: Batches,
  undecided: { count: number },
): { perEvent: Mode; many: Mode; batched: Mode } {
  const compiled = engine.compileFilter(filter)
  return {
    perEvent: {
      name: `${engine.kind} per event`,
      run: () => {
        let matched = 0
        for (const bytes of perEvent) if (compiled.matchesBson(bytes)) matched += 1
        return matched
      },
    },
    many: {
      name: `${engine.kind} matchMany`,
      run: () => {
        let matched = 0
        for (const batch of batched.arrays)
          matched += countMatches(compiled.matchMany(batch), undecided)
        return matched
      },
    },
    batched: {
      name: `${engine.kind} batched`,
      run: () => {
        let matched = 0
        for (const buffer of batched.joined)
          matched += countMatches(compiled.matchConcatenated(buffer), undecided)
        return matched
      },
    },
  }
}

function loadOptional(kind: "wasm"): NativeEngine | undefined {
  try {
    return loadNativeEngine(kind)
  } catch (error: unknown) {
    log(`${kind}: not measured, ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

const native = loadNativeEngine("native")
const wasm = loadOptional("wasm")
const all = batches(events)
const runtime = runtimeName()
const cpu = cpus()[0]?.model.trim() ?? "unknown"
const bytes = events.reduce((total, event) => total + event.length, 0)
log(
  `${runtime} on ${platform()} ${arch()}, ${cpu} (${cpus().length} threads): ${DOCS} events of ${Math.round(bytes / DOCS)} bytes, ${ROUNDS} rounds, batches of ${BATCH}`,
)
log(
  `${"scenario".padEnd(22)} ${"ts".padStart(9)} ${"per event".padStart(10)} ${"matchMany".padStart(10)} ${"batched".padStart(9)}   M events/s; rust ÷ ts per event, batched`,
)

interface ScenarioResult {
  readonly name: string
  readonly ts: Measured
  readonly rustPerEvent: Measured
  readonly rustMatchMany: Measured
  readonly rustBatched: Measured
  readonly perEventRatio: number
  readonly batchedRatio: number
  readonly undecided: number
  wasm?: {
    readonly ts: Measured
    readonly perEvent: Measured
    readonly batched: Measured
    readonly undecided: number
  }
}

const results: ScenarioResult[] = []
for (const [name, { filter }] of Object.entries(SCENARIOS)) {
  const undecided = { count: 0 }
  const rust = rustModes(native, filter, events, all, undecided)
  const [ts, perEvent, many, batched] = measure(
    [tsMode(filter, events), rust.perEvent, rust.many, rust.batched],
    DOCS,
    ROUNDS,
  )
  if (ts === undefined || perEvent === undefined || many === undefined || batched === undefined)
    throw new Error("a mode was not measured")
  results.push({
    name,
    ts,
    rustPerEvent: perEvent,
    rustMatchMany: many,
    rustBatched: batched,
    perEventRatio: perEvent.eventsPerSecond / ts.eventsPerSecond,
    batchedRatio: batched.eventsPerSecond / ts.eventsPerSecond,
    undecided: undecided.count,
  })
  const rate = (m: Measured, width: number): string =>
    (m.eventsPerSecond / 1e6).toFixed(2).padStart(width)
  log(
    `${name.padEnd(22)} ${rate(ts, 9)} ${rate(perEvent, 10)} ${rate(many, 10)} ${rate(batched, 9)}   ${(perEvent.eventsPerSecond / ts.eventsPerSecond).toFixed(2)}x, ${(batched.eventsPerSecond / ts.eventsPerSecond).toFixed(2)}x; ${ts.matched} matched`,
  )
}

if (wasm !== undefined) {
  const head = events.slice(0, WASM_EVENTS)
  for (const result of results) {
    const filter = SCENARIOS[result.name]?.filter
    const undecided = { count: 0 }
    const [ts, perEvent] = measure(
      [tsMode(filter, head), rustModes(wasm, filter, head, all, undecided).perEvent],
      WASM_EVENTS,
      3,
    )
    const [batched] = measure([rustModes(wasm, filter, events, all, undecided).batched], DOCS, 3)
    if (ts === undefined || perEvent === undefined || batched === undefined)
      throw new Error("a wasm mode was not measured")
    result.wasm = { ts, perEvent, batched, undecided: undecided.count }
    log(
      `wasm ${result.name.padEnd(22)} per event ${(perEvent.eventsPerSecond / 1e6).toFixed(3)} M events/s (${(perEvent.eventsPerSecond / ts.eventsPerSecond).toFixed(2)}x ts), batched ${(batched.eventsPerSecond / 1e6).toFixed(2)} M events/s (${(batched.eventsPerSecond / result.ts.eventsPerSecond).toFixed(2)}x ts)`,
    )
  }
}

const agree = (name: string, value: boolean): [string, { value: number; min: number }] => [
  name,
  { value: value ? 1 : 0, min: 1 },
]
const gate = {
  ratios: Object.fromEntries(
    results.flatMap((result) => [
      [`rust per event ÷ ts: ${result.name}`, result.perEventRatio],
      [`rust batched ÷ ts: ${result.name}`, result.batchedRatio],
    ]),
  ),
  required: Object.fromEntries(
    results.flatMap((result) => [
      agree(
        `rust matches the events ts matches: ${result.name}`,
        result.undecided === 0 &&
          [result.rustPerEvent, result.rustMatchMany, result.rustBatched].every(
            (m) => m.matched === result.ts.matched,
          ),
      ),
      ...(result.wasm === undefined
        ? []
        : [
            agree(
              `wasm matches the events ts matches: ${result.name}`,
              result.wasm.undecided === 0 &&
                result.wasm.perEvent.matched === result.wasm.ts.matched &&
                result.wasm.batched.matched === result.ts.matched,
            ),
          ]),
    ]),
  ),
}
const text = `${JSON.stringify(
  {
    runtime,
    machine: { platform: platform(), arch: arch(), cpu, threads: cpus().length },
    docs: DOCS,
    bytesPerEvent: bytes / DOCS,
    rounds: ROUNDS,
    batch: BATCH,
    engines: { native: native.kind, wasm: wasm?.kind ?? null },
    results,
    gate,
  },
  null,
  2,
)}\n`
if (OUT === undefined) process.stdout.write(text)
else await writeFile(OUT, text)
