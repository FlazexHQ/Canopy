import type { PolicySet } from "@canopy/policy"
import { databasePolicies, directoryPolicies } from "@canopy/realtime"
import { MongoClient } from "mongodb"
import { confirmed, messageOf, type Output } from "./output.ts"

function isDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** One suggested index. */
export interface IndexAdvice {
  readonly collection: string
  /** The fields of the index, in order, all ascending. */
  readonly fields: readonly string[]
  /** Which policies or context lookups filter on these fields. */
  readonly reasons: readonly string[]
}

/**
 * The fields a filter template compares by equality on every query: plain values, policy variables and
 * `$eq`/`$in`, at the top level and inside `$and`. Branches of `$or` and `$nor` are left out, since no single
 * index serves them. `_id` is always indexed and is skipped.
 */
export function equalityFields(filter: unknown): string[] {
  if (!isDocument(filter)) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" && Array.isArray(value)) {
      for (const part of value) for (const field of equalityFields(part)) out.push(field)
      continue
    }
    if (key.startsWith("$") || key === "_id") continue
    if (!isDocument(value)) out.push(key)
    else if (Object.hasOwn(value, "$auth") || Object.hasOwn(value, "$ctx")) out.push(key)
    else if (Object.hasOwn(value, "$eq") || Object.hasOwn(value, "$in")) out.push(key)
    else if (Object.keys(value).every((name) => !name.startsWith("$"))) out.push(key)
  }
  return [...new Set(out)]
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((field) => b.includes(field))

/** Whether an index with `key` fields serves an equality query on `fields`. */
export function covers(key: readonly string[], fields: readonly string[]): boolean {
  return key.length >= fields.length && sameSet(key.slice(0, fields.length), fields)
}

/**
 * Index advice for a policy set: one index per distinct set of equality fields in `using` clauses, and one
 * per context lookup `where` clause on the collection it reads. A suggestion served by a longer one is
 * dropped, and so is any suggestion an existing index (`existing`: the fields of each index by collection)
 * already serves.
 */
export function adviseIndexes(
  set: PolicySet,
  existing: Readonly<Record<string, readonly (readonly string[])[]>> = {},
): IndexAdvice[] {
  const byCollection = new Map<string, { fields: string[]; reasons: string[] }[]>()
  const add = (collection: string, fields: string[], reason: string): void => {
    if (fields.length === 0) return
    const list = byCollection.get(collection) ?? []
    byCollection.set(collection, list)
    const same = list.find((entry) => sameSet(entry.fields, fields))
    if (same === undefined) list.push({ fields, reasons: [reason] })
    else if (!same.reasons.includes(reason)) same.reasons.push(reason)
  }
  for (const def of set.collections.values())
    for (const policy of def.policies)
      add(def.collection, equalityFields(policy.using), `policy "${policy.name}"`)
  for (const [name, lookup] of Object.entries(set.contexts))
    add(lookup.from, equalityFields(lookup.where), `context lookup ${name}`)

  const advice: IndexAdvice[] = []
  for (const [collection, list] of [...byCollection].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const indexes = existing[collection] ?? []
    const needed = list
      .filter((entry) => !indexes.some((key) => covers(key, entry.fields)))
      .sort((a, b) => b.fields.length - a.fields.length)
    const target = new Map<(typeof needed)[number], IndexAdvice & { reasons: string[] }>()
    for (const entry of needed) {
      const longer = needed.find(
        (other) => target.has(other) && other !== entry && covers(other.fields, entry.fields),
      )
      const into = longer === undefined ? undefined : target.get(longer)
      if (into === undefined) {
        const created = { collection, fields: entry.fields, reasons: [...entry.reasons] }
        target.set(entry, created)
        advice.push(created)
        continue
      }
      target.set(entry, into)
      for (const reason of entry.reasons)
        if (!into.reasons.includes(reason)) into.reasons.push(reason)
    }
  }
  return advice
}

/** The shell command that creates a suggested index. */
export function createIndexCommand(advice: IndexAdvice): string {
  const key = Object.fromEntries(advice.fields.map((field) => [field, 1]))
  return `db.getCollection(${JSON.stringify(advice.collection)}).createIndex(${JSON.stringify(key)})`
}

/** Options of `canopy indexes advise` and `create`. */
export interface IndexesOptions {
  readonly mongodbUri: string
  readonly database: string
  /** The policy directory; without it, policies are read from the meta database. */
  readonly dir?: string
  readonly metaDatabase?: string
  /** Create the suggested indexes (after confirmation) instead of only listing them. */
  readonly create: boolean
  readonly yes?: boolean
}

/**
 * `canopy indexes advise | create`: lists indexes that would serve the equality fields of policies and
 * context lookups, then with `create` builds them after confirmation. Indexes are only created on
 * collections that exist, since Canopy never creates collections in the app database.
 */
export async function indexes(options: IndexesOptions, out: Output): Promise<number> {
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
    let set: PolicySet
    try {
      set = await (options.dir === undefined
        ? databasePolicies(client, options.metaDatabase)
        : directoryPolicies(options.dir)
      ).load()
    } catch (error: unknown) {
      out.error(`Policies do not load: ${messageOf(error)}`)
      return 1
    }
    const db = client.db(options.database)
    const names = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((info) => info.name),
    )
    const existing: Record<string, string[][]> = {}
    for (const name of names) {
      if (name.startsWith("system.")) continue
      existing[name] = (await db.collection(name).indexes()).map((index) => Object.keys(index.key))
    }
    const advice = adviseIndexes(set, existing)
    const absent = advice.filter((entry) => !names.has(entry.collection))
    const ready = advice.filter((entry) => names.has(entry.collection))
    if (advice.length === 0) {
      out.log("Every policy equality field is served by an index.")
      return 0
    }
    for (const entry of ready) {
      out.log(`${createIndexCommand(entry)}`)
      out.log(`  for ${entry.reasons.join(", ")}`)
    }
    for (const entry of absent)
      out.log(
        `${entry.collection} does not exist yet; once it does, index ${entry.fields.join(", ")} (for ${entry.reasons.join(", ")})`,
      )
    if (!options.create) {
      out.log(
        `${ready.length} ${ready.length === 1 ? "index" : "indexes"} suggested on ${options.database}.${ready.length > 0 ? " Run canopy indexes create to build them." : ""}`,
      )
      return 0
    }
    if (ready.length === 0) return 0
    const question = `Create ${ready.length} ${ready.length === 1 ? "index" : "indexes"} on ${options.database}?`
    if (!(await confirmed(out, question, options.yes === true))) return 1
    for (const entry of ready) {
      const name = await db
        .collection(entry.collection)
        .createIndex(Object.fromEntries(entry.fields.map((field) => [field, 1])))
      out.log(`created ${entry.collection}.${name}`)
    }
    return 0
  } catch (error: unknown) {
    out.error(`MongoDB error: ${messageOf(error)}`)
    return 1
  } finally {
    await client.close()
  }
}
