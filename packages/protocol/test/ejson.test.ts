import * as bson from "bson"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  Binary,
  BSONRegExp,
  CanopyError,
  canonicalString,
  Decimal128,
  decode,
  ErrorCode,
  encode,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  parse,
  stringify,
  Timestamp,
  toCanonical,
} from "../src/index.ts"

const OID = "6728f0c2a1b2c3d4e5f60718"

function invalid(run: () => unknown): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CanopyError)
    expect((error as CanopyError).code).toBe(ErrorCode.InvalidQuery)
    return
  }
  throw new Error("expected an invalid query error")
}

describe("decode", () => {
  it("maps every supported wrapper to its value class", () => {
    const value = parse(
      JSON.stringify({
        oid: { $oid: OID },
        long: { $numberLong: "9007199254740993" },
        int: { $numberInt: "-7" },
        double: { $numberDouble: "1.5" },
        inf: { $numberDouble: "-Infinity" },
        nan: { $numberDouble: "NaN" },
        dec: { $numberDecimal: "1.10" },
        iso: { $date: "2026-11-05T09:30:00Z" },
        ms: { $date: { $numberLong: "-1000" } },
        bin: { $binary: { base64: "AQID", subType: "80" } },
        uuid: { $uuid: "0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e" },
        ts: { $timestamp: { t: 7, i: 3 } },
        re: { $regularExpression: { pattern: "^a", options: "mi" } },
        min: { $minKey: 1 },
        max: { $maxKey: 1 },
      }),
    ) as Record<string, unknown>

    expect(value["oid"]).toBeInstanceOf(ObjectId)
    expect((value["oid"] as ObjectId).hex).toBe(OID)
    expect((value["long"] as Long).value).toBe(9007199254740993n)
    expect(value["int"]).toBe(-7)
    expect(value["double"]).toBe(1.5)
    expect(value["inf"]).toBe(Number.NEGATIVE_INFINITY)
    expect(Number.isNaN(value["nan"])).toBe(true)
    expect((value["dec"] as Decimal128).value).toBe("1.10")
    expect((value["iso"] as Date).toISOString()).toBe("2026-11-05T09:30:00.000Z")
    expect((value["ms"] as Date).getTime()).toBe(-1000)
    expect([...(value["bin"] as Binary).bytes]).toEqual([1, 2, 3])
    expect((value["bin"] as Binary).subType).toBe(0x80)
    expect((value["uuid"] as Binary).subType).toBe(4)
    expect((value["uuid"] as Binary).bytes.length).toBe(16)
    expect((value["ts"] as Timestamp).toBigInt()).toBe((7n << 32n) | 3n)
    expect((value["re"] as BSONRegExp).options).toBe("im")
    expect(value["min"]).toBeInstanceOf(MinKey)
    expect(value["max"]).toBeInstanceOf(MaxKey)
  })

  it("builds documents without a prototype", () => {
    const value = parse('{"a":{"b":1}}') as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(Object.getPrototypeOf(value["a"])).toBeNull()
  })

  it.each(["__proto__", "constructor", "prototype"])("rejects the key %s at any depth", (key) => {
    invalid(() => parse(`{"${key}":{"polluted":true}}`))
    invalid(() => parse(`{"a":[{"${key}":1}]}`))
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it.each([
    ["an ObjectId with bad hex", { $oid: "zz" }],
    ["a wrapper with an extra key", { $oid: OID, x: 1 }],
    ["an out of range int32", { $numberInt: "2147483648" }],
    ["a non integer int32", { $numberInt: "1.5" }],
    ["an out of range int64", { $numberLong: "9223372036854775808" }],
    ["a numeric $numberDouble", { $numberDouble: 1 }],
    ["an empty $numberDouble", { $numberDouble: "" }],
    ["a bad decimal", { $numberDecimal: "abc" }],
    ["a decimal with an exponent out of range", { $numberDecimal: "1e300000000" }],
    ["a decimal with an exponent just out of range", { $numberDecimal: "1e6211" }],
    ["a date that is not ISO", { $date: "yesterday" }],
    ["a date given as a number", { $date: 1 }],
    ["a bad binary subtype", { $binary: { base64: "AA==", subType: "zz" } }],
    ["a bad timestamp", { $timestamp: { t: -1, i: 0 } }],
    ["a bad regex flag", { $regularExpression: { pattern: "a", options: "g" } }],
    ["a bad minKey", { $minKey: 0 }],
    ["a code value", { $code: "function () {}" }],
    ["an undefined value", { $undefined: true }],
  ])("rejects %s", (_name, wrapper) => {
    invalid(() => decode({ a: wrapper }))
  })

  it("bounds the exponent of a decimal", () => {
    for (const ok of ["1e6210", "1e-6210", "0.000001", "123.456", "NaN", "Infinity", "-Infinity"])
      expect(new Decimal128(ok).value).toBe(ok)
    expect(new Decimal128("1.5e6211").value).toBe("1.5e6211")
    for (const bad of ["1e300000000", "1e6211", "1e-6211", "1.5e-6210", "-1E+99999"])
      expect(() => new Decimal128(bad), bad).toThrow(TypeError)
  })

  it("leaves query operators alone", () => {
    const value = decode({ a: { $gt: 1, $regex: "x", $options: "i" }, $or: [] })
    expect(JSON.stringify(value)).toBe('{"a":{"$gt":1,"$regex":"x","$options":"i"},"$or":[]}')
  })

  it("enforces the depth limit", () => {
    const deep = `${'{"a":'.repeat(10)}1${"}".repeat(10)}`
    expect(() => parse(deep, { maxDepth: 10 })).not.toThrow()
    invalid(() => parse(deep, { maxDepth: 9 }))
  })

  it("enforces the node limit", () => {
    invalid(() => decode({ a: [1, 2, 3], b: 1 }, { maxNodes: 4 }))
    expect(() => decode({ a: [1, 2], b: 1 }, { maxNodes: 4 })).not.toThrow()
  })

  it("rejects malformed JSON", () => {
    invalid(() => parse('{"a":'))
  })
})

describe("encode", () => {
  it("encodes an own __proto__ field without changing the output prototype", () => {
    const encoded = encode(JSON.parse('{"__proto__":{"marker":true}}'))
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
    expect(Object.hasOwn(encoded as object, "__proto__")).toBe(true)
    expect(JSON.stringify(encoded)).toBe('{"__proto__":{"marker":true}}')
  })

  it("uses relaxed forms for plain values and keeps lossless forms where needed", () => {
    expect(
      encode({
        n: 5,
        f: 1.5,
        nz: -0,
        inf: Number.POSITIVE_INFINITY,
        big: 2n ** 60n,
        small: new Long(42n),
        dec: new Decimal128("0.1"),
        d: new Date("2026-11-05T09:30:00.000Z"),
        old: new Date(-62_135_596_800_001),
        skip: undefined,
      }),
    ).toEqual({
      n: 5,
      f: 1.5,
      nz: { $numberDouble: "-0.0" },
      inf: { $numberDouble: "Infinity" },
      big: { $numberLong: "1152921504606846976" },
      small: 42,
      dec: { $numberDecimal: "0.1" },
      d: { $date: "2026-11-05T09:30:00.000Z" },
      old: { $date: { $numberLong: "-62135596800001" } },
    })
  })

  it("rejects values that have no EJSON form", () => {
    invalid(() => encode({ f: () => 1 }))
    invalid(() => encode({ s: Symbol("x") }))
    invalid(() => encode(new Date(Number.NaN)))
  })

  it("round trips every value class through text", () => {
    const original = {
      oid: new ObjectId(OID),
      long: new Long(-(2n ** 62n)),
      dec: new Decimal128("-12.5E-3"),
      bin: new Binary(new Uint8Array([0, 255, 7]), 5),
      ts: new Timestamp(1_793_871_004, 9),
      re: new BSONRegExp("a.b", "sx"),
      min: new MinKey(),
      max: new MaxKey(),
      nested: [{ d: new Date(0) }, null, "x", true],
    }
    const back = parse(stringify(original))
    expect(canonicalString(back)).toBe(canonicalString(original))
  })
})

describe("interoperability with the bson package", () => {
  const samples: Record<string, unknown> = {
    oid: new bson.ObjectId(OID),
    long: bson.Long.fromBigInt(-(2n ** 60n)),
    int: new bson.Int32(12),
    double: new bson.Double(2.5),
    dec: bson.Decimal128.fromString("3.14"),
    bin: new bson.Binary(new Uint8Array([9, 8, 7]), 3),
    ts: new bson.Timestamp({ t: 100, i: 2 }),
    re: new bson.BSONRegExp("^x", "i"),
    min: new bson.MinKey(),
    max: new bson.MaxKey(),
    date: new Date("2001-02-03T04:05:06.007Z"),
    str: "hello",
    arr: [1, "two", null],
  }

  it("produces the same canonical EJSON as bson for driver values", () => {
    for (const [name, value] of Object.entries(samples)) {
      const ours = toCanonical(value)
      const theirs = JSON.parse(bson.EJSON.stringify(value, { relaxed: false }))
      if (name === "int" || name === "double" || name === "arr") {
        expect(ours, name).toEqual(name === "double" ? { $numberDouble: "2.5" } : theirs)
      } else {
        expect(ours, name).toEqual(theirs)
      }
    }
  })

  it("produces the same relaxed EJSON as bson for driver values", () => {
    for (const [name, value] of Object.entries(samples)) {
      if (name === "long") continue
      expect(encode(value), name).toEqual(
        JSON.parse(bson.EJSON.stringify(value, { relaxed: true })),
      )
    }
  })

  it("decodes what bson encodes", () => {
    fc.assert(
      fc.property(
        fc.record({
          i: fc.integer(),
          d: fc
            .double({ noNaN: true })
            .filter((d) => !Number.isInteger(d) || Number.isSafeInteger(d)),
          s: fc.string(),
          l: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
          t: fc.date({ noInvalidDate: true }),
        }),
        (doc) => {
          const value = {
            i: doc.i,
            d: doc.d,
            s: doc.s,
            l: bson.Long.fromBigInt(doc.l),
            t: doc.t,
          }
          const text = bson.EJSON.stringify(value, { relaxed: false })
          const decoded = parse(text) as Record<string, unknown>
          expect(decoded["i"]).toBe(doc.i)
          const d = decoded["d"]
          if (d instanceof Long) {
            expect(Number.isInteger(doc.d)).toBe(true)
            expect(d.value).toBe(BigInt(doc.d))
          } else {
            expect(Object.is(d, doc.d)).toBe(true)
          }
          expect(decoded["s"]).toBe(doc.s)
          expect((decoded["l"] as Long).value).toBe(doc.l)
          expect((decoded["t"] as Date).getTime()).toBe(doc.t.getTime())
        },
      ),
    )
  })
})

describe("canonicalString", () => {
  it("distinguishes values that differ in type", () => {
    expect(canonicalString("1")).not.toBe(canonicalString(1))
    expect(canonicalString(new ObjectId(OID))).not.toBe(canonicalString(OID))
    expect(canonicalString(1.5)).not.toBe(canonicalString(1))
  })

  it("keeps key order, because MongoDB document equality depends on it", () => {
    expect(canonicalString({ a: 1, b: 2 })).not.toBe(canonicalString({ b: 2, a: 1 }))
  })

  it("gives equal strings for equal ObjectIds from different libraries", () => {
    expect(canonicalString(new bson.ObjectId(OID))).toBe(canonicalString(new ObjectId(OID)))
  })
})

describe("ObjectId", () => {
  it("generates unique, valid ids whose timestamp is the creation second", () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0)
    const ids = new Set<string>()
    for (let index = 0; index < 1000; index += 1) ids.add(ObjectId.generateHex(now))
    expect(ids.size).toBe(1000)
    for (const hex of ids) expect(new ObjectId(hex).getTimestamp().getTime()).toBe(now)
    expect(bson.ObjectId.isValid(new ObjectId().hex)).toBe(true)
  })

  it("rejects invalid hex and normalizes case", () => {
    expect(() => new ObjectId("xyz")).toThrow(TypeError)
    expect(new ObjectId(OID.toUpperCase()).hex).toBe(OID)
  })
})

describe("Long", () => {
  it("rejects values outside 64 signed bits", () => {
    expect(() => new Long(2n ** 63n)).toThrow(RangeError)
    expect(() => new Long(-(2n ** 63n) - 1n)).toThrow(RangeError)
    expect(new Long(-(2n ** 63n)).value).toBe(-(2n ** 63n))
  })
})
