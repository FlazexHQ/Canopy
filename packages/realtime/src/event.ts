import { type ClusterTime, canonicalString, isDocument, toCt, ZERO_CT } from "@canopy/protocol"

/** A document as read from MongoDB. */
export type Doc = Record<string, unknown>

/** A change event in the engine's own form. */
export interface NormalizedEvent {
  /** Cluster time. Not unique per event: transactions and, since MongoDB 8.0, unrelated events can share it. */
  readonly ct: ClusterTime
  readonly token: unknown
  readonly wallTime: Date | undefined
  readonly coll: string
  readonly op: "insert" | "update" | "replace" | "delete"
  readonly id: unknown
  readonly key: string
  /** `undefined` when not requested or unavailable, `null` when there is none (insert). */
  pre: Doc | null | undefined
  /**
   * `undefined` when unknown (to be resolved lazily), `null` when the document no longer exists. An update
   * event whose post image is unavailable carries `fullDocument: null`, which is normalized to `undefined`.
   */
  post: Doc | null | undefined
  readonly diff: { readonly set: Doc; readonly unset: readonly string[] } | undefined
}

/** A DDL or stream level event. */
export interface ControlEvent {
  readonly ct: ClusterTime
  readonly token: unknown
  readonly kind: "drop" | "rename" | "dropDatabase" | "invalidate"
  readonly coll: string | undefined
}

/** Returns the cache key of a document: `collection/canonical(_id)`. */
export function docKey(coll: string, id: unknown): string {
  return `${coll}/${canonicalString(id)}`
}

function asDoc(value: unknown): Doc | null | undefined {
  if (value === null) return null
  return isDocument(value) ? value : undefined
}

/**
 * Converts a raw change stream event into a {@link NormalizedEvent} or {@link ControlEvent}. Returns
 * `undefined` for events the engine ignores.
 */
export function normalize(
  raw: Record<string, unknown>,
): NormalizedEvent | ControlEvent | undefined {
  const op = raw["operationType"]
  const ct = toCt(raw["clusterTime"]) ?? ZERO_CT
  const token = raw["_id"]
  const ns = isDocument(raw["ns"]) ? raw["ns"] : undefined
  const coll = typeof ns?.["coll"] === "string" ? ns["coll"] : undefined
  if (op === "drop" || op === "rename" || op === "dropDatabase" || op === "invalidate") {
    return { ct, token, kind: op, coll }
  }
  if (op !== "insert" && op !== "update" && op !== "replace" && op !== "delete") return undefined
  if (coll === undefined) return undefined
  const documentKey = isDocument(raw["documentKey"]) ? raw["documentKey"] : {}
  const id = documentKey["_id"]
  const wall = raw["wallTime"]
  let diff: NormalizedEvent["diff"]
  if (op === "update" && isDocument(raw["updateDescription"])) {
    const description = raw["updateDescription"]
    const set = isDocument(description["updatedFields"]) ? description["updatedFields"] : {}
    const removed = Array.isArray(description["removedFields"]) ? description["removedFields"] : []
    diff = { set, unset: removed.filter((field): field is string => typeof field === "string") }
  }
  const rawPost = asDoc(raw["fullDocument"])
  const post = op === "delete" ? null : op === "update" && rawPost === null ? undefined : rawPost
  const rawPre = asDoc(raw["fullDocumentBeforeChange"])
  const pre = op === "insert" ? null : rawPre === null ? undefined : rawPre
  return {
    ct,
    token,
    wallTime: wall instanceof Date ? wall : undefined,
    coll,
    op,
    id,
    key: docKey(coll, id),
    pre,
    post,
    diff,
  }
}

/** Returns true for data events. */
export function isDataEvent(event: NormalizedEvent | ControlEvent): event is NormalizedEvent {
  return "op" in event
}

/** Merges the fragments of a split event (`$changeStreamSplitLargeEvent`). */
export function mergeFragments(
  fragments: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const fragment of fragments) {
    for (const [name, value] of Object.entries(fragment)) {
      if (name === "splitEvent") continue
      out[name] = value
    }
  }
  return out
}
