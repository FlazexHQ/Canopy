import type { ContextResolver, PolicyEngine } from "@canopy/policy"
import type { Logger } from "./logger.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import type { SessionState } from "./realtime-types.ts"
import type { SessionTable } from "./session-table.ts"

/** Options of {@link SessionContexts}. */
export interface SessionContextsOptions {
  readonly resolver: ContextResolver
  readonly engine: () => PolicyEngine
  readonly sessions: SessionTable
  readonly metrics: RealtimeMetrics
  readonly logger: Logger
  /** How long a failed lookup waits before it is resolved again. */
  readonly retryMs: number
  /** Called after lookups were resolved again, so subscriptions whose query changed move. */
  readonly onRefreshed: (state: SessionState, reason: string) => void
}

/**
 * The context lookups (`$ctx`) of each session: resolved on demand, held in the shared resolver cache
 * while the session lives, refreshed when their source documents change, and retried after a failure.
 */
export class SessionContexts {
  private readonly options: SessionContextsOptions

  constructor(options: SessionContextsOptions) {
    this.options = options
  }

  /**
   * Resolves the named lookups the session does not hold yet (and every name in `force`), through the
   * session's work queue. Transient failures are retried after `retryMs`.
   */
  load(
    state: SessionState,
    names: readonly string[],
    force: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const { resolver, sessions } = this.options
    const work = state.ctxWork.then(async () => {
      if (!sessions.has(state)) return
      const wanted = names.filter(
        (name) => force.has(name) || !state.ctxKeys.has(name) || state.ctxFailed.has(name),
      )
      if (wanted.length === 0) return
      const resolved = await resolver.resolve(
        this.options.engine().set.contexts,
        wanted,
        state.principal.context,
      )
      if (!sessions.has(state)) return
      const released: string[] = []
      const ctx = { ...state.ctx }
      for (const name of wanted) {
        const key = state.ctxKeys.get(name)
        if (key !== undefined) released.push(key)
        state.ctxKeys.delete(name)
        state.ctxFailed.delete(name)
        delete ctx[name]
      }
      Object.assign(ctx, resolved.ctx)
      for (const [name, key] of resolved.keys) {
        if (resolved.failed.has(name)) continue
        state.ctxKeys.set(name, key)
      }
      resolver.retain(
        [...resolved.keys].filter(([name]) => !resolved.failed.has(name)).map(([, key]) => key),
      )
      resolver.release(released)
      state.ctx = ctx
      if (resolved.failed.size > 0) {
        for (const name of resolved.failed) state.ctxFailed.add(name)
        if (state.ctxRetry === undefined) {
          state.ctxRetry = setTimeout(() => {
            state.ctxRetry = undefined
            this.refresh(state, [...state.ctxFailed], "ctx_retry")
          }, this.options.retryMs)
        }
      }
    })
    state.ctxWork = work.catch((error: unknown) =>
      this.options.logger.error({ err: error }, "context lookup failed"),
    )
    return work
  }

  /** Releases every lookup the session holds. */
  clear(state: SessionState): void {
    this.options.resolver.release(state.ctxKeys.values())
    state.ctxKeys.clear()
    state.ctxFailed.clear()
    state.ctx = {}
    if (state.ctxRetry !== undefined) clearTimeout(state.ctxRetry)
    state.ctxRetry = undefined
  }

  /** Refreshes the sessions holding any of the invalidated resolver entries. */
  invalidated(keys: ReadonlySet<string>): void {
    this.options.metrics.contextInvalidations.inc({}, keys.size)
    for (const state of this.options.sessions.values()) {
      const names = [...state.ctxKeys].filter(([, key]) => keys.has(key)).map(([name]) => name)
      if (names.length > 0) this.refresh(state, names, "ctx")
    }
  }

  /** Re-resolves lookups, then reports the session so its changed subscriptions move. */
  refresh(state: SessionState, names: readonly string[], reason: string): void {
    this.load(state, names, new Set(names)).then(
      () => {
        if (this.options.sessions.has(state)) this.options.onRefreshed(state, reason)
      },
      () => {},
    )
  }
}
