import type { Authenticator } from "@canopy/auth"
import type * as Policy from "@canopy/policy"
import type * as Rest from "@canopy/rest"
import type { Collection, Db } from "mongodb"

/**
 * The scenarios of the scale benchmark, shared by `scale.ts` (one checkout against the driver) and
 * `compare.ts` (two checkouts against each other and the driver). Everything that depends on a checkout
 * (the policy builders, `ReadPath`, `WritePath` and the REST handler) is passed in, so the same scenario
 * runs against the code of either checkout.
 */
export const OWNERS = 1000
export const TENANTS = 100
export const STATUSES = ["open", "paid", "shipped", "closed"] as const

export interface Order {
  _id: number
  tenantId: string
  ownerId: string
  status: string
  amount: number
  createdAt: Date
  title: string
  tags: string[]
  address: { city: string; zip: string; country: string }
  n: number
}

const CITIES = ["Lisbon", "Osaka", "Denver", "Nairobi", "Oslo", "Lima", "Pune", "Perth"]

export function makeOrder(i: number): Order {
  const owner = i % OWNERS
  return {
    _id: i,
    tenantId: `t${owner % TENANTS}`,
    ownerId: `u${owner}`,
    status: STATUSES[(i * 7) % STATUSES.length] ?? "open",
    amount: ((i * 2654435761) % 100_000) / 100,
    createdAt: new Date(1_700_000_000_000 + i * 1000),
    title: `Order ${i} for customer ${owner} with a short description`,
    tags: [`k${i % 13}`, `k${i % 17}`],
    address: {
      city: CITIES[i % CITIES.length] ?? "Lisbon",
      zip: String(10000 + (i % 89999)),
      country: "PT",
    },
    n: 0,
  }
}

/**
 * The benchmark's policies. `authenticated` owns its orders without an update `check`, so its single
 * document writes take the fast path. `clerk` updates the orders of its tenant under a `check` on
 * `status`, which an update of `status` cannot imply, so those writes run in a transaction.
 */
export function benchPolicies(policy: typeof Policy): Policy.PolicyEngine {
  const { allow, auth, collection } = policy
  const orders = collection("orders", {
    exposed: true,
    policies: [
      allow.read("authenticated").where({ ownerId: auth("sub") }),
      allow.insert("authenticated").check({ ownerId: auth("sub") }),
      allow.update("authenticated").where({ ownerId: auth("sub") }),
      allow.delete("authenticated").where({ ownerId: auth("sub") }),
      allow.read("manager").where({ tenantId: auth("tenant") }),
      allow.read("auditor"),
      allow.read("editor"),
      allow.insert("editor"),
      allow.update("editor"),
      allow.read("clerk").where({ tenantId: auth("tenant") }),
      allow
        .update("clerk")
        .where({ tenantId: auth("tenant") })
        .check({ status: { $in: [...STATUSES] } }),
    ],
  })
  const ingest = collection("ingest", {
    exposed: true,
    policies: [
      allow.read("authenticated").where({ ownerId: auth("sub") }),
      allow.insert("authenticated").check({ ownerId: auth("sub") }),
    ],
  })
  return new policy.PolicyEngine(policy.createPolicySet([orders, ingest]))
}

function caller(roles: string[], claims: Record<string, unknown>): Rest.Caller {
  return {
    context: { roles: new Set(["authenticated", ...roles]), claims, now: new Date() },
    subject: String(claims["sub"]),
  }
}

export const ownerOf = (n: number): Rest.Caller => caller([], { sub: `u${n}` })
const managerOf = (n: number): Rest.Caller => caller(["manager"], { sub: `m${n}`, tenant: `t${n}` })
const clerkOf = (n: number): Rest.Caller => caller(["clerk"], { sub: `c${n}`, tenant: `t${n}` })
const auditor = caller(["auditor"], { sub: "audit" })

/**
 * An authenticator for the `http` group that skips token verification: the bearer token names the owner
 * (`u17`), so the group prices routing, EJSON and the ETag rather than JWT signatures.
 */
function benchAuthenticator(): Authenticator {
  const stub = {
    authenticate(_key: string, token: string | undefined) {
      const sub = token ?? "anon"
      return Promise.resolve({
        context: { roles: new Set(["authenticated"]), claims: { sub }, now: new Date() },
        subject: sub,
        expiresAt: undefined,
      })
    },
  }
  return stub as unknown as Authenticator
}

