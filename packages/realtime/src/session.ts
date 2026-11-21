import {
  type ClusterTime,
  canonicalString,
  compareCt,
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
  /** The frame's JSON text without `seq` and the closing brace, shared between sessions where possible. */
  readonly head: string
}

/** Bytes counted per buffered frame besides its head: `,"seq":N}`. */
const FRAME_OVERHEAD = 16

/** The JSON text of a message without its closing brace, so `seq` (and a sub id) can be appended. */
function headOf(message: Outgoing): string {
  return encodeMessage(message as SequencedMessage).slice(0, -1)
}

function frameText(head: string, seq: number): string {
  return `${head},"seq":${seq}}`
}

/**
 * A few recently encoded message heads, keyed by the identity of their inputs. The sessions of one event
 * are notified one after another with the same document objects, so the first session encodes a message
 * and the others reuse its text.
 */
class HeadMemo {
  private readonly keys: (readonly unknown[])[] = []
  private readonly heads: (string | null)[] = []
  private next = 0

  get(key: readonly unknown[], encode: () => string | null): string | null {
    for (let slot = 0; slot < this.keys.length; slot += 1) {
      const known = this.keys[slot]
      if (known?.every((part, index) => part === key[index]) === true)
        return this.heads[slot] ?? null
    }
    const head = encode()
    this.keys[this.next] = key
    this.heads[this.next] = head
    this.next = (this.next + 1) % 8
    return head
  }
}

const addedHeads = new HeadMemo()
const changedHeads = new HeadMemo()
const removedHeads = new HeadMemo()

/** The per subscription part of `added` and `removed`: `,"s":["<subId>"]`. */
function subsSuffix(subId: string): string {
  return `,"s":[${JSON.stringify(subId)}]`
}

interface MergeEntry {
  readonly coll: string
  readonly id: unknown
  readonly subs: Set<string>
  doc: Doc
  /** The cluster time of the version the client holds, for the fields without their own in `stamps`. */
  ct: ClusterTime
  /**
   * Whether `ct` also tells that the fields `doc` lacks were absent then, as it does after a subscription
   * that covers every field wrote the whole document. Otherwise a missing field is simply unknown.
   */
  whole: boolean
  /** Fields whose value (or absence) comes from another cluster time than `ct`. */
  stamps: Map<string, ClusterTime> | undefined
}

/** When the client's value of `field` was current, or `undefined` when nothing is known about it. */
function stampOf(entry: MergeEntry, field: string): ClusterTime | undefined {
  return (
    entry.stamps?.get(field) ??
    (entry.whole || Object.hasOwn(entry.doc, field) ? entry.ct : undefined)
  )
}

/** Coverage of one subscription's projection: which top level fields it owns in the merge box. */
export interface Coverage {
  covers(field: string): boolean
}

/** Every field. */
export const FULL_COVERAGE: Coverage = { covers: () => true }

/**
 * Merges one subscription's version of a document into the version the client holds. Each field the
 * subscription covers takes the new value (or goes, when the version lacks it) unless the client already
 * holds that field from a later cluster time. Subscriptions read their snapshots at different times, so
 * one whose snapshot is older must not move the client back to a version another one already replaced:
 * nothing would correct it when that subscription later leaves the document.
 */
function merge(entry: MergeEntry, doc: Doc, coverage: Coverage, ct: ClusterTime): Doc {
  if (coverage === FULL_COVERAGE && entry.stamps === undefined && compareCt(ct, entry.ct) >= 0) {
    entry.ct = ct
    entry.whole = true
    return doc
  }
  const next: Doc = { ...entry.doc }
  const stamps = new Map<string, ClusterTime>()
  const fields = new Set([
    ...Object.keys(entry.doc),
    ...Object.keys(doc),
    ...(entry.stamps?.keys() ?? []),
  ])
  for (const field of fields) {
    const stamp = stampOf(entry, field)
    if (stamp !== undefined) stamps.set(field, stamp)
  }
  let took = 0
  for (const field of fields) {
    if (!coverage.covers(field)) continue
    const stamp = stamps.get(field)
    if (stamp !== undefined && compareCt(ct, stamp) < 0) continue
    stamps.set(field, ct)
    took++
    if (Object.hasOwn(doc, field)) next[field] = doc[field]
    else delete next[field]
  }
  if (coverage === FULL_COVERAGE && took === fields.size) {
    entry.ct = ct
    entry.whole = true
    entry.stamps = undefined
    return next
  }
  entry.stamps = stamps
  entry.whole = false
  return next
}

/** Session limits. */
export interface SessionLimits {
  readonly resumeBufferBytes: number
  readonly softQueueBytes: number
  readonly hardQueueBytes: number
}

/**
 * The head of the `changed` message from `before` to `after`: the changed fields with `diff`, the whole
 * document otherwise. `null` when nothing changed.
 */
