import type { CoreEngine } from "@canopy/native"
import type { ContextResolver, PolicyEngine } from "@canopy/policy"
import { type ClusterTime, ZERO_CT } from "@canopy/protocol"
import type { EchoWaiter } from "./echo.ts"
import type { Doc, NormalizedEvent } from "./event.ts"
import type { EventLog } from "./event-log.ts"
import { matchesDocument } from "./match.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import type { ObserverPool } from "./observer-pool.ts"
import type { Observer } from "./observers.ts"
import type { DeniedPolicy, DlsDenial, ObserverOutcome } from "./realtime-types.ts"
import type { SessionTable } from "./session-table.ts"
import type { MongoSnapshotReader } from "./snapshot.ts"

type Subscriber = ObserverOutcome["subscribers"][number]

/** Options of {@link Fanout}. */
export interface FanoutOptions {
  /** Compiles the resolved policy clauses events are checked against. */
  readonly core: CoreEngine
  readonly engine: () => PolicyEngine
  readonly pool: ObserverPool
  readonly reader: MongoSnapshotReader
  readonly resolver: ContextResolver
  readonly sessions: SessionTable
  readonly events: EventLog
  readonly echoes: EchoWaiter
  readonly metrics: RealtimeMetrics
}

/** The top level fields a policy clause reads, looking through `$and`, `$or` and `$nor`. */
function clauseFields(clause: unknown): string[] {
  const fields = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    for (const [key, inner] of Object.entries(value)) {
      if (key === "$and" || key === "$or" || key === "$nor") {
        if (Array.isArray(inner)) for (const part of inner) walk(part)
      } else if (!key.startsWith("$")) fields.add(key.split(".")[0] ?? key)
    }
  }
  walk(clause)
  return [...fields].sort()
}

/**
 * Routes batches of change events to the observers whose predicates may match them, after filling the
 * post images of updates someone needs and invalidating the context lookups they touch. When events are
 * traced it records each observer's decision and, for a document DLS kept out, which policy did.
 */
export class Fanout {
  private readonly options: FanoutOptions

  constructor(options: FanoutOptions) {
    this.options = options
  }

  /**
   * Applies one batch of events in order, then advances every observer past the batch. An update whose
   * document an earlier event of the batch touched gets its post image even when no observer holds the
   * document yet, because that earlier event can bring it into one before the update is applied.
   */
  async process(events: NormalizedEvent[]): Promise<void> {
    const { pool, reader, resolver, metrics } = this.options
    const lookups = new Map<string, Map<ClusterTime, NormalizedEvent[]>>()
    const touched = new Set<string>()
    for (const event of events) {
      const earlier = touched.has(event.key)
      touched.add(event.key)
      if (event.op !== "update" || event.post !== undefined) continue
      if (!earlier && pool.registry.candidates(event).size === 0 && !resolver.watches(event.coll))
        continue
      let byTime = lookups.get(event.coll)
      if (byTime === undefined) {
        byTime = new Map()
        lookups.set(event.coll, byTime)
      }
      const list = byTime.get(event.ct) ?? []
      list.push(event)
      byTime.set(event.ct, list)
    }
    for (const [coll, byTime] of lookups) {
      for (const [ct, list] of byTime) {
        const found = await reader.lookup(
          coll,
          list.map((event) => event.id),
          ct,
        )
        for (const event of list) event.post = found.get(event.key) ?? null
      }
    }
    for (const event of events) {
      if (resolver.watches(event.coll))
        resolver.invalidate({
          coll: event.coll,
          id: event.id,
          pre: event.pre,
          post: event.post,
        })
    }
    let last: ClusterTime = ZERO_CT
    const log = this.options.events
    const tracing = log.tracing
    const observed = log.observed
    let subscribers: Map<Observer, Subscriber[]> | undefined
    for (const event of events) {
      const started = performance.now()
      const candidates = pool.registry.candidates(event)
      metrics.candidates.observe(candidates.size)
      const outcomes: ObserverOutcome[] = []
      for (const observer of candidates) {
        metrics.matchEvaluations.inc()
        const before = tracing && observer.has(event.key)
        observer.apply(event)
        if (!tracing) continue
        const after = observer.has(event.key)
        subscribers ??= this.subscribersByObserver()
        const dls = after ? undefined : this.denial(observer, event.post)
        outcomes.push({
          observer: observer.key,
          type: observer.type,
          outcome: before ? (after ? "updated" : "left") : after ? "entered" : "unmatched",
          subscribers: subscribers.get(observer) ?? [],
          ...(dls === undefined ? {} : { dls }),
        })
      }
      metrics.fanoutLatency.observe((performance.now() - started) / 1000)
      last = event.ct
      if (observed) log.record(event, outcomes, this.options.engine().version)
    }
    for (const observer of pool.all()) observer.advance(last)
    this.options.echoes.processed(events)
  }

  /**
   * Explains why DLS kept `doc` from an observer: only when the subscription's own filter matches it, so
   * documents the query itself excludes are not blamed on a policy. Policy clauses are matched in memory
   * and reported by name; nothing of the document or the resolved clauses is kept.
   */
  private denial(observer: Observer, doc: Doc | null | undefined): DlsDenial | undefined {
    if (doc === null || doc === undefined) return undefined
    const origin = this.options.pool.originOf(observer)
    if (origin === undefined) return undefined
    if (origin.matcher === undefined) {
      try {
        origin.matcher = this.options.core.compileFilter(origin.filter)
      } catch {
        origin.matcher = null
      }
    }
    if (origin.matcher === null || !matchesDocument(origin.matcher, doc)) return undefined
    const engine = this.options.engine()
    const coll = observer.query.coll
    const explanation = engine.explain(coll, "read", origin.context, "using")
    if (explanation.bypass) return undefined
    const definitions = engine.collection(coll)?.policies ?? []
    const policies: DeniedPolicy[] = []
    for (const policy of explanation.policies) {
      if (!policy.applies && policy.issue === undefined) continue
      let matched = false
      if (policy.applies && policy.resolved !== undefined) {
        try {
          matched = matchesDocument(this.options.core.compileFilter(policy.resolved), doc)
        } catch {
          matched = false
        }
      }
      const template = definitions.find((d) => d.name === policy.name)?.using ?? {}
      policies.push({
        name: policy.name,
        kind: policy.kind,
        matched,
        ...(policy.issue === undefined
          ? {}
          : { issue: { variable: policy.issue.variable, kind: policy.issue.kind } }),
        fields: clauseFields(template),
      })
    }
    const permissive = policies.filter((policy) => policy.kind === "permissive")
    if (!explanation.exposed || permissive.length === 0)
      return {
        reason: "no_grant",
        responsible: [],
        policies,
      }
    if (!permissive.some((policy) => policy.matched))
      return {
        reason: "no_permissive",
        responsible: permissive.map((policy) => policy.name),
        policies,
      }
    const failing = policies.filter((policy) => policy.kind === "restrictive" && !policy.matched)
    if (failing.length === 0) return undefined
    return { reason: "restrictive", responsible: failing.map((policy) => policy.name), policies }
  }

  private subscribersByObserver(): Map<Observer, Subscriber[]> {
    const out = new Map<Observer, Subscriber[]>()
    for (const state of this.options.sessions.values()) {
      for (const sub of state.subs.values()) {
        const list = out.get(sub.observer) ?? []
        if (list.length < 100)
          list.push({ sid: state.session.sid, sub: sub.id, subject: state.principal.subject })
        out.set(sub.observer, list)
      }
    }
    return out
  }
}