/** One closed loop operation. `i` counts the calls of the scenario. */
export type Op = (i: number) => Promise<unknown>

/** A scenario: its name and operation. Driver scenarios start with `driver:`. */
export type Scenario = readonly [name: string, op: Op]

/** What the Canopy scenarios run against. */
export interface Target {
  readonly reads: Rest.ReadPath
  readonly writes: Rest.WritePath
  readonly http: Rest.RestHandler
}

/** Shared state of one tier. */
export interface TierState {
  readonly coll: Collection<Order>
  readonly db: Db
  /** Documents `0 .. size` exist. */
  readonly size: number
  /** The next free `_id` for inserts, shared by every scenario so ids never collide. */
  nextInsert: number
  /** The `_id`s seeded for delete scenarios, consumed in order. */
  victims: number[]
}

export const rand = (n: number): number => Math.floor(Math.random() * n)

/** `count` new orders of owner `u1` with ids that no other scenario uses. */
function batchOf(state: TierState, count: number): Order[] {
  const docs: Order[] = []
  for (let i = 0; i < count; i += 1) {
    state.nextInsert += 1
    docs.push({ ...makeOrder(state.nextInsert), ownerId: "u1" })
  }
  return docs
}

const scanFilter = (): Record<string, unknown> => ({
  amount: { $gt: 999.9 + Math.random() / 20 },
})

/** A mutation ID that is unique across processes and runs. */
export function mutationId(i: number): string {
  return `bench_${process.pid}_${Date.now().toString(36)}_${i}_${rand(1e9)}`
}

export const BASE = "http://bench.local/rest/v1"

export async function drain(response: Response): Promise<void> {
  const text = await response.text()
  if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
}

/** The driver scenarios of every group, keyed by group name. */
export function driverGroups(state: TierState): Map<string, Scenario[]> {
  const { coll } = state
  const groups = new Map<string, Scenario[]>()
  groups.set("owner page", [
    [
      "driver: owner page (50, sorted)",
      () =>
        coll
          .find({ ownerId: `u${rand(OWNERS)}` })
          .sort({ createdAt: -1, _id: 1 })
          .limit(51)
          .toArray(),
    ],
  ])
  groups.set("tenant page", [
    [
      "driver: tenant filter page (100)",
      () =>
        coll
          .find({ tenantId: `t${rand(TENANTS)}`, status: "open" })
          .sort({ createdAt: -1, _id: 1 })
          .limit(101)
          .toArray(),
    ],
  ])
  groups.set("cursor", [
    [
      "driver: 10th page via range",
      async () => {
        const owner = `u${rand(OWNERS)}`
        let last: Order | undefined
        for (let page = 0; page < 10; page += 1) {
          const range =
            last === undefined
              ? {}
              : {
                  $or: [
                    { createdAt: { $lt: last.createdAt } },
                    { createdAt: last.createdAt, _id: { $gt: last._id } },
                  ],
                }
          const docs = await coll
            .find({ ownerId: owner, ...range })
            .sort({ createdAt: -1, _id: 1 })
            .limit(21)
            .toArray()
          if (docs.length <= 20) return
          last = docs[19]
        }
      },
    ],
  ])
  groups.set("findById", [
    ["driver: findById", () => coll.findOne({ _id: rand(state.size) })],
    [
      "driver: findById with owner filter",
      () => {
        const id = rand(state.size)
        return coll.findOne({ _id: id, ownerId: `u${id % OWNERS}` })
      },
    ],
  ])
  groups.set("count", [
    ["driver: owner count", () => coll.countDocuments({ ownerId: `u${rand(OWNERS)}` })],
  ])
  groups.set("scan", [
    ["driver: unindexed filter (scan)", () => coll.find(scanFilter()).limit(51).toArray()],
    [
      "driver: unindexed filter in _id order (scan)",
      () => coll.find(scanFilter()).sort({ _id: 1 }).hint({ $natural: 1 }).limit(51).toArray(),
    ],
  ])
  groups.set("update", [
    [
      "driver: updateOne (majority)",
      () => {
        const id = rand(state.size)
        return coll.updateOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { $inc: { n: 1 } },
          { writeConcern: { w: "majority" } },
        )
      },
    ],
  ])
  groups.set("replace", [
    [
      "driver: replaceOne (majority)",
      () => {
        const id = rand(state.size)
        return coll.replaceOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { ...makeOrder(id), n: rand(1000) },
          { writeConcern: { w: "majority" } },
        )
      },
    ],
  ])
  groups.set("insert", [
    [
      "driver: insertOne (majority)",
      () => {
        state.nextInsert += 1
        const doc = makeOrder(state.nextInsert)
        return coll.insertOne(
          { ...doc, ownerId: "u1", tenantId: "t1" },
          { writeConcern: { w: "majority" } },
        )
      },
    ],
  ])
  groups.set("delete", [
    [
      "driver: deleteOne (majority)",
      () => {
        const id = state.victims.pop()
        if (id === undefined) throw new Error("Out of documents to delete")
        return coll.deleteOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { writeConcern: { w: "majority" } },
        )
      },
    ],
  ])
  groups.set("insertMany", [
    [
      "driver: insertMany of 1,000 (majority)",
      () =>
        state.db
          .collection<Order>("ingest")
          .insertMany(batchOf(state, 1000), { ordered: true, writeConcern: { w: "majority" } }),
    ],
  ])
  groups.set("http", [])
  return groups
}

