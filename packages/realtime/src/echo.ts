import { type ClusterTime, compareCt } from "@canopy/protocol"
import { docKey } from "./event.ts"

interface Waiter {
  readonly ct: ClusterTime
  readonly keys: Set<string>
  readonly resolve: (echoed: boolean) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Tells when the change events of a committed write have been fanned out. A wait for `(collection, ids,
 * T)` resolves with `true` once, for every id, an event on that collection with `ct >= T` was processed,
 * or once anything later than `T` was processed, because the stream is ordered. Cluster times are not
 * unique per event, so a time equal to `T` never counts as proof on its own. Waits resolve with `false`
 * when they time out.
 *
 * Call {@link EchoWaiter.processed} after the fan out of each batch of events, so a resolved wait means
 * the events were already enqueued on every connection.
 */
export class EchoWaiter {
  private position: ClusterTime = "0"
  private seenAtPosition = new Set<string>()
  private readonly waiters = new Set<Waiter>()

  /** Waits for the echo of a write. */
  wait(
    collection: string,
    ids: readonly unknown[],
    ct: ClusterTime,
    timeoutMs: number,
  ): Promise<boolean> {
    const keys = new Set(ids.map((id) => docKey(collection, id)))
    if (this.passed(ct, keys)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: Waiter = {
        ct,
        keys,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve(false)
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  /** Records a batch of fanned out events, given as `(key, ct)` in stream order. */
  processed(events: Iterable<{ readonly key: string; readonly ct: ClusterTime }>): void {
    for (const event of events) {
      const order = compareCt(event.ct, this.position)
      if (order > 0) {
        this.position = event.ct
        this.seenAtPosition = new Set()
      }
      if (order >= 0) this.seenAtPosition.add(event.key)
      for (const waiter of this.waiters) {
        if (compareCt(event.ct, waiter.ct) >= 0) waiter.keys.delete(event.key)
      }
    }
    this.settle()
  }

  /** Records that the stream reached `ct` without further events, such as a progress heartbeat. */
  advance(ct: ClusterTime): void {
    if (compareCt(ct, this.position) > 0) {
      this.position = ct
      this.seenAtPosition = new Set()
    }
    this.settle()
  }

  /** Resolves every pending wait with `false`, for shutdown. */
  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.waiters.clear()
  }

  /** The number of pending waits. */
  get pending(): number {
    return this.waiters.size
  }

  private passed(ct: ClusterTime, keys: Set<string>): boolean {
    const order = compareCt(this.position, ct)
    if (order > 0) return true
    if (order < 0) return false
    for (const key of keys) if (!this.seenAtPosition.has(key)) return false
    return true
  }

  private settle(): void {
    for (const waiter of this.waiters) {
      if (waiter.keys.size === 0 || compareCt(this.position, waiter.ct) > 0) {
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve(true)
      }
    }
  }
}
