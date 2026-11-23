import { BSON } from "mongodb"

/**
 * A key that two `_id`s share only when MongoDB treats them as the same document, or `undefined` when this
 * cannot be told. Strings compare by bytes unless the collection has a collation (`collated`); numbers
 * compare by value across BSON types (`Int32`, `Long` and `Double` are one `_id` when equal, `NaN` equals
 * `NaN`), which `BigInt` states exactly for whole numbers. Other types, such as `Decimal128` and dates,
 * have no key.
 */
function idKey(id: unknown, collated: boolean): string | undefined {
  if (typeof id === "string") return collated ? undefined : `s${id}`
  if (id instanceof BSON.ObjectId) return `o${id.toHexString()}`
  if (typeof id === "number") return numberKey(id)
  if (id instanceof BSON.Int32 || id instanceof BSON.Double) return numberKey(id.value)
  if (id instanceof BSON.Long) return `n${id.toBigInt()}`
  return undefined
}

function numberKey(value: number): string {
  if (Number.isNaN(value)) return "nNaN"
  if (!Number.isFinite(value)) return value > 0 ? "n+inf" : "n-inf"
  return Number.isInteger(value) ? `n${BigInt(value)}` : `d${value}`
}

interface Taken {
  readonly keys: Set<string>
  /** Whether a write named an `_id` that has no key: it may be any document of the collection. */
  unknown: boolean
  writes: number
}

/**
 * The `_id`s the writes of a group name, per collection. A write may join a group only when no write of
 * the group may be on the same document: the read back and the precondition check of a grouped write run
 * after the whole group, so they must not see another write's effect, and an `_id` without a key, which
 * could be any document, rules out every other write on its collection.
 */
export class GroupIds {
  private readonly taken = new Map<string, Taken>()

  /** Adds the `_id`s of a write and returns `true`, or returns `false` when they may clash with the group's. */
  admit(collection: string, ids: readonly unknown[], collated: boolean): boolean {
    const entry = this.taken.get(collection) ?? {
      keys: new Set<string>(),
      unknown: false,
      writes: 0,
    }
    if (entry.unknown) return false
    const keys = ids.map((id) => idKey(id, collated))
    const known: string[] = []
    for (const key of keys) if (key !== undefined) known.push(key)
    if (known.length < keys.length) {
      if (entry.writes > 0) return false
      entry.unknown = true
    } else {
      if (known.some((key) => entry.keys.has(key))) return false
      for (const key of known) entry.keys.add(key)
    }
    entry.writes += 1
    this.taken.set(collection, entry)
    return true
  }
}
