import { randomUUID } from "node:crypto"
import { type CronSchedule, parseCron, type ResolvedSchedule } from "@canopy/config"
import type { Logger } from "@canopy/realtime"
import { BSON, type Collection, type Db } from "mongodb"
import type { DeliveryQueue } from "./queue.ts"

/** The longest delay a timer keeps; later fires are reached in several steps. */
const MAX_TIMER_MS = 2_147_483_647

/** Options of a {@link Scheduler}. */
export interface SchedulerOptions {
  readonly meta: Db
  readonly schedules: Readonly<Record<string, ResolvedSchedule>>
  readonly queue: DeliveryQueue
  readonly logger: Logger
  /** Called after this server stored a fire. */
  readonly onEnqueued: (hook: string) => void
  readonly now?: () => number
}

interface ScheduleState {
  readonly _id: string
  readonly lastAt: Date
}

/**
 * Turns cron schedules into deliveries. Every server runs one; each fire is stored under the id
 * `schedule:<name>:<time>`, so whichever server stores it first wins and the others skip it. After downtime
 * the most recent missed fire is stored once; a new schedule starts from now.
 */
export class Scheduler {
  private readonly options: SchedulerOptions
  private readonly states: Collection<ScheduleState>
  private readonly crons: ReadonlyMap<string, CronSchedule>
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private running = false

  constructor(options: SchedulerOptions) {
    this.options = options
    this.states = options.meta.collection<ScheduleState>("webhook_schedules")
    this.crons = new Map(
      Object.entries(options.schedules).map(([name, schedule]) => [name, parseCron(schedule.cron)]),
    )
    this.now = options.now ?? Date.now
  }

  /** Stores missed fires, then plans the next fire of every schedule. */
  async start(): Promise<void> {
    this.running = true
    await this.catchUp(new Date(this.now()))
    for (const name of this.crons.keys()) this.plan(name)
  }

  /** Cancels the planned fires. */
  stop(): void {
    this.running = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** The next fire time of a schedule after now. */
  nextFire(name: string): Date | undefined {
    return this.crons.get(name)?.next(new Date(this.now()))
  }

  /**
   * Stores the last fire at or before `now` of every schedule whose stored state is older. A schedule
   * without state gets one at that fire, without firing.
   */
  async catchUp(now: Date): Promise<void> {
    for (const [name, cron] of this.crons) {
      const last = cron.previous(now)
      const state = await this.states.findOne({ _id: name })
      if (state === null) {
        await this.states.updateOne(
          { _id: name },
          { $setOnInsert: { lastAt: last } },
          { upsert: true },
        )
        continue
      }
      if (state.lastAt.getTime() < last.getTime()) await this.fire(name, last)
    }
  }

  /** Stores the fire of `name` planned for `at`. Returns whether this call stored it. */
  async fire(name: string, at: Date): Promise<boolean> {
    const stored = await this.options.queue.enqueue([
      {
        id: `schedule:${name}:${at.toISOString()}`,
        hook: name,
        kind: "schedule",
        body: this.body(name, at),
      },
    ])
    await this.states.updateOne({ _id: name }, { $max: { lastAt: at } }, { upsert: true })
    if (stored > 0) this.options.onEnqueued(name)
    return stored > 0
  }

  /** Stores a fire of `name` now, outside its schedule. Returns the delivery id. */
  async run(name: string): Promise<string | undefined> {
    if (!this.crons.has(name)) return undefined
    const at = new Date(this.now())
    const id = `schedule:${name}:run:${at.toISOString()}:${randomUUID()}`
    await this.options.queue.enqueue([
      { id, hook: name, kind: "schedule", body: this.body(name, at) },
    ])
    this.options.onEnqueued(name)
    return id
  }

  private body(name: string, at: Date): string {
    const body = this.options.schedules[name]?.body
    return BSON.EJSON.stringify(
      {
        type: "schedule",
        schedule: name,
        scheduledAt: at.toISOString(),
        ...(body === undefined ? {} : { body }),
      },
      { relaxed: true },
    )
  }

  private plan(name: string, at?: Date): void {
    if (!this.running) return
    const cron = this.crons.get(name)
    if (cron === undefined) return
    const target = at ?? cron.next(new Date(this.now()))
    const wait = target.getTime() - this.now()
    const timer = setTimeout(
      () => {
        if (wait > MAX_TIMER_MS) {
          this.plan(name, target)
          return
        }
        this.fire(name, target)
          .catch((error: unknown) =>
            this.options.logger.error(
              { err: error, schedule: name },
              "could not store a schedule fire",
            ),
          )
          .finally(() =>
            this.plan(name, cron.next(new Date(Math.max(target.getTime(), this.now())))),
          )
      },
      Math.min(Math.max(0, wait), MAX_TIMER_MS),
    )
    timer.unref?.()
    this.timers.set(name, timer)
  }
}