/** The Canopy scenarios of every group for one checkout, keyed by group name. */
export function canopyGroups(state: TierState, target: Target): Map<string, Scenario[]> {
  const { reads, writes, http } = target
  const groups = new Map<string, Scenario[]>()
  groups.set("owner page", [
    [
      "canopy: owner page (50, sorted)",
      () =>
        reads.find(ownerOf(rand(OWNERS)), {
          collection: "orders",
          sort: { createdAt: -1 },
          limit: 50,
        }),
    ],
  ])
  groups.set("tenant page", [
    [
      "canopy: tenant filter page (100)",
      () =>
        reads.find(managerOf(rand(TENANTS)), {
          collection: "orders",
          filter: { status: "open" },
          sort: { createdAt: -1 },
          limit: 100,
        }),
    ],
  ])
  groups.set("cursor", [
    [
      "canopy: 10th page via cursor",
      async () => {
        const who = ownerOf(rand(OWNERS))
        let after: string | undefined
        for (let page = 0; page < 10; page += 1) {
          const result = await reads.find(who, {
            collection: "orders",
            sort: { createdAt: -1 },
            limit: 20,
            ...(after === undefined ? {} : { after }),
          })
          if (result.next === null) return
          after = result.next
        }
      },
    ],
  ])
  groups.set("findById", [
    [
      "canopy: findById",
      () => {
        const id = rand(state.size)
        return reads.findById(ownerOf(id % OWNERS), "orders", id)
      },
    ],
  ])
  groups.set("count", [
    [
      "canopy: owner count (exact)",
      () => reads.count(ownerOf(rand(OWNERS)), "orders", {}, "exact"),
    ],
  ])
  groups.set("scan", [
    [
      "canopy: unindexed filter (scan)",
      () => reads.find(auditor, { collection: "orders", filter: scanFilter(), limit: 50 }),
    ],
  ])
  groups.set("update", [
    [
      "canopy: update, owner policy (fast path)",
      () => {
        const id = rand(state.size)
        return writes.execute(ownerOf(id % OWNERS), {
          op: "update",
          collection: "orders",
          id,
          update: { $inc: { n: 1 } },
        })
      },
    ],
    [
      "canopy: update, transaction with check",
      () => {
        const id = rand(state.size)
        return writes.execute(clerkOf((id % OWNERS) % TENANTS), {
          op: "update",
          collection: "orders",
          id,
          update: { $set: { status: STATUSES[rand(STATUSES.length)] } },
        })
      },
    ],
    [
      "canopy: update with mutation ID",
      (i) => {
        const id = rand(state.size)
        return writes.execute(
          ownerOf(id % OWNERS),
          { op: "update", collection: "orders", id, update: { $inc: { n: 1 } } },
          { mutationId: mutationId(i) },
        )
      },
    ],
  ])
  groups.set("replace", [
    [
      "canopy: replace",
      () => {
        const id = rand(state.size)
        const { _id: _ignored, ...doc } = makeOrder(id)
        return writes.execute(ownerOf(id % OWNERS), {
          op: "replace",
          collection: "orders",
          id,
          doc: { ...doc, n: rand(1000) },
        })
      },
    ],
  ])
  groups.set("insert", [
    [
      "canopy: insert, check through $documents",
      () => {
        state.nextInsert += 1
        const doc = makeOrder(state.nextInsert)
        return writes.execute(ownerOf(1), {
          op: "insert",
          collection: "orders",
          doc: { ...doc, ownerId: "u1", tenantId: "t1" },
        })
      },
    ],
    [
      "canopy: insert with mutation ID",
      (i) => {
        state.nextInsert += 1
        const doc = makeOrder(state.nextInsert)
        return writes.execute(
          ownerOf(1),
          { op: "insert", collection: "orders", doc: { ...doc, ownerId: "u1", tenantId: "t1" } },
          { mutationId: mutationId(i) },
        )
      },
    ],
  ])
  groups.set("delete", [
    [
      "canopy: delete",
      () => {
        const id = state.victims.pop()
        if (id === undefined) throw new Error("Out of documents to delete")
        return writes.execute(ownerOf(id % OWNERS), { op: "delete", collection: "orders", id })
      },
    ],
  ])
  groups.set("insertMany", [
    [
      "canopy: insertMany of 1,000",
      () =>
        writes.execute(ownerOf(1), {
          op: "insertMany",
          collection: "ingest",
          docs: batchOf(state, 1000),
        }),
    ],
    [
      "canopy: insertMany of 1,000, no documents returned",
      () =>
        writes.execute(
          ownerOf(1),
          { op: "insertMany", collection: "ingest", docs: batchOf(state, 1000) },
          { returnDocuments: false },
        ),
    ],
  ])
  const authorization = (owner: number) => ({ authorization: `Bearer u${owner}` })
  groups.set("http", [
    [
      "http: GET page of 50",
      async () => {
        const owner = rand(OWNERS)
        await drain(
          await http.fetch(
            new Request(`${BASE}/orders?sort=-createdAt&limit=50`, {
              headers: authorization(owner),
            }),
          ),
        )
      },
    ],
    [
      "http: GET by id",
      async () => {
        const id = rand(state.size)
        await drain(
          await http.fetch(
            new Request(`${BASE}/orders/${id}`, { headers: authorization(id % OWNERS) }),
          ),
        )
      },
    ],
    [
      "http: PATCH by id",
      async () => {
        const id = rand(state.size)
        await drain(
          await http.fetch(
            new Request(`${BASE}/orders/${id}`, {
              method: "PATCH",
              headers: { ...authorization(id % OWNERS), "content-type": "application/json" },
              body: '{"$inc":{"n":1}}',
            }),
          ),
        )
      },
    ],
  ])
  return groups
}

