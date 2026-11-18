import type { MongoClient } from "mongodb"

/** The outcome of a readiness check. `reason` names what is not ready. */
export interface Readiness {
  readonly ready: boolean
  readonly reason?: string
}

/** Options of {@link readinessCheck}. */
export interface ReadinessOptions {
  readonly mongo: MongoClient
  /** Whether the change stream is open; leave out when the process serves no realtime. */
  readonly changeStream?: () => boolean
  /** How long a result is reused, so probes do not ping MongoDB on every request. Defaults to 1 s. */
  readonly cacheMs?: number
  /** How long the MongoDB ping may take before the process counts as not ready. Defaults to 2 s. */
  readonly timeoutMs?: number
}

/**
 * Builds the check behind `/readyz`: MongoDB answers a `ping` in time, and the change stream (when there is
 * one) is open. Results are cached briefly and concurrent probes share one ping.
 */
export function readinessCheck(options: ReadinessOptions): () => Promise<Readiness> {
  const cacheMs = options.cacheMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 2000
  let last: { readonly at: number; readonly result: Readiness } | undefined
  let pending: Promise<Readiness> | undefined
  const probe = async (): Promise<Readiness> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const ping = options.mongo
      .db("admin")
      .command({ ping: 1 })
      .then(
        () => true,
        () => false,
      )
    const reachable = await Promise.race([ping, timeout]).finally(() => clearTimeout(timer))
    if (!reachable) return { ready: false, reason: "MongoDB does not answer" }
    if (options.changeStream !== undefined && !options.changeStream())
      return { ready: false, reason: "the change stream is not open" }
    return { ready: true }
  }
  return () => {
    if (last !== undefined && Date.now() - last.at < cacheMs) return Promise.resolve(last.result)
    pending ??= probe()
      .then((result) => {
        last = { at: Date.now(), result }
        return result
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}
