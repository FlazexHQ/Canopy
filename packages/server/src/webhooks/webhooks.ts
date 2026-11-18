import type { ResolvedConfig } from "@canopy/config"
import { type Logger, metaCheckpoints } from "@canopy/realtime"
import type { MongoClient } from "mongodb"
import { Dispatcher, WebhookMetrics } from "./dispatcher.ts"
import { type DeadLetter, DeliveryQueue } from "./queue.ts"
import { Scheduler } from "./scheduler.ts"
import { TriggerCapture } from "./triggers.ts"

/** A configured trigger or schedule, as the admin API lists it. */
export interface HookInfo {
  readonly name: string
  readonly kind: "trigger" | "schedule"
  /** The origin of the endpoint; the path and query may hold secrets and are not shown. */
  readonly endpoint: string
  readonly collection?: string
  readonly operations?: readonly string[]
  readonly cron?: string
  readonly nextFire?: Date
  /** Deliveries waiting or in flight. */
  readonly pending: number
  readonly deadLetters: number
}

/** Options of {@link startWebhooks}. */
export interface WebhooksOptions {
  readonly config: ResolvedConfig
  readonly client: MongoClient
  readonly logger: Logger
  /** Tuning for tests: how often the queue is polled and how long the first retry waits. */
  readonly dispatch?: {
    readonly pollMs?: number
    readonly retryBaseMs?: number
    readonly concurrency?: number
  }
  readonly fetch?: typeof fetch
}

/** Triggers and schedules of one server: capture, firing and delivery. */
export interface Webhooks {
  readonly queue: DeliveryQueue
  readonly metrics: WebhookMetrics
  /** Whether the trigger change stream is open (true when there are no triggers). */
  readonly streaming: boolean
  hooks(): Promise<HookInfo[]>
  deadLetters(options?: { readonly hook?: string; readonly limit?: number }): Promise<DeadLetter[]>
  /** Puts a dead letter back in the queue. */
  retry(id: string): Promise<boolean>
  discard(id: string): Promise<boolean>
  /** Fires a schedule now. Returns the delivery id, or `undefined` for an unknown schedule. */
  run(name: string): Promise<string | undefined>
  stop(): Promise<void>
}

function origin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return "invalid"
  }
}

/**
 * Starts the trigger change stream, the scheduler and the dispatcher for the `webhooks` section of the
 * config. Returns `undefined` when no trigger or schedule is configured.
 */
export async function startWebhooks(options: WebhooksOptions): Promise<Webhooks | undefined> {
  const { config, client, logger } = options
  const { triggers, schedules, secret } = config.webhooks
  const names = [...Object.keys(triggers), ...Object.keys(schedules)]
  if (names.length === 0 || secret === undefined) return undefined
  const meta = client.db(config.mongodb.metaDatabase)
  const queue = new DeliveryQueue(meta)
  const metrics = new WebhookMetrics()
  const endpoint = (hook: string): string | undefined => triggers[hook]?.url ?? schedules[hook]?.url
  const dispatcher = new Dispatcher(
    {
      queue,
      secret,
      endpoint,
      maxAttempts: config.webhooks.maxAttempts,
      timeoutMs: config.webhooks.timeoutMs,
      node: config.server.nodeId,
      logger,
      ...(options.dispatch?.pollMs === undefined ? {} : { pollMs: options.dispatch.pollMs }),
      ...(options.dispatch?.retryBaseMs === undefined
        ? {}
        : { retryBaseMs: options.dispatch.retryBaseMs }),
      ...(options.dispatch?.concurrency === undefined
        ? {}
        : { concurrency: options.dispatch.concurrency }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
    metrics,
  )
  const capture =
    Object.keys(triggers).length === 0
      ? undefined
      : new TriggerCapture({
          client,
          db: client.db(config.mongodb.database),
          triggers,
          queue,
          checkpoints: metaCheckpoints(meta, "webhooks", config.server.nodeId),
          mode:
            config.realtime !== false && config.realtime.fullDocument === "images"
              ? "images"
              : "updateLookup",
          logger,
          onEnqueued: (counts) => {
            for (const [hook, count] of counts) metrics.enqueued.inc({ hook }, count)
            dispatcher.wake()
          },
        })
  const scheduler =
    Object.keys(schedules).length === 0
      ? undefined
      : new Scheduler({
          meta,
          schedules,
          queue,
          logger,
          onEnqueued: (hook) => {
            metrics.enqueued.inc({ hook })
            dispatcher.wake()
          },
        })
  await capture?.start()
  try {
    await scheduler?.start()
  } catch (error: unknown) {
    await capture?.stop()
    throw error
  }
  dispatcher.start()

  return {
    queue,
    metrics,
    get streaming() {
      return capture?.streaming ?? true
    },
    async hooks() {
      const counts = await queue.counts()
      const count = (name: string) => counts.get(name) ?? { pending: 0, deadLetters: 0 }
      return [
        ...Object.entries(triggers).map(([name, trigger]) => ({
          name,
          kind: "trigger" as const,
          endpoint: origin(trigger.url),
          collection: trigger.collection,
          operations: trigger.operations,
          ...count(name),
        })),
        ...Object.entries(schedules).map(([name, schedule]) => {
          const nextFire = scheduler?.nextFire(name)
          return {
            name,
            kind: "schedule" as const,
            endpoint: origin(schedule.url),
            cron: schedule.cron,
            ...(nextFire === undefined ? {} : { nextFire }),
            ...count(name),
          }
        }),
      ]
    },
    deadLetters: (filter) => queue.deadLetters(filter),
    async retry(id) {
      const requeued = await queue.requeue(id)
      if (requeued) dispatcher.wake()
      return requeued
    },
    discard: (id) => queue.discard(id),
    run: async (name) => (scheduler === undefined ? undefined : scheduler.run(name)),
    async stop() {
      scheduler?.stop()
      await capture?.stop()
      await dispatcher.stop()
    },
  }
}
