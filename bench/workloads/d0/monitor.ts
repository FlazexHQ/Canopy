import { PerformanceObserver } from "node:perf_hooks"
import v8 from "node:v8"
import type { MongoClient } from "mongodb"

/** Commands that are driver or session housekeeping rather than work for a request. */
const HOUSEKEEPING = new Set([
  "hello",
  "isMaster",
  "ismaster",
  "endSessions",
  "saslStart",
  "saslContinue",
])

/** Whether `total_allocated_bytes` is a running total on this runtime (V8 yes, Bun no). */
const CUMULATIVE_ALLOCATION = (globalThis as { Bun?: unknown }).Bun === undefined

/** The read commands whose plans the report explains. */
const READ_COMMANDS = new Set(["find", "aggregate", "count", "distinct"])

/** A read command seen on the wire, with its database. */
export interface SeenRead {
  readonly name: string
  readonly database: string
  readonly command: Record<string, unknown>
}

/** What the driver monitoring saw during one window. */
export interface WindowEvents {
  /** MongoDB commands by name. */
  readonly commands: ReadonlyMap<string, number>
  /** The first read command of each name. */
  readonly reads: ReadonlyMap<string, SeenRead>
  /** Wait of each connection check out, in milliseconds. */
  readonly poolWaits: readonly number[]
  readonly failedCheckouts: number
}

/**
 * Counts the commands and connection pool check outs of a client created with `monitorCommands: true`.
 * `begin` clears the counts, so a window is whatever happens between `begin` and `end`.
 */
export class ClientMonitor {
  private commands = new Map<string, number>()
  private reads = new Map<string, SeenRead>()
  private waits: number[] = []
  private failed = 0
  private active = false

  constructor(client: MongoClient) {
    client.on("commandStarted", (event) => {
      if (!this.active || HOUSEKEEPING.has(event.commandName)) return
      this.commands.set(event.commandName, (this.commands.get(event.commandName) ?? 0) + 1)
      if (READ_COMMANDS.has(event.commandName) && !this.reads.has(event.commandName))
        this.reads.set(event.commandName, {
          name: event.commandName,
          database: event.databaseName,
          command: { ...event.command },
        })
    })
    client.on("connectionCheckedOut", (event) => {
      if (this.active) this.waits.push(event.durationMS)
    })
    client.on("connectionCheckOutFailed", () => {
      if (this.active) this.failed += 1
    })
  }

  /** Starts a window: clears the counts and starts counting. */
  begin(): void {
    this.commands = new Map()
    this.reads = new Map()
    this.waits = []
    this.failed = 0
    this.active = true
  }

  /** Ends the window and returns what it saw. */
  end(): WindowEvents {
    this.active = false
    return {
      commands: this.commands,
      reads: this.reads,
      poolWaits: this.waits,
      failedCheckouts: this.failed,
    }
  }
}

/** A reading of the garbage collector and the allocator. */
export interface MemoryReading {
  readonly heapUsed: number
  /**
   * Cumulative bytes the engine has allocated, from `v8.getHeapStatistics().total_allocated_bytes`, or `null`
   * on Bun, whose `node:v8` shim reports a figure that drops after each collection rather than a running total.
   */
  readonly allocatedBytes: number | null
  readonly gcCount: number
  readonly gcMillis: number
}

/**
 * Counts garbage collections with a `PerformanceObserver` on `gc` entries. A runtime that accepts the
 * observer but never reports an entry (Bun at the time of writing) shows zero collections, so `observed`
 * says whether any entry arrived at all.
 */
export class GcMeter {
  private count = 0
  private millis = 0
  private readonly observer: PerformanceObserver | undefined

  constructor() {
    try {
      const observer = new PerformanceObserver((list) => this.add(list.getEntries()))
      observer.observe({ entryTypes: ["gc"] })
      this.observer = observer
    } catch {
      this.observer = undefined
    }
  }

  private add(entries: readonly { readonly duration: number }[]): void {
    for (const entry of entries) {
      this.count += 1
      this.millis += entry.duration
    }
  }

  /** Whether the observer could be installed. */
  get installed(): boolean {
    return this.observer !== undefined
  }

  /** The total number of collections seen since the meter was created. */
  get seen(): number {
    return this.count
  }

  /** Reads the counters after delivering the entries that are still queued. */
  read(): MemoryReading {
    if (this.observer !== undefined) this.add(this.observer.takeRecords())
    return {
      heapUsed: process.memoryUsage().heapUsed,
      allocatedBytes: CUMULATIVE_ALLOCATION
        ? ((v8.getHeapStatistics() as { total_allocated_bytes?: number }).total_allocated_bytes ??
          null)
        : null,
      gcCount: this.count,
      gcMillis: this.millis,
    }
  }

  /** Stops observing garbage collections. */
  close(): void {
    this.observer?.disconnect()
  }
}
