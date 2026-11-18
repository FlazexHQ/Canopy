import type { ResolvedTrigger } from "@canopy/config"
import { type CompiledFilter, compileFilter } from "@canopy/matcher"
import { canonicalString, isDocument } from "@canopy/protocol"
import {
  type CheckpointStore,
  type FullDocumentMode,
  Ingestor,
  type Logger,
  type NormalizedEvent,
  RealtimeMetrics,
} from "@canopy/realtime"
import { BSON, type Db, type MongoClient } from "mongodb"
import type { DeliveryQueue, NewDelivery } from "./queue.ts"

/** Options of a {@link TriggerCapture}. */
export interface TriggerCaptureOptions {
  readonly client: MongoClient
  /** The app database. */
  readonly db: Db
  readonly triggers: Readonly<Record<string, ResolvedTrigger>>
  readonly queue: DeliveryQueue
  readonly checkpoints: CheckpointStore
  /** `images` when the trigger collections have pre and post images, else `updateLookup`. */
  readonly mode: FullDocumentMode
  readonly logger: Logger
  /** Called after new deliveries were stored, with how many per hook. */
  readonly onEnqueued: (counts: ReadonlyMap<string, number>) => void
}

interface CompiledTrigger {
  readonly name: string
  readonly trigger: ResolvedTrigger
  readonly filter: CompiledFilter | undefined
}

/** The resume token data of an event, unique per event of a deployment. */
function eventId(token: unknown): string {
  if (isDocument(token) && typeof token["_data"] === "string") return token["_data"]
  return canonicalString(token)
}

/** Compiles the trigger filters. Throws `TypeError` naming the trigger whose filter cannot be evaluated. */
export function compileTriggers(
  triggers: Readonly<Record<string, ResolvedTrigger>>,
): readonly CompiledTrigger[] {
  return Object.entries(triggers).map(([name, trigger]) => {
    let filter: CompiledFilter | undefined
    if (trigger.filter !== undefined) {
      try {
        filter = compileFilter(trigger.filter)
      } catch (error: unknown) {
        throw new TypeError(
          `The filter of the trigger ${name} cannot be evaluated: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    return { name, trigger, filter }
  })
}

/** The deliveries a batch of change events causes, in stream order. */
export function triggerDeliveries(
  triggers: readonly CompiledTrigger[],
  events: readonly NormalizedEvent[],
): NewDelivery[] {
  const out: NewDelivery[] = []
  for (const event of events) {
    for (const { name, trigger, filter } of triggers) {
      if (trigger.collection !== event.coll || !trigger.operations.includes(event.op)) continue
      const document = event.op === "delete" ? event.pre : event.post
      if (filter !== undefined && (!isDocument(document) || !filter.matches(document))) continue
      const payload = {
        type: "trigger",
        trigger: name,
        collection: event.coll,
        operation: event.op,
        documentId: event.id,
        document: event.post ?? null,
        ...(event.pre === undefined || event.op === "insert" ? {} : { before: event.pre }),
        ...(event.diff === undefined
          ? {}
          : {
              updateDescription: {
                updatedFields: event.diff.set,
                removedFields: event.diff.unset,
              },
            }),
        clusterTime: event.ct,
        ...(event.wallTime === undefined ? {} : { wallTime: event.wallTime }),
      }
      out.push({
        id: `trigger:${name}:${eventId(event.token)}`,
        hook: name,
        kind: "trigger",
        body: BSON.EJSON.stringify(payload, { relaxed: true }),
      })
    }
  }
  return out
}

/**
 * Watches the trigger collections with a change stream of its own and stores a delivery per matching event
 * before the stream position moves past it, so no matching change is skipped after a crash or restart.
 */
export class TriggerCapture {
  private readonly ingestor: Ingestor
  private readonly compiled: readonly CompiledTrigger[]
  private readonly options: TriggerCaptureOptions

  constructor(options: TriggerCaptureOptions) {
    this.options = options
    this.compiled = compileTriggers(options.triggers)
    const collections = [...new Set(this.compiled.map(({ trigger }) => trigger.collection))]
    this.ingestor = new Ingestor({
      client: options.client,
      db: options.db,
      mode: options.mode,
      collections: () => collections,
      checkpoints: options.checkpoints,
      logger: options.logger,
      metrics: new RealtimeMetrics(),
      handlers: {
        onEvents: (events) => this.capture(events),
        onControl: () => {},
        onRestart: (reason) =>
          options.logger.error(
            { reason },
            "the trigger change stream restarted from now; changes in the gap did not call their webhooks",
          ),
        onProgress: () => {},
      },
    })
  }

  /** Whether the change stream is open. */
  get streaming(): boolean {
    return this.ingestor.streaming
  }

  /** Opens the change stream. */
  async start(): Promise<void> {
    await this.ingestor.start()
  }

  /** Closes the change stream after the batch in progress. */
  async stop(): Promise<void> {
    await this.ingestor.stop()
  }

  private async capture(events: NormalizedEvent[]): Promise<void> {
    const deliveries = triggerDeliveries(this.compiled, events)
    if (deliveries.length === 0) return
    const stored = await this.options.queue.enqueue(deliveries)
    if (stored === 0) return
    const counts = new Map<string, number>()
    for (const delivery of deliveries)
      counts.set(delivery.hook, (counts.get(delivery.hook) ?? 0) + 1)
    this.options.onEnqueued(counts)
  }
}
