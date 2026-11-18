/** How many recent answer times each route keeps. */
const WINDOW = 64

/** The longest any answer is held, so one stalled request cannot slow every later one for long. */
const CEILING_MS = 1000

/**
 * The time to hold the answers of routes whose timing could reveal whether an email address has an
 * account. An answer waits until it took the configured floor or the slowest of the last answers on its
 * route, whichever is longer, up to one second. A fixed floor alone hides nothing on a machine where the
 * slow path (creating an account, sending an email) outlasts it, while the fast path (an address that is
 * taken) still answers at the floor.
 */
export class ResponseFloor {
  private readonly floorMs: number
  private readonly recent = new Map<string, number[]>()

  constructor(floorMs: number) {
    this.floorMs = floorMs
  }

  /** How long an answer on `route` must take in all. */
  target(route: string): number {
    const slowest = Math.max(this.floorMs, ...(this.recent.get(route) ?? []))
    return Math.min(slowest, Math.max(this.floorMs, CEILING_MS))
  }

  /** Records how long an answer on `route` took before it was held. */
  record(route: string, ms: number): void {
    const times = this.recent.get(route) ?? []
    times.push(ms)
    if (times.length > WINDOW) times.shift()
    this.recent.set(route, times)
  }
}
