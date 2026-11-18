import type { PolicyEngine } from "@canopy/policy"
import { CanopyError, ErrorCode, type MutMessage, toCanopyError } from "@canopy/protocol"
import type { EchoWaiter } from "./echo.ts"
import type { Logger } from "./logger.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import { isBulk, type MutationExecutor, mutationRequest } from "./mutations.ts"
import type { SessionState } from "./realtime-types.ts"
import type { SessionContexts } from "./session-contexts.ts"
import type { SessionTable } from "./session-table.ts"
import { contextOf } from "./subscription-plan.ts"

/** Options of {@link MutationRunner}. */
export interface MutationRunnerOptions {
  /** The write path; without one, mutations over the socket are refused. */
  readonly executor: MutationExecutor | undefined
  readonly engine: () => PolicyEngine
  readonly sessions: SessionTable
  readonly contexts: SessionContexts
  readonly echoes: EchoWaiter
  /** The collections the change stream covers. */
  readonly watched: () => readonly string[]
  readonly maxPending: number
  readonly echoTimeoutMs: number
  readonly metrics: RealtimeMetrics
  readonly logger: Logger
}

/** Runs the `mut` frames of each connection in arrival order and answers each with an `ack`. */
export class MutationRunner {
  private readonly options: MutationRunnerOptions

  constructor(options: MutationRunnerOptions) {
    this.options = options
  }

  /** Queues a mutation behind the connection's earlier ones, so they commit in arrival order. */
  enqueue(state: SessionState, message: MutMessage): void {
    const { executor, maxPending } = this.options
    const refuse = (code: ErrorCode, msg: string): void =>
      state.session.send({ t: "ack", m: message.id, ok: false, err: { code, msg } })
    if (executor === undefined) {
      refuse(ErrorCode.Unavailable, "Mutations over the socket are not enabled on this server")
      return
    }
    if (state.principal.readOnly === true) {
      refuse(ErrorCode.Forbidden, "A view token may not write")
      return
    }
    if (state.pendingMutations >= maxPending) {
      refuse(ErrorCode.RateLimited, `At most ${maxPending} mutations may be pending per connection`)
      return
    }
    state.pendingMutations += 1
    state.mutations = state.mutations
      .then(() => this.run(state, executor, message))
      .finally(() => {
        state.pendingMutations -= 1
      })
  }

  /**
   * Commits one mutation and sends its `ack` after its echo: once the change events of the write were
   * fanned out, the `ack` is enqueued behind them on this connection (`echo: true`). When that cannot be
   * promised (a bulk write, a collection without realtime, a subscription that defers events to a later
   * snapshot, a timeout, or a replay, whose events were sent with the original write) the `ack` carries
   * the readable post images and `echo: false`. A write whose echo is expected runs without reading its
   * documents back; they are read only when the echo does not come. A single document write that found no
   * visible document fails with `CANOPY_NOT_FOUND`, as it does over REST.
   */
  private async run(
    state: SessionState,
    executor: MutationExecutor,
    message: MutMessage,
  ): Promise<void> {
    const { sessions, metrics } = this.options
    const started = performance.now()
    try {
      await this.options.contexts.load(
        state,
        this.options.engine().contextNames([message.c], state.principal.context.roles),
      )
      const principal = state.principal
      const caller = { context: contextOf(state), subject: principal.subject }
      const request = mutationRequest(message)
      const lean =
        executor.documentsOf !== undefined &&
        !isBulk(message.op) &&
        message.op !== "delete" &&
        this.options.watched().includes(message.c)
      const result = await executor.execute(caller, request, {
        mutationId: message.id,
        ...(lean ? { returnDocuments: false } : {}),
      })
      if (
        (message.op === "update" || message.op === "replace" || message.op === "delete") &&
        result.matched === 0 &&
        result.deleted === 0 &&
        result.changedIds.length === 0
      )
        throw new CanopyError(ErrorCode.NotFound, "Document not found")
      let echo = false
      if (!result.replayed && !isBulk(message.op) && this.options.watched().includes(message.c)) {
        echo =
          result.changedIds.length === 0 ||
          (await this.options.echoes.wait(
            message.c,
            result.changedIds,
            result.ct,
            this.options.echoTimeoutMs,
          ))
        if (echo) echo = settledFor(state, message.c)
      }
      if (!sessions.has(state)) return
      const documents =
        echo || result.documents !== undefined || !lean
          ? result.documents
          : await executor.documentsOf?.(caller, request, result)
      if (!sessions.has(state)) return
      const docs = echo
        ? undefined
        : documents?.filter((doc): doc is Record<string, unknown> => doc !== null)
      state.session.send({
        t: "ack",
        m: message.id,
        ok: true,
        ct: result.ct,
        echo,
        res: {
          matched: result.matched,
          modified: result.modified,
          ...(result.insertedIds.length === 0 ? {} : { insertedIds: result.insertedIds }),
          ...(docs === undefined ? {} : { docs }),
        },
        replayed: result.replayed,
      })
      metrics.mutations.inc({
        coll: message.c,
        op: message.op,
        result: echo ? "echo" : "docs",
      })
    } catch (error: unknown) {
      const canopy = toCanopyError(error)
      if (canopy.code === ErrorCode.Internal)
        this.options.logger.error(
          { err: error, coll: message.c, op: message.op },
          "mutation failed",
        )
      metrics.mutations.inc({ coll: message.c, op: message.op, result: "error" })
      if (sessions.has(state))
        state.session.send({ t: "ack", m: message.id, ok: false, err: canopy.toWire() })
    } finally {
      metrics.mutationSeconds.observe((performance.now() - started) / 1000)
    }
  }
}

/** Whether every subscription of the connection on `coll` receives events as they are applied. */
function settledFor(state: SessionState, coll: string): boolean {
  for (const sub of state.subs.values()) {
    if (sub.coll === coll && !sub.observer.settled()) return false
  }
  return true
}
