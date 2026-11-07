import {
  type ClusterTime,
  canonicalString,
  encodeMessage,
  type SequencedMessage,
  type WireError,
} from "@canopy/protocol"
import type { Doc } from "./event.ts"
import type { ObserverListener } from "./observers.ts"

/** A transport level socket. Adapters exist for `ws` on Node and for `Bun.serve`. */
export interface RealtimeSocket {
  send(text: string): void
  close(code: number, reason: string): void
  /** Bytes queued but not yet written. */
  readonly bufferedAmount: number
}

/** The content of a server message before it gets its sequence number. */
export type Outgoing = SequencedMessage extends infer M
  ? M extends { seq: number }
    ? Omit<M, "seq">
    : never
  : never

interface Frame {
  readonly seq: number
  readonly text: string
}

interface MergeEntry {
  readonly coll: string
  readonly id: unknown
  readonly subs: Set<string>
  doc: Doc
}

/** Coverage of one subscription's projection: which top level fields it owns in the merge box. */
export interface Coverage {
  covers(field: string): boolean
}

/** Every field. */
export const FULL_COVERAGE: Coverage = { covers: () => true }

/** Session limits. */
export interface SessionLimits {
  readonly resumeBufferBytes: number
  readonly softQueueBytes: number
  readonly hardQueueBytes: number
}

function diff(before: Doc, after: Doc): { set: Doc; unset: string[] } {
  const set: Doc = {}
  const unset: string[] = []
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key) || canonicalString(before[key]) !== canonicalString(after[key]))
      set[key] = after[key]
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) unset.push(key)
  return { set, unset }
}

/**
 * One client session: sequenced output with a bounded replay buffer for resume, and a merge
 * box so a document is sent once per connection no matter how many subscriptions contain it.
 */
export class Session {
  readonly sid: string
  private seq = 0
  private socket: RealtimeSocket | undefined
  private readonly frames: Frame[] = []
  private frameBytes = 0
  private readonly limits: SessionLimits
  private readonly mergeBox = new Map<string, MergeEntry>()
  /** Subscriptions moving to another observer, with the keys the new observer has sent so far. */
  private readonly rebinding = new Map<string, Set<string>>()
  private readonly diffs: boolean
  private readonly batching: boolean
  private queue: string[] = []
  private flushScheduled = false
  private dropped = false
  /** Called when the socket must be closed because the client cannot keep up. */
  onSlowConsumer: (() => void) | undefined
  /** Monotonic time of the last disconnect, while waiting for a resume. */
  disconnectedAt: number | undefined

  constructor(sid: string, caps: ReadonlySet<string>, limits: SessionLimits) {
    this.sid = sid
    this.limits = limits
    this.diffs = caps.has("diff")
    this.batching = caps.has("batch")
  }

  /** The last sequence number sent. */
  get lastSeq(): number {
    return this.seq
  }

  /** Whether a socket is attached. */
  get connected(): boolean {
    return this.socket !== undefined
  }

  /** Attaches a socket and writes the welcome frame (always `seq: 0`). */
  connect(
    socket: RealtimeSocket,
    welcome: Omit<Extract<SequencedMessage, { t: "welcome" }>, "seq">,
  ): void {
    this.socket = socket
    this.disconnectedAt = undefined
    socket.send(encodeMessage({ ...welcome, seq: 0 }))
  }

  /** Detaches the socket; the session stays resumable. */
  disconnect(): void {
    this.flush()
    this.socket = undefined
    this.disconnectedAt = Date.now()
  }

  /**
   * Whether the frames after `afterSeq` are still buffered. When they are not, the caller must start a new
   * session and the client resyncs.
   */
  canReplay(afterSeq: number): boolean {
    if (this.dropped || afterSeq > this.seq) return false
    if (afterSeq === this.seq) return true
    const first = this.frames[0]
    return first !== undefined && first.seq <= afterSeq + 1
  }

  /** Replays the frames after `afterSeq`. Check {@link canReplay} first. */
  replayAfter(afterSeq: number): boolean {
    if (!this.canReplay(afterSeq)) return false
    for (const frame of this.frames) if (frame.seq > afterSeq) this.write(frame.text)
    this.flush()
    return true
  }

  /** Sends a message, assigning the next sequence number. */
  send(message: Outgoing): void {
    if (this.dropped) return
    this.seq += 1
    const text = encodeMessage({ ...message, seq: this.seq } as SequencedMessage)
    this.frames.push({ seq: this.seq, text })
    this.frameBytes += text.length
    while (this.frameBytes > this.limits.resumeBufferBytes && this.frames.length > 1) {
      const removed = this.frames.shift()
      if (removed !== undefined) this.frameBytes -= removed.text.length
    }
    if (this.socket !== undefined) this.write(text)
  }

