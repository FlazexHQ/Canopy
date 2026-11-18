import { type ContextResolver, type PolicyEngine, Role } from "@canopy/policy"
import { ErrorCode, type SubMessage, toCanopyError, type WireError } from "@canopy/protocol"
import type { Doc } from "./event.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import type { ObserverPool } from "./observer-pool.ts"
import type { Observer } from "./observers.ts"
import type { RealtimeLimits, SessionState, SubscriptionState } from "./realtime-types.ts"
import type { SessionContexts } from "./session-contexts.ts"
import type { SessionTable } from "./session-table.ts"
import {
  contextOf,
  coverageOf,
  explainSubscription,
  planSubscription,
  type SubscriptionPlan,
} from "./subscription-plan.ts"

/** Options of {@link Subscriptions}. */
export interface SubscriptionsOptions {
  readonly engine: () => PolicyEngine
  readonly sessions: SessionTable
  readonly contexts: SessionContexts
  readonly resolver: ContextResolver
  readonly pool: ObserverPool
  readonly limits: RealtimeLimits
  readonly metrics: RealtimeMetrics
}

/**
 * The subscriptions of every session: planned against the caller's policies, attached to shared
 * observers, moved when their effective query changes, and resynced when gap free delivery is lost.
 */
export class Subscriptions {
  private readonly options: SubscriptionsOptions
  private readonly queries = new WeakMap<SubscriptionState, { msg: SubMessage }>()
  private readonly explanations = new WeakMap<SubMessage, Record<string, unknown>>()

  constructor(options: SubscriptionsOptions) {
    this.options = options
  }

  private plan(state: SessionState, message: SubMessage): SubscriptionPlan {
    const { engine, limits, metrics } = this.options
    return planSubscription(engine(), contextOf(state), message, limits.maxWindow, metrics)
  }

  /**
   * Handles a `sub`: replaces a subscription with the same id, enforces the per connection limit,
   * prepares an explanation when one was asked for, and waits for the context lookups it needs.
   */
  subscribe(state: SessionState, message: SubMessage): void {
    const { limits, sessions } = this.options
    if (state.subs.has(message.id)) this.drop(state, message.id)
    state.pendingSubs.delete(message.id)
    if (state.subs.size + state.pendingSubs.size >= limits.maxSubscriptionsPerConnection) {
      state.session.send({
        t: "nosub",
        s: message.id,
        err: {
          code: ErrorCode.LimitSubscriptions,
          msg: `At most ${limits.maxSubscriptionsPerConnection} subscriptions per connection`,
        },
      })
      return
    }
    const explain = message.o?.explain
    if (explain !== undefined && !this.explanations.has(message)) {
      if (!state.principal.context.roles.has(Role.Service)) {
        state.session.send({
          t: "nosub",
          s: message.id,
          err: {
            code: ErrorCode.Forbidden,
            msg: "Explanations are only available with a secret key",
          },
        })
        return
      }
      state.pendingSubs.set(message.id, message)
      explainSubscription(
        this.options.engine(),
        this.options.resolver,
        limits.maxWindow,
        contextOf(state),
        message,
        explain,
      ).then(
        (report) => {
          if (state.pendingSubs.get(message.id) !== message) return
          state.pendingSubs.delete(message.id)
          this.explanations.set(message, report)
          if (sessions.has(state)) this.subscribe(state, message)
        },
        (error: unknown) => {
          if (state.pendingSubs.get(message.id) !== message) return
          state.pendingSubs.delete(message.id)
          state.session.send({ t: "nosub", s: message.id, err: toCanopyError(error).toWire() })
        },
      )
      return
    }
    const engine = this.options.engine()
    const names = engine.isRealtime(message.c)
      ? engine.contextNames([message.c], state.principal.context.roles)
      : []
    if (names.every((name) => state.ctxKeys.has(name) && !state.ctxFailed.has(name))) {
      this.subscribeNow(state, message)
      return
    }
    state.pendingSubs.set(message.id, message)
    this.options.contexts.load(state, names).then(
      () => {
        if (state.pendingSubs.get(message.id) !== message) return
        state.pendingSubs.delete(message.id)
        if (sessions.has(state)) this.subscribeNow(state, message)
      },
      () => {},
    )
  }

