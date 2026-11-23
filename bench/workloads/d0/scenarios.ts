import type { Authenticator } from "@canopy/auth"
import type * as Rest from "@canopy/rest"
import type { Collection, MongoClient } from "mongodb"
import {
  BASE,
  drain,
  makeOrder,
  mutationId,
  type Op,
  type Order,
  OWNERS,
  rand,
  STATUSES,
  TENANTS,
  type TierState,
} from "../rest/scenarios.ts"

/**
 * The scenarios of the D0 baseline. Every Canopy scenario is a real `Request` into the REST handler, and
 * every one that has a plain driver equivalent names it, so the report can show what the platform adds in
 * commands, bytes and CPU.
 */
export interface D0Scenario {
  /** `reads` or `writes`. */
  readonly group: "reads" | "writes"
  readonly name: string
  readonly op: Op
  /** The name of the driver scenario that does the same work with the plain driver. */
  readonly reference?: string
  /** Whether the scenario is a plain driver scenario. */
  readonly driver: boolean
  /** Whether its read commands are explained after the window. */
  readonly explain: boolean
  /** Whether the scenario deletes documents and needs victims seeded first. */
  readonly victims: boolean
  /** Runs once before the warm up, for state the operations need (such as cursors). */
  readonly prepare?: () => Promise<void>
}

/** The shared state of the run. */
export interface D0State extends TierState {
  readonly client: MongoClient
}

/**
 * An authenticator that skips token verification so the scenarios price routing, the policy and MongoDB
 * rather than JWT signatures. The bearer token is `u17` (the owner `u17`), `clerk:c1:t5` (a clerk of tenant
 * `t5`) or `auditor`.
 */
export function d0Authenticator(): Authenticator {
  const stub = {
    authenticate(_key: string, token: string | undefined) {
      const text = token ?? "anon"
      const [first, sub, tenant] = text.split(":")
      const roles =
        first === "clerk" || first === "auditor" ? ["authenticated", first] : ["authenticated"]
      const claims: Record<string, unknown> =
        first === "clerk"
          ? { sub: sub ?? "c1", tenant: tenant ?? "t0" }
          : { sub: first === "auditor" ? "audit" : text }
      return Promise.resolve({
        context: { roles: new Set(roles), claims, now: new Date() },
        subject: String(claims["sub"]),
        expiresAt: undefined,
      })
    },
  }
  return stub as unknown as Authenticator
}

const majority = { writeConcern: { w: "majority" as const } }
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const owner = (n: number): string => `u${n}`

/** A document as a relaxed EJSON body. */
function body(doc: Record<string, unknown>): string {
  return JSON.stringify({
    ...doc,
    ...(doc["createdAt"] instanceof Date
      ? { createdAt: { $date: doc["createdAt"].toISOString() } }
      : {}),
  })
}

function fresh(state: D0State, ownerId = "u1", tenantId = "t1"): Order {
  state.nextInsert += 1
  return { ...makeOrder(state.nextInsert), ownerId, tenantId }
}

function victim(state: D0State): number {
  const id = state.victims.pop()
  if (id === undefined) throw new Error("Out of documents to delete")
  return id
}

