import {
  Binary,
  BSONRegExp,
  Decimal128,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from "@canopy/protocol"
import * as bson from "bson"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  bsonTypeOf,
  compareStrings,
  compareValues,
  equalityKey,
  valuesEqual,
} from "../src/index.ts"

describe("compareValues", () => {
  it("orders types as MongoDB documents (MinKey, null, numbers, strings, objects, arrays, binData, ObjectId, bool, date, timestamp, regex, MaxKey)", () => {
    const ordered: unknown[] = [
      new MinKey(),
      null,
      -1,
      "a",
      { a: 1 },
      [1],
      new Binary(new Uint8Array([1])),
      new ObjectId("6728f0c2a1b2c3d4e5f60718"),
      false,
      new Date(0),
      new Timestamp(1, 1),
      new BSONRegExp("a"),
      new MaxKey(),
    ]
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        expect(Math.sign(compareValues(ordered[i], ordered[j])), `${i} vs ${j}`).toBe(
          Math.sign(i - j),
        )
      }
    }
  })

  it("compares numbers by exact value across int, long, double and decimal", () => {
    expect(compareValues(1, new Long(1n))).toBe(0)
    expect(compareValues(new Decimal128("1.0"), 1)).toBe(0)
    expect(compareValues(new Decimal128("0.1"), 0.1)).toBeLessThan(0)
    expect(compareValues(2 ** 53, new Long(2n ** 53n + 1n))).toBeLessThan(0)
    expect(compareValues(new Decimal128("1E+400"), Number.MAX_VALUE)).toBeGreaterThan(0)
    expect(compareValues(Number.POSITIVE_INFINITY, new Decimal128("1E+400"))).toBeGreaterThan(0)
    expect(compareValues(-0, 0)).toBe(0)
    expect(compareValues(Number.NaN, Number.NaN)).toBe(0)
    expect(compareValues(Number.NaN, Number.NEGATIVE_INFINITY)).toBeLessThan(0)
    expect(compareValues(new Decimal128("NaN"), Number.NaN)).toBe(0)
  })

  it("agrees with plain number comparison on random doubles", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), (a, b) => {
        expect(Math.sign(compareValues(a, b))).toBe(a < b ? -1 : a > b ? 1 : 0)
      }),
    )
  })

  it("compares longs with doubles exactly", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (l, d) => {
          const exact = Number.isInteger(d) ? BigInt(d) : undefined
          const cmp = Math.sign(compareValues(new Long(l), d))
          if (exact !== undefined) expect(cmp).toBe(l < exact ? -1 : l > exact ? 1 : 0)
          else expect(cmp).toBe(Number(l) < d ? -1 : 1)
        },
      ),
    )
  })

  it("orders strings by code point, as UTF-8 byte order does", () => {
    expect(compareStrings("￿", "\u{10000}")).toBeLessThan(0)
    expect("￿" < "\u{10000}").toBe(false)
    expect(compareStrings("a", "ab")).toBeLessThan(0)
    expect(compareStrings("B", "a")).toBeLessThan(0)
  })

  it("compares documents field by field with type, then name, then value", () => {
    expect(compareValues({ a: 1 }, { a: 1 })).toBe(0)
    expect(compareValues({ a: 1, b: 2 }, { b: 2, a: 1 })).not.toBe(0)
    expect(compareValues({ a: "x" }, { b: 1 })).toBeGreaterThan(0)
    expect(compareValues({ a: 1 }, { b: 1 })).toBeLessThan(0)
    expect(compareValues({ a: 1 }, { a: 1, b: 0 })).toBeLessThan(0)
  })

  it("compares binary data by length, then subtype, then bytes", () => {
    expect(
      compareValues(new Binary(new Uint8Array([9])), new Binary(new Uint8Array([1, 1]))),
    ).toBeLessThan(0)
    expect(
      compareValues(new Binary(new Uint8Array([1]), 5), new Binary(new Uint8Array([2]), 0)),
    ).toBeGreaterThan(0)
  })

  it("treats bson package values like local ones", () => {
    expect(
      valuesEqual(
        new bson.ObjectId("6728f0c2a1b2c3d4e5f60718"),
        new ObjectId("6728f0c2a1b2c3d4e5f60718"),
      ),
    ).toBe(true)
    expect(valuesEqual(new bson.Int32(5), 5)).toBe(true)
    expect(valuesEqual(new bson.Double(5), new bson.Int32(5))).toBe(true)
    expect(bsonTypeOf(new bson.Double(5))).toBe("double")
    expect(bsonTypeOf(5)).toBe("int")
    expect(bsonTypeOf(5.5)).toBe("double")
    expect(bsonTypeOf(2 ** 31)).toBe("double")
    expect(bsonTypeOf(bson.Long.fromNumber(5))).toBe("long")
  })
})

describe("equalityKey", () => {
  const values: unknown[] = [
    0,
    -0,
    1,
    new Long(1n),
    new bson.Int32(1),
    new bson.Double(1),
    1.5,
    2 ** 60,
    new Long(2n ** 60n),
    new Long(2n ** 60n + 1n),
    "a",
    "b",
    true,
    false,
    null,
    new Date(5),
    new ObjectId("6728f0c2a1b2c3d4e5f60718"),
    Number.NaN,
  ]

  it("gives equal keys exactly to values MongoDB considers equal", () => {
    for (const a of values) {
      for (const b of values) {
        const ka = equalityKey(a)
        const kb = equalityKey(b)
        if (ka === undefined || kb === undefined) continue
        expect(ka === kb, `${String(a)} vs ${String(b)}`).toBe(valuesEqual(a, b))
      }
    }
  })

  it("has no key for values that need a structural comparison", () => {
    expect(equalityKey({ a: 1 })).toBeUndefined()
    expect(equalityKey([1])).toBeUndefined()
    expect(equalityKey(new Decimal128("1"))).toBeUndefined()
  })
})
