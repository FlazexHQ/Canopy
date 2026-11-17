import type { NormalizedEvent } from "./event.ts"
import type { Logger } from "./logger.ts"
import type { EventSummary, EventTrace, ObserverOutcome } from "./realtime-types.ts"

/**
 * What the engine shows about the change events it processes: summaries for live listeners (`tail`) and,
 * when a trace capacity is set, the traces of the most recent events with every observer's decision.
 */
export class EventLog {
  private counter = 0
  private readonly nodeId: string
  private readonly capacity: number
  private readonly logger: Logger
  private readonly listeners = new Set<(event: EventSummary) => void>()
  private readonly traces = new Map<string, EventTrace>()

  constructor(options: {
    readonly nodeId: string
    readonly capacity: number
    readonly logger: Logger
  }) {
    this.nodeId = options.nodeId
    this.capacity = options.capacity
    this.logger = options.logger
  }

  /** Whether events are traced, so the engine collects every observer's outcome. */
  get tracing(): boolean {
    return this.capacity > 0
  }

  /** Whether anything consumes events, so the engine records them at all. */
  get observed(): boolean {
    return this.tracing || this.listeners.size > 0
  }

  /** Records one processed event: traces it when tracing and hands its summary to every listener. */
  record(event: NormalizedEvent, outcomes: ObserverOutcome[], policyVersion: string): void {
    this.counter += 1
    const summary: EventSummary = {
      id: `${this.nodeId}.${this.counter.toString(36)}`,
      ct: event.ct,
      wallTime: event.wallTime,
      coll: event.coll,
      op: event.op,
      docId: event.id,
      fields:
        event.diff === undefined
          ? undefined
          : [...Object.keys(event.diff.set), ...event.diff.unset],
    }
    if (this.tracing) {
      this.traces.set(summary.id, { ...summary, policyVersion, candidates: outcomes })
      for (const id of this.traces.keys()) {
        if (this.traces.size <= this.capacity) break
        this.traces.delete(id)
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(summary)
      } catch (error: unknown) {
        this.logger.warn({ err: error }, "event tail listener failed")
      }
    }
  }

  /** Calls `listener` with a summary of every event recorded from now on. Returns an unsubscribe. */
  tail(listener: (event: EventSummary) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The trace of a recent event, while it is within the capacity. */
  trace(id: string): EventTrace | undefined {
    return this.traces.get(id)
  }

  /** The most recent traced events, newest first. */
  recent(limit: number): EventSummary[] {
    const out: EventSummary[] = []
    for (const trace of [...this.traces.values()].reverse()) {
      if (out.length >= limit) break
      const { policyVersion: _version, candidates: _candidates, ...summary } = trace
      out.push(summary)
    }
    return out
  }

  /** Drops every listener, when the engine closes. */
  close(): void {
    this.listeners.clear()
  }
}