async function call(
  http: Rest.RestHandler,
  path: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<void> {
  await drain(await http.fetch(new Request(`${BASE}${path}`, init)))
}

function post(
  http: Rest.RestHandler,
  path: string,
  token: string,
  payload: unknown,
  extra: Record<string, string> = {},
): Promise<void> {
  return call(http, path, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json", ...extra },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
}

/** The first page of every owner, so a scenario can ask for the second page by cursor. */
async function firstPages(
  http: Rest.RestHandler,
  coll: Collection<Order>,
): Promise<{ cursors: string[]; lasts: Order[] }> {
  const cursors: string[] = []
  const lasts: Order[] = []
  for (let n = 0; n < OWNERS; n += 1) {
    const response = await http.fetch(
      new Request(`${BASE}/orders?sort=-createdAt&limit=20`, { headers: bearer(owner(n)) }),
    )
    const page = (await response.json()) as { page?: { next?: string | null } }
    if (typeof page.page?.next !== "string") throw new Error(`Owner ${n} has no second page`)
    cursors.push(page.page.next)
    const docs = await coll
      .find({ ownerId: owner(n) })
      .sort({ createdAt: -1, _id: 1 })
      .limit(20)
      .toArray()
    const last = docs[19]
    if (last === undefined) throw new Error(`Owner ${n} has fewer than 20 documents`)
    lasts.push(last)
  }
  return { cursors, lasts }
}

const AGGREGATE = [{ $group: { _id: "$address.city", total: { $sum: "$amount" }, n: { $sum: 1 } } }]

/** The driver and REST scenarios of the D0 baseline, in the order they run. */
export function d0Scenarios(state: D0State, http: Rest.RestHandler): D0Scenario[] {
  const { coll, client } = state
  const list: D0Scenario[] = []
  const pageDriver =
    (limit: number): Op =>
    () =>
      coll
        .find({ ownerId: owner(rand(OWNERS)) })
        .sort({ createdAt: -1, _id: 1 })
        .limit(limit + 1)
        .toArray()
  const pageRest =
    (limit: number): Op =>
    () =>
      call(http, `/orders?sort=-createdAt&limit=${limit}`, {
        headers: bearer(owner(rand(OWNERS))),
      })
  const read = (
    name: string,
    op: Op,
    reference?: string,
    extra: Partial<D0Scenario> = {},
  ): void => {
    list.push({
      group: "reads",
      name,
      op,
      driver: reference === undefined,
      explain: true,
      victims: false,
      ...(reference === undefined ? {} : { reference }),
      ...extra,
    })
  }
  const write = (
    name: string,
    op: Op,
    reference?: string,
    extra: Partial<D0Scenario> = {},
  ): void => {
    list.push({
      group: "writes",
      name,
      op,
      driver: reference === undefined,
      explain: false,
      victims: false,
      ...(reference === undefined ? {} : { reference }),
      ...extra,
    })
  }

  let cursors: string[] = []
  let lasts: Order[] = []
  const prepareCursors = async (): Promise<void> => {
    if (cursors.length > 0) return
    ;({ cursors, lasts } = await firstPages(http, coll))
  }

  read("driver: page of 20", pageDriver(20))
  read("rest: page of 20, owner policy", pageRest(20), "driver: page of 20")
  read("driver: page of 100", pageDriver(100))
  read("rest: page of 100, owner policy", pageRest(100), "driver: page of 100")
  read(
    "driver: second page by range",
    () => {
      const n = rand(OWNERS)
      const last = lasts[n]
      if (last === undefined) throw new Error("No cursor prepared")
      return coll
        .find({
          ownerId: owner(n),
          $or: [
            { createdAt: { $lt: last.createdAt } },
            { createdAt: last.createdAt, _id: { $gt: last._id } },
          ],
        })
        .sort({ createdAt: -1, _id: 1 })
        .limit(21)
        .toArray()
    },
    undefined,
    { prepare: prepareCursors },
  )
  read(
    "rest: second page by cursor",
    () => {
      const n = rand(OWNERS)
      const after = cursors[n]
      if (after === undefined) throw new Error("No cursor prepared")
      return call(http, `/orders?sort=-createdAt&limit=20&after=${encodeURIComponent(after)}`, {
        headers: bearer(owner(n)),
      })
    },
    "driver: second page by range",
    { prepare: prepareCursors },
  )
  read("driver: find by id", () => {
    const id = rand(state.size)
    return coll.findOne({ _id: id, ownerId: owner(id % OWNERS) })
  })
  read(
    "rest: find by id",
    () => {
      const id = rand(state.size)
      return call(http, `/orders/${id}`, { headers: bearer(owner(id % OWNERS)) })
    },
    "driver: find by id",
  )
  read("driver: count", () => coll.countDocuments({ ownerId: owner(rand(OWNERS)) }))
  read("rest: count", () => post(http, "/orders/_count", owner(rand(OWNERS)), {}), "driver: count")
  read("driver: distinct", () => coll.distinct("status", { ownerId: owner(rand(OWNERS)) }))
  read(
    "rest: distinct",
    () => post(http, "/orders/_distinct", owner(rand(OWNERS)), { field: "status" }),
    "driver: distinct",
  )
  read("driver: aggregate", () =>
    coll.aggregate([{ $match: { ownerId: owner(rand(OWNERS)) } }, ...AGGREGATE]).toArray(),
  )
  read(
    "rest: aggregate",
    () => post(http, "/orders/_aggregate", owner(rand(OWNERS)), { pipeline: AGGREGATE }),
    "driver: aggregate",
  )

  write("driver: insertOne (majority)", () => coll.insertOne(fresh(state), majority))
  write(
    "rest: insert",
    () => post(http, "/orders", owner(1), body({ ...fresh(state) })),
    "driver: insertOne (majority)",
  )
  write("driver: updateOne (majority)", () => {
    const id = rand(state.size)
    return coll.updateOne({ _id: id, ownerId: owner(id % OWNERS) }, { $inc: { n: 1 } }, majority)
  })
  write(
    "rest: patch, atomic fast path",
    () => {
      const id = rand(state.size)
      return call(http, `/orders/${id}`, {
        method: "PATCH",
        headers: { ...bearer(owner(id % OWNERS)), "content-type": "application/json" },
        body: '{"$inc":{"n":1}}',
      })
    },
    "driver: updateOne (majority)",
  )
  write(
    "rest: patch, transaction with check",
    () => {
      const id = rand(state.size)
      const status = STATUSES[rand(STATUSES.length)]
      return call(http, `/orders/${id}`, {
        method: "PATCH",
        headers: {
          ...bearer(`clerk:c${id % TENANTS}:t${id % TENANTS}`),
          "content-type": "application/json",
        },
        body: JSON.stringify({ $set: { status } }),
      })
    },
    "driver: updateOne (majority)",
  )
  write(
    "rest: patch with mutation ID",
    (i) => {
      const id = rand(state.size)
      return call(http, `/orders/${id}`, {
        method: "PATCH",
        headers: {
          ...bearer(owner(id % OWNERS)),
          "content-type": "application/json",
          "idempotency-key": mutationId(i),
        },
        body: '{"$inc":{"n":1}}',
      })
    },
    "driver: updateOne (majority)",
  )
  write(
    "rest: insert with mutation ID",
    (i) =>
      post(http, "/orders", owner(1), body({ ...fresh(state) }), {
        "idempotency-key": mutationId(i),
      }),
    "driver: insertOne (majority)",
  )
  write("driver: replaceOne (majority)", () => {
    const id = rand(state.size)
    return coll.replaceOne(
      { _id: id, ownerId: owner(id % OWNERS) },
      { ...makeOrder(id), n: rand(1000) },
      majority,
    )
  })
  write(
    "rest: replace",
    () => {
      const id = rand(state.size)
      const { _id: _ignored, ...doc } = makeOrder(id)
      return call(http, `/orders/${id}`, {
        method: "PUT",
        headers: { ...bearer(owner(id % OWNERS)), "content-type": "application/json" },
        body: body({ ...doc, n: rand(1000) }),
      })
    },
    "driver: replaceOne (majority)",
  )
  write(
    "driver: deleteOne (majority)",
    () => {
      const id = victim(state)
      return coll.deleteOne({ _id: id, ownerId: owner(id % OWNERS) }, majority)
    },
    undefined,
    { victims: true },
  )
  write(
    "rest: delete",
    () => {
      const id = victim(state)
      return call(http, `/orders/${id}`, {
        method: "DELETE",
        headers: bearer(owner(id % OWNERS)),
      })
    },
    "driver: deleteOne (majority)",
    { victims: true },
  )
  const batchOps = (): { who: string; ids: number[]; id: number; doc: Order } => {
    const k = rand(OWNERS)
    const mine = (): number => rand(Math.floor(state.size / OWNERS)) * OWNERS + k
    return {
      who: owner(k),
      ids: [mine(), mine(), mine()],
      id: mine(),
      doc: fresh(state, owner(k), `t${k % TENANTS}`),
    }
  }
  write("driver: bulkWrite of 5 (ordered, majority)", () => {
    const { who, ids, id, doc } = batchOps()
    return coll.bulkWrite(
      [
        { insertOne: { document: doc } },
        ...ids.map((target) => ({
          updateOne: { filter: { _id: target, ownerId: who }, update: { $inc: { n: 1 } } },
        })),
        {
          replaceOne: {
            filter: { _id: id, ownerId: who },
            replacement: { ...makeOrder(id), n: rand(1000) },
          },
        },
      ],
      { ordered: true, ...majority },
    )
  })
  write(
    "rest: batch of 5 (not atomic)",
    () => {
      const { who, ids, id, doc } = batchOps()
      const { _id: _ignored, ...replacement } = makeOrder(id)
      return post(http, "/_batch", who, {
        ops: [
          { op: "insert", c: "orders", doc: JSON.parse(body({ ...doc })) },
          ...ids.map((target) => ({
            op: "update",
            c: "orders",
            id: target,
            update: { $inc: { n: 1 } },
          })),
          {
            op: "replace",
            c: "orders",
            id,
            doc: JSON.parse(body({ ...replacement, n: rand(1000) })),
          },
        ],
      })
    },
    "driver: bulkWrite of 5 (ordered, majority)",
  )
  write("driver: transaction of 4 writes", async () => {
    const { who, ids, doc } = batchOps()
    await client.withSession((session) =>
      session.withTransaction(
        async () => {
          await coll.insertOne(doc, { session })
          for (const target of ids)
            await coll.updateOne({ _id: target, ownerId: who }, { $inc: { n: 1 } }, { session })
        },
        { writeConcern: { w: "majority" } },
      ),
    )
  })
  write(
    "rest: atomic batch of 4",
    () => {
      const { who, ids, doc } = batchOps()
      return post(http, "/_batch", who, {
        atomic: true,
        ops: [
          { op: "insert", c: "orders", doc: JSON.parse(body({ ...doc })) },
          ...ids.map((target) => ({
            op: "update",
            c: "orders",
            id: target,
            update: { $inc: { n: 1 } },
          })),
        ],
      })
    },
    "driver: transaction of 4 writes",
  )
  return list
}