/** Options for a REST handler over the benchmark's database. */
export function handlerOptions(
  client: unknown,
  database: string,
  metaDatabase: string,
  policies: unknown,
): Record<string, unknown> {
  return {
    client,
    database,
    metaDatabase,
    policies,
    authenticator: benchAuthenticator(),
    idTypes: { orders: "number" },
  }
}

/** Seeds documents `from .. to` from 4 workers. Returns documents per second. */
export async function seedTo(coll: Collection<Order>, from: number, to: number): Promise<number> {
  const started = performance.now()
  const batch = 5000
  const ranges: [number, number][] = []
  for (let i = from; i < to; i += batch) ranges.push([i, Math.min(to, i + batch)])
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < ranges.length) {
      const range = ranges[cursor]
      cursor += 1
      if (range === undefined) return
      const docs: Order[] = []
      for (let i = range[0]; i < range[1]; i += 1) docs.push(makeOrder(i))
      await coll.insertMany(docs, { ordered: false })
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return (to - from) / ((performance.now() - started) / 1000)
}

/** The first `_id` of the documents the delete scenarios remove, far above every seeded tier. */
export const VICTIM_BASE = 2_000_000_000

/** Inserts `count` documents for the delete scenarios to remove and returns their ids. */
export async function seedVictims(coll: Collection<Order>, count: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i += 1) ids.push(VICTIM_BASE + i)
  for (let i = 0; i < ids.length; i += 5000)
    await coll.insertMany(
      ids.slice(i, i + 5000).map((id) => makeOrder(id)),
      { ordered: false },
    )
  return ids
}