  private subscribeNow(state: SessionState, message: SubMessage): void {
    let plan: SubscriptionPlan
    try {
      plan = this.plan(state, message)
    } catch (error: unknown) {
      state.session.send({ t: "nosub", s: message.id, err: toCanopyError(error).toWire() })
      return
    }
    const observer = this.options.pool.acquire(plan, contextOf(state))
    const projection = plan.projection
    const project =
      projection === undefined ? (doc: Doc) => doc : (doc: Doc) => projection.apply(doc)
    const listener = state.session.listener(message.c, message.id, project, coverageOf(projection))
    const report = this.explanations.get(message)
    if (report !== undefined) {
      this.explanations.delete(message)
      state.session.explainOnReady(message.id, report)
    }
    const sub: SubscriptionState = { id: message.id, coll: message.c, observer, listener }
    this.queries.set(sub, { msg: message })
    state.subs.set(message.id, sub)
    this.options.metrics.subscriptions.add(1)
    observer.attach(listener)
  }

  /** Ends a subscription and releases its observer when it was the last subscriber. */
  drop(state: SessionState, id: string): void {
    const sub = state.subs.get(id)
    if (sub === undefined) return
    state.subs.delete(id)
    state.session.forget(id)
    this.options.metrics.subscriptions.add(-1)
    if (sub.observer.detach(sub.listener)) this.options.pool.release(sub.observer)
  }

  /** Ends a subscription whose snapshot failed and tells the client why. */
  failed(state: SessionState, subId: string, error: WireError): void {
    const sub = state.subs.get(subId)
    if (sub === undefined) return
    this.drop(state, subId)
    state.session.send({ t: "nosub", s: subId, err: error })
  }

  /** The observer key the subscription would get now, or `undefined` when it can no longer be planned. */
  observerKeyFor(state: SessionState, sub: SubscriptionState): string | undefined {
    const stored = this.queries.get(sub)
    if (stored === undefined) return undefined
    try {
      return this.plan(state, stored.msg).key
    } catch {
      return undefined
    }
  }

  /** Moves the subscriptions whose effective query changed to their new observers, without a resync. */
  rebindChanged(state: SessionState, reason: string): void {
    const { pool, metrics } = this.options
    for (const sub of [...state.subs.values()]) {
      const stored = this.queries.get(sub)
      if (stored === undefined) continue
      let plan: SubscriptionPlan
      try {
        plan = this.plan(state, stored.msg)
      } catch (error: unknown) {
        this.drop(state, sub.id)
        state.session.send({ t: "nosub", s: sub.id, err: toCanopyError(error).toWire() })
        continue
      }
      if (plan.key === sub.observer.key) continue
      if (sub.observer.detach(sub.listener)) pool.linger(sub.observer)
      const observer = pool.acquire(plan, contextOf(state))
      const next: SubscriptionState = { ...sub, observer }
      this.queries.set(next, stored)
      state.subs.set(sub.id, next)
      state.session.rebind(sub.id)
      metrics.rebinds.inc({ reason })
      observer.attach(sub.listener)
    }
  }

  /** Drops the subscriptions and sends one `resync` naming them. */
  resync(state: SessionState, ids: readonly string[], reason: string): void {
    if (ids.length === 0) return
    for (const id of ids) this.drop(state, id)
    this.options.metrics.resyncs.inc({ reason })
    state.session.send({ t: "resync", reason, s: [...ids] })
  }

  /** Resyncs every subscription of every session and destroys every observer. */
  resyncAll(reason: string): void {
    for (const state of this.options.sessions.values()) {
      const ids = [...state.subs.keys()]
      for (const id of ids) this.drop(state, id)
      this.options.metrics.resyncs.inc({ reason })
      state.session.send({ t: "resync", reason })
    }
    this.options.pool.destroyAll()
  }

  /** Resyncs every subscription served by `observer`. */
  resyncObserver(observer: Observer, reason: string): void {
    for (const state of this.options.sessions.values()) {
      const ids = [...state.subs.values()]
        .filter((sub) => sub.observer === observer)
        .map((sub) => sub.id)
      this.resync(state, ids, reason)
    }
  }
}
