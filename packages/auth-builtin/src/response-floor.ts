/** How many recent answer times each route keeps. */
const WINDOW = 64

/** The longest any answer is held. */
const CEILING_MS = 1000

/** Answers are held as long as the third slowest recent one, so one or two stalls do not slow the next ones. */
const RANK = 3

/**
 * The time to hold the answers of routes whose timing could reveal whether an email address has an
 * account. An answer waits until it took the configured floor or the third slowest of the last 64 answers
 * on its route, whichever is longer, up to one second. A fixed floor alone hides nothing on a machine where
 * the slow path (creating an account, sending an email) outlasts it, while the fast path (an address that
 * is taken) still answers at the floor. A rank rather than a percentile keeps a rare slow path covered even
 * when most requests take the fast one, as they do when someone probes addresses known to be taken.
 */
export class ResponseFloor {
  private readonly floorMs: number
  private readonly recent = new Map<string, number[]>()

  constructor(floorMs: number) {
    this.floorMs = floorMs
  }

  /** How long an answer on `route` must take in all. */
  target(route: string): number {
    const times = [...(this.recent.get(route) ?? [])].sort((a, b) => b - a)
    const slow = times[Math.min(RANK, times.length) - 1] ?? 0
    return Math.min(Math.max(this.floorMs, slow), Math.max(this.floorMs, CEILING_MS))
  }

  /** Records how long an answer on `route` took before it was held. */
  record(route: string, ms: number): void {
    const times = this.recent.get(route) ?? []
    times.push(ms)
    if (times.length > WINDOW) times.shift()
    this.recent.set(route, times)
  }
}
