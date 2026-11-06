/** Label values of one series. */
export type Labels = Readonly<Record<string, string>>

interface Series {
  readonly labels: Labels
  value: number
}

interface HistogramSeries {
  readonly labels: Labels
  readonly counts: number[]
  sum: number
  count: number
}

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(",")
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')
}

function formatLabels(labels: Labels, extra?: Readonly<Record<string, string>>): string {
  const all = { ...labels, ...extra }
  const names = Object.keys(all)
  if (names.length === 0) return ""
  return `{${names.map((name) => `${name}="${escapeLabel(all[name] ?? "")}"`).join(",")}}`
}

/** A counter: a value that only goes up. */
export class Counter {
  readonly name: string
  readonly help: string
  private readonly series = new Map<string, Series>()

  constructor(name: string, help: string) {
    this.name = name
    this.help = help
  }

  inc(labels: Labels = {}, amount = 1): void {
    const id = key(labels)
    const entry = this.series.get(id)
    if (entry === undefined) this.series.set(id, { labels, value: amount })
    else entry.value += amount
  }

  get(labels: Labels = {}): number {
    return this.series.get(key(labels))?.value ?? 0
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const entry of this.series.values())
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`)
    return lines.join("\n")
  }
}

/** A gauge: a value that goes up and down. */
export class Gauge {
  readonly name: string
  readonly help: string
  private readonly series = new Map<string, Series>()

  constructor(name: string, help: string) {
    this.name = name
    this.help = help
  }

  set(value: number, labels: Labels = {}): void {
    const id = key(labels)
    const entry = this.series.get(id)
    if (entry === undefined) this.series.set(id, { labels, value })
    else entry.value = value
  }

  add(amount: number, labels: Labels = {}): void {
    this.set(this.get(labels) + amount, labels)
  }

  get(labels: Labels = {}): number {
    return this.series.get(key(labels))?.value ?? 0
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const entry of this.series.values())
      lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`)
    return lines.join("\n")
  }
}

/** A histogram with fixed buckets. */
export class Histogram {
  readonly name: string
  readonly help: string
  readonly buckets: readonly number[]
  private readonly series = new Map<string, HistogramSeries>()

  constructor(name: string, help: string, buckets: readonly number[]) {
    this.name = name
    this.help = help
    this.buckets = buckets
  }

  observe(value: number, labels: Labels = {}): void {
    const id = key(labels)
    let entry = this.series.get(id)
    if (entry === undefined) {
      entry = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 }
      this.series.set(id, entry)
    }
    this.buckets.forEach((bound, index) => {
      if (value <= bound && entry !== undefined)
        entry.counts[index] = (entry.counts[index] ?? 0) + 1
    })
    entry.sum += value
    entry.count += 1
  }

  count(labels: Labels = {}): number {
    return this.series.get(key(labels))?.count ?? 0
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const entry of this.series.values()) {
      this.buckets.forEach((bound, index) => {
        lines.push(
          `${this.name}_bucket${formatLabels(entry.labels, { le: String(bound) })} ${entry.counts[index] ?? 0}`,
        )
      })
      lines.push(`${this.name}_bucket${formatLabels(entry.labels, { le: "+Inf" })} ${entry.count}`)
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}`)
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.count}`)
    }
    return lines.join("\n")
  }
}

const LATENCY = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
const COUNTS = [0, 1, 2, 5, 10, 25, 50, 100, 250, 1000]

/** The realtime metrics, rendered in the Prometheus text format. */
export class RealtimeMetrics {
  readonly lag: Gauge = new Gauge(
    "canopy_changestream_lag_seconds",
    "now minus wallTime of the last processed event",
  )
  readonly events: Counter = new Counter(
    "canopy_changestream_events_total",
    "Ingested change events",
  )
  readonly restarts: Counter = new Counter(
    "canopy_changestream_restarts_total",
    "Change stream resumes, reopens and history loss",
  )
  readonly connections: Gauge = new Gauge(
    "canopy_realtime_connections",
    "Open realtime connections",
  )
  readonly subscriptions: Gauge = new Gauge("canopy_realtime_subscriptions", "Active subscriptions")
  readonly observers: Gauge = new Gauge("canopy_realtime_observers", "Live observers by type")
  readonly candidates: Histogram = new Histogram(
    "canopy_realtime_candidates_per_event",
    "Observers evaluated per event",
    COUNTS,
  )
  readonly matchEvaluations: Counter = new Counter(
    "canopy_realtime_match_evaluations_total",
    "Matcher calls",
  )
  readonly lazyLookups: Counter = new Counter(
    "canopy_realtime_lazy_lookups_total",
    "Post images fetched by the lazy resolver",
  )
  readonly fanoutLatency: Histogram = new Histogram(
    "canopy_realtime_fanout_latency_seconds",
    "Event received to frame written",
    LATENCY,
  )
  readonly messages: Counter = new Counter(
    "canopy_realtime_messages_total",
    "Outbound protocol messages",
  )
  readonly bytes: Counter = new Counter("canopy_realtime_bytes_total", "Outbound bytes")
  readonly snapshotSeconds: Histogram = new Histogram(
    "canopy_realtime_snapshot_seconds",
    "Snapshot query time",
    LATENCY,
  )
  readonly snapshotQueueDepth: Gauge = new Gauge(
    "canopy_realtime_snapshot_queue_depth",
    "Snapshots waiting for a slot",
  )
  readonly slowConsumers: Counter = new Counter(
    "canopy_realtime_slow_consumers_total",
    "Sessions dropped as slow consumers",
  )
  readonly resyncs: Counter = new Counter("canopy_realtime_resyncs_total", "Resync messages sent")
  readonly denials: Counter = new Counter("canopy_policy_denials_total", "DLS denials")
  readonly variableErrors: Counter = new Counter(
    "canopy_policy_variable_errors_total",
    "Policy variables that failed to resolve",
  )

  /** Renders every metric in the Prometheus text exposition format. */
  render(): string {
    return `${[
      this.lag,
      this.events,
      this.restarts,
      this.connections,
      this.subscriptions,
      this.observers,
      this.candidates,
      this.matchEvaluations,
      this.lazyLookups,
      this.fanoutLatency,
      this.messages,
      this.bytes,
      this.snapshotSeconds,
      this.snapshotQueueDepth,
      this.slowConsumers,
      this.resyncs,
      this.denials,
      this.variableErrors,
    ]
      .map((metric) => metric.render())
      .join("\n")}\n`
  }
}
