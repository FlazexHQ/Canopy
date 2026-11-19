import { compileProjection } from "@canopy/matcher/lite"
import { parseProjection } from "@canopy/query"
import { describeWithMongo } from "@canopy/testing"
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest"
import type { CanopyClient, DeepPartial, DocumentSchema, ProjectedResult } from "../src/index.ts"

interface Item {
  sku: string
  qty: number
}

interface Order {
  _id: string
  status: string
  customer: { name: string; address: { city: string; zip: string } }
  items: Item[]
  note?: string
}

const ORDERS: Order[] = [
  {
    _id: "o1",
    status: "open",
    customer: { name: "Ada", address: { city: "Paris", zip: "75001" } },
    items: [
      { sku: "a", qty: 1 },
      { sku: "b", qty: 2 },
    ],
    note: "gift",
  },
  {
    _id: "o2",
    status: "shipped",
    customer: { name: "Grace", address: { city: "Oslo", zip: "0150" } },
    items: [],
  },
]

const nestedInclusion = { "customer.name": 1 } as const
const deepInclusion = { "customer.address.city": 1, status: 1 } as const
const arrayInclusion = { "items.sku": 1, _id: 0 } as const
const indexedInclusion = { "items.0.sku": 1 } as const
const nestedExclusion = { "customer.address": 0, items: 0 } as const
const arrayExclusion = { "items.qty": 0, note: 0 } as const

type Customer = Order["customer"]

/** Type checks run by `tsc -b`; never called. */
function checks(client: CanopyClient<DocumentSchema<{ orders: Order }>>): void {
  expectTypeOf<ProjectedResult<Order, typeof nestedInclusion>>().toEqualTypeOf<{
    _id: string
    customer?: DeepPartial<Customer>
  }>()
  expectTypeOf<ProjectedResult<Order, typeof deepInclusion>>().toEqualTypeOf<{
    _id: string
    status: string
    customer?: DeepPartial<Customer>
  }>()
  expectTypeOf<ProjectedResult<Order, typeof arrayInclusion>>().toEqualTypeOf<{
    items?: DeepPartial<Item>[]
  }>()
  expectTypeOf<ProjectedResult<Order, typeof indexedInclusion>>().toEqualTypeOf<{
    _id: string
    items?: DeepPartial<Item>[]
  }>()
  expectTypeOf<ProjectedResult<Order, typeof nestedExclusion>>().toEqualTypeOf<{
    _id: string
    status: string
    note?: string
    customer?: DeepPartial<Customer>
  }>()
  expectTypeOf<ProjectedResult<Order, typeof arrayExclusion>>().toEqualTypeOf<{
    _id: string
    status: string
    customer: Customer
    items?: DeepPartial<Item>[]
  }>()

  const orders = client.from("orders").find({})
  const [first] = orders.fields(deepInclusion).getState().data
  expectTypeOf(first?.customer?.address?.city).toEqualTypeOf<string | undefined>()
  // @ts-expect-error the projection omits items
  void first?.items
  // @ts-expect-error MongoDB refuses a projection that mixes inclusion and exclusion
  void orders.fields({ "customer.name": 1, note: 0 })
}
void checks

/** Each case is typed by the projection it describes, so a value the types reject does not compile. */
const CASES: readonly (readonly [string, Record<string, 0 | 1>, readonly object[]])[] = [
  [
    "a nested field",
    nestedInclusion,
    [
      { _id: "o1", customer: { name: "Ada" } },
      { _id: "o2", customer: { name: "Grace" } },
    ] satisfies ProjectedResult<Order, typeof nestedInclusion>[],
  ],
  [
    "a field two levels down, next to a top level one",
    deepInclusion,
    [
      { _id: "o1", status: "open", customer: { address: { city: "Paris" } } },
      { _id: "o2", status: "shipped", customer: { address: { city: "Oslo" } } },
    ] satisfies ProjectedResult<Order, typeof deepInclusion>[],
  ],
  [
    "a field of every array element, without _id",
    arrayInclusion,
    [{ items: [{ sku: "a" }, { sku: "b" }] }, { items: [] }] satisfies ProjectedResult<
      Order,
      typeof arrayInclusion
    >[],
  ],
  [
    "a numeric path step, which a find projection treats as a field name inside each element",
    indexedInclusion,
    [
      { _id: "o1", items: [{}, {}] },
      { _id: "o2", items: [] },
    ] satisfies ProjectedResult<Order, typeof indexedInclusion>[],
  ],
  [
    "an excluded subdocument and array",
    nestedExclusion,
    [
      { _id: "o1", status: "open", customer: { name: "Ada" }, note: "gift" },
      { _id: "o2", status: "shipped", customer: { name: "Grace" } },
    ] satisfies ProjectedResult<Order, typeof nestedExclusion>[],
  ],
  [
    "a field excluded from every array element",
    arrayExclusion,
    [
      {
        _id: "o1",
        status: "open",
        customer: { name: "Ada", address: { city: "Paris", zip: "75001" } },
        items: [{ sku: "a" }, { sku: "b" }],
      },
      {
        _id: "o2",
        status: "shipped",
        customer: { name: "Grace", address: { city: "Oslo", zip: "0150" } },
        items: [],
      },
    ] satisfies ProjectedResult<Order, typeof arrayExclusion>[],
  ],
]

describe("nested projection paths", () => {
  it.each(CASES)("the server parser accepts %s", (_name, spec) => {
    const parsed = parseProjection(spec)
    expect(parsed.projection).toEqual(spec)
    expect(parsed.includeId).toBe(spec["_id"] !== 0)
  })

  it.each(CASES)("the client projects %s as the typed result says", (_name, spec, expected) => {
    const projection = compileProjection(spec)
    expect(ORDERS.map((order) => projection.apply({ ...order }))).toStrictEqual(expected)
  })

  it("rejects the projections the types reject, in the parser and on the client", () => {
    const mixed = { "customer.name": 1, note: 0 }
    expect(() => parseProjection(mixed)).toThrow(/cannot mix inclusion and exclusion/)
    expect(() => compileProjection(mixed)).toThrow(/Cannot mix inclusion and exclusion/)
    const collision = { customer: 1, "customer.name": 1 }
    expect(() => parseProjection(collision)).toThrow(/Path collision/)
  })
})

describeWithMongo("nested projection paths against MongoDB", (db) => {
  beforeAll(async () => {
    await db().collection<Order>("orders").insertMany(ORDERS)
  })

  it.each(CASES)("MongoDB returns the typed result for %s", async (_name, spec, expected) => {
    const found = await db()
      .collection<Order>("orders")
      .find({}, { projection: spec, sort: { _id: 1 } })
      .toArray()
    expect(found).toStrictEqual(expected)
  })

  it("refuses the mixed projection and the path collision as the parser does", async () => {
    const orders = db().collection<Order>("orders")
    await expect(
      orders.find({}, { projection: { "customer.name": 1, note: 0 } }).toArray(),
    ).rejects.toThrow(/exclusion/)
    await expect(
      orders.find({}, { projection: { customer: 1, "customer.name": 1 } }).toArray(),
    ).rejects.toThrow(/[Pp]ath collision/)
  })
})