function changeHead(
  coll: string,
  id: unknown,
  ct: ClusterTime,
  before: Doc,
  after: Doc,
  diffs: boolean,
): string | null {
  const { set, unset } = diff(before, after)
  if (Object.keys(set).length === 0 && unset.length === 0) return null
  return diffs
    ? headOf({
        t: "changed",
        c: coll,
        id,
        ct,
        ...(Object.keys(set).length === 0 ? {} : { set }),
        ...(unset.length === 0 ? {} : { unset }),
      })
    : headOf({ t: "changed", c: coll, id, ct, d: after, replace: true })
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
  private readonly explanations = new Map<string, Record<string, unknown>>()
  private readonly readied = new Set<string>()
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
    for (const frame of this.frames)
      if (frame.seq > afterSeq) this.write(frameText(frame.head, frame.seq))
    this.flush()
    return true
  }

  /** Sends a message, assigning the next sequence number. */
  send(message: Outgoing): void {
    if (this.dropped) return
    this.sendHead(headOf(message))
  }

  /**
   * Sends a message given as its JSON text without the closing brace (see `headOf`), assigning the next
   * sequence number. The head is kept in the replay buffer as is, so sessions sending the same head share
   * its memory.
   */
  private sendHead(head: string): void {
    if (this.dropped) return
    this.seq += 1
    this.frames.push({ seq: this.seq, head })
    this.frameBytes += head.length + FRAME_OVERHEAD
    while (this.frameBytes > this.limits.resumeBufferBytes && this.frames.length > 1) {
      const removed = this.frames.shift()
      if (removed !== undefined) this.frameBytes -= removed.head.length + FRAME_OVERHEAD
    }
    if (this.socket !== undefined) this.write(frameText(head, this.seq))
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
      added: (key, id, doc, ct) => this.added(coll, key, id, subId, project(doc), coverage, ct),
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
   * longer contains is sent as `removed` instead of a second `ready`. A move that starts before the first
   * `ready` ends with that `ready`, so the client always gets one. The client never sees the subscription
   * empty.
   */
  rebind(subId: string): void {
    this.rebinding.set(subId, new Set())
  }

  /** Sends `report` with the next `ready` of the subscription (the answer to `sub.o.explain`). */
  explainOnReady(subId: string, report: Record<string, unknown>): void {
    this.explanations.set(subId, report)
  }

  private ready(subId: string, ct: ClusterTime): void {
    const seen = this.rebinding.get(subId)
    if (seen !== undefined) {
      this.rebinding.delete(subId)
      for (const [key, entry] of [...this.mergeBox]) {
        if (entry.subs.has(subId) && !seen.has(key)) this.removed(entry.coll, key, subId, ct)
      }
      if (this.readied.has(subId)) return
    }
    this.readied.add(subId)
    const explain = this.explanations.get(subId)
    this.explanations.delete(subId)
    this.send({ t: "ready", s: subId, ct, ...(explain === undefined ? {} : { explain }) })
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
    coverage: Coverage,
    ct: ClusterTime,
  ): void {
    this.rebinding.get(subId)?.add(key)
    const entry = this.mergeBox.get(key)
    if (entry === undefined) {
      this.mergeBox.set(key, {
        coll,
        id,
        subs: new Set([subId]),
        doc,
        ct,
        whole: coverage === FULL_COVERAGE,
        stamps: undefined,
      })
      const head = addedHeads.get([coll, key, ct, doc], () =>
        headOf({ t: "added", c: coll, id, d: doc, ct } as Outgoing),
      )
      this.sendHead(`${head}${subsSuffix(subId)}`)
      return
    }
    const merged = merge(entry, doc, coverage, ct)
    const known = entry.subs.has(subId)
    entry.subs.add(subId)
    if (canonicalString(merged) === canonicalString(entry.doc)) {
      if (!known) this.send({ t: "added", c: coll, id, ct, s: [subId] })
      return
    }
    const before = entry.doc
    entry.doc = merged
    if (known) this.sendChange(coll, id, ct, before, merged)
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
      this.added(coll, key, id, subId, doc, coverage, ct)
      return
    }
    if (
      coverage === FULL_COVERAGE &&
      entry.subs.size === 1 &&
      !this.rebinding.has(subId) &&
      entry.stamps === undefined &&
      compareCt(ct, entry.ct) >= 0
    ) {
      const before = entry.doc
      entry.doc = doc
      entry.ct = ct
      entry.whole = true
      const head = changedHeads.get([coll, key, ct, before, doc, this.diffs], () =>
        changeHead(coll, id, ct, before, doc, this.diffs),
      )
      if (head !== null) this.sendHead(head)
      return
    }
    const next = merge(entry, doc, coverage, ct)
    const before = entry.doc
    entry.doc = next
    this.sendChange(coll, id, ct, before, next)
  }

  private sendChange(coll: string, id: unknown, ct: ClusterTime, before: Doc, after: Doc): void {
    const head = changeHead(coll, id, ct, before, after, this.diffs)
    if (head !== null) this.sendHead(head)
  }

  private removed(coll: string, key: string, subId: string, ct: ClusterTime): void {
    this.rebinding.get(subId)?.delete(key)
    const entry = this.mergeBox.get(key)
    if (entry === undefined || !entry.subs.has(subId)) return
    entry.subs.delete(subId)
    if (entry.subs.size === 0) this.mergeBox.delete(key)
    const head = removedHeads.get([coll, key, ct, entry.id], () =>
      headOf({ t: "removed", c: coll, id: entry.id, ct } as Outgoing),
    )
    this.sendHead(`${head}${subsSuffix(subId)}`)
  }

  /** Removes a subscription from the merge box without messages (used by `unsub` and resync). */
  forget(subId: string): void {
    this.rebinding.delete(subId)
    this.readied.delete(subId)
    this.explanations.delete(subId)
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