  private write(text: string): void {
    this.queue.push(text)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => this.flush())
    }
  }

  /** Writes queued frames, coalesced into one `batch` frame when the client negotiated `batch`. */
  flush(): void {
    this.flushScheduled = false
    const socket = this.socket
    const queued = this.queue
    this.queue = []
    if (socket === undefined || queued.length === 0) return
    if (socket.bufferedAmount > this.limits.hardQueueBytes) {
      this.dropped = true
      this.onSlowConsumer?.()
      return
    }
    if (this.batching && queued.length > 1) socket.send(`{"t":"batch","m":[${queued.join(",")}]}`)
    else for (const text of queued) socket.send(text)
  }

  /** Builds the observer listener for one subscription of this session. */
  listener(
    coll: string,
    subId: string,
    project: (doc: Doc) => Doc,
    coverage: Coverage,
  ): ObserverListener & { readonly subId: string } {
    return {
      subId,
      added: (key, id, doc, ct) => this.added(coll, key, id, subId, project(doc), ct),
      changed: (key, id, doc, ct) => this.changed(coll, key, id, subId, project(doc), coverage, ct),
      removed: (key, _id, ct) => this.removed(coll, key, subId, ct),
      ready: (ct) => this.ready(subId, ct),
      failed: (error) => this.endSubscription(subId, error.toWire()),
    }
  }

  /**
   * Starts moving a subscription to another observer, for example after a context lookup it depends on
   * changed. The documents the client holds for it stay. The new observer's snapshot then arrives as
   * `added` or `changed` for documents that are new or differ, and when it is ready, every document it no
   * longer contains is sent as `removed` instead of a second `ready`. The client never sees the
   * subscription empty.
   */
  rebind(subId: string): void {
    this.rebinding.set(subId, new Set())
  }

  private ready(subId: string, ct: ClusterTime): void {
    const seen = this.rebinding.get(subId)
    if (seen === undefined) {
      this.send({ t: "ready", s: subId, ct })
      return
    }
    this.rebinding.delete(subId)
    for (const [key, entry] of [...this.mergeBox]) {
      if (entry.subs.has(subId) && !seen.has(key)) this.removed(entry.coll, key, subId, ct)
    }
  }

  /** Called when a subscription ends for any reason other than `unsub`. Set by the server. */
  onSubscriptionFailed: ((subId: string, error: WireError) => void) | undefined

  private endSubscription(subId: string, error: WireError): void {
    this.onSubscriptionFailed?.(subId, error)
  }

  private added(
    coll: string,
    key: string,
    id: unknown,
    subId: string,
    doc: Doc,
    ct: ClusterTime,
  ): void {
    this.rebinding.get(subId)?.add(key)
    const entry = this.mergeBox.get(key)
    if (entry === undefined) {
      this.mergeBox.set(key, { coll, id, subs: new Set([subId]), doc })
      this.send({ t: "added", c: coll, id, d: doc, ct, s: [subId] })
      return
    }
    const merged: Doc = { ...entry.doc, ...doc }
    const known = entry.subs.has(subId)
    entry.subs.add(subId)
    if (canonicalString(merged) === canonicalString(entry.doc)) {
      if (!known) this.send({ t: "added", c: coll, id, ct, s: [subId] })
      return
    }
    entry.doc = merged
    if (known) this.sendChange(coll, id, ct, entry.doc, merged)
    else this.send({ t: "added", c: coll, id, d: merged, ct, s: [subId] })
  }

  private changed(
    coll: string,
    key: string,
    id: unknown,
    subId: string,
    doc: Doc,
    coverage: Coverage,
    ct: ClusterTime,
  ): void {
    this.rebinding.get(subId)?.add(key)
    const entry = this.mergeBox.get(key)
    if (entry === undefined || !entry.subs.has(subId)) {
      this.added(coll, key, id, subId, doc, ct)
      return
    }
    const next: Doc = {}
    for (const field of Object.keys(entry.doc))
      if (!coverage.covers(field)) next[field] = entry.doc[field]
    Object.assign(next, doc)
    const before = entry.doc
    entry.doc = next
    this.sendChange(coll, id, ct, before, next)
  }

  private sendChange(coll: string, id: unknown, ct: ClusterTime, before: Doc, after: Doc): void {
    const { set, unset } = diff(before, after)
    if (Object.keys(set).length === 0 && unset.length === 0) return
    if (this.diffs) {
      this.send({
        t: "changed",
        c: coll,
        id,
        ct,
        ...(Object.keys(set).length === 0 ? {} : { set }),
        ...(unset.length === 0 ? {} : { unset }),
      })
    } else {
      this.send({ t: "changed", c: coll, id, ct, d: after, replace: true })
    }
  }

  private removed(coll: string, key: string, subId: string, ct: ClusterTime): void {
    this.rebinding.get(subId)?.delete(key)
    const entry = this.mergeBox.get(key)
    if (entry === undefined || !entry.subs.has(subId)) return
    entry.subs.delete(subId)
    if (entry.subs.size === 0) this.mergeBox.delete(key)
    this.send({ t: "removed", c: coll, id: entry.id, ct, s: [subId] })
  }

  /** Removes a subscription from the merge box without messages (used by `unsub` and resync). */
  forget(subId: string): void {
    this.rebinding.delete(subId)
    for (const [key, entry] of this.mergeBox) {
      if (!entry.subs.delete(subId)) continue
      if (entry.subs.size === 0) this.mergeBox.delete(key)
    }
  }

  /** Number of documents held for the client. */
  get documents(): number {
    return this.mergeBox.size
  }

  /** Bytes waiting to be written. */
  get queuedBytes(): number {
    return this.socket?.bufferedAmount ?? 0
  }

  /** Closes the socket. */
  close(code: number, reason: string): void {
    this.flush()
    this.socket?.close(code, reason)
    this.socket = undefined
  }
}
