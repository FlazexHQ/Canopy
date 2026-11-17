import { createHash } from "node:crypto"
import * as bson from "bson"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  CanopyError,
  CloseCode,
  ConflictError,
  closeReaction,
  compareCt,
  ctFromParts,
  ctToParts,
  ErrorCode,
  errorFromWire,
  httpStatusOf,
  isClusterTime,
  isUuidV7,
  maxCt,
  PolicyViolationError,
  sha256Hex,
  snapshotTimeOf,
  Timestamp,
  toCanopyError,
  toCt,
  UnauthorizedError,
  uuidv7,
} from "../src/index.ts"

describe("sha256Hex", () => {
  it("matches the published test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
  })

  it("matches node:crypto for arbitrary input, including every padding boundary", () => {
    for (let length = 0; length < 200; length += 1) {
      const text = "x".repeat(length)
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"))
    }
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"))
      }),
    )
  })

  it("hashes strings as UTF-8", () => {
    const text = "café \u{1f333}"
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
  })
})

describe("uuidv7", () => {
  it("produces RFC 9562 version 7 ids that sort by creation order", () => {
    const now = 1_793_871_004_000
    const ids = Array.from({ length: 500 }, () => uuidv7(now))
    for (const id of ids) expect(isUuidV7(id)).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Number.parseInt(ids[0]?.replaceAll("-", "").slice(0, 12) ?? "", 16)).toBe(now)
  })

  it("orders ids across milliseconds", () => {
    const a = uuidv7(1000)
    const b = uuidv7(1001)
    expect(a < b).toBe(true)
  })
})

describe("cluster time", () => {
  it("packs seconds into the high 32 bits and the increment into the low 32 bits", () => {
    expect(ctFromParts(1, 0)).toBe("4294967296")
    expect(ctFromParts(1_793_871_004, 1)).toBe(((1_793_871_004n << 32n) | 1n).toString())
    fc.assert(
      fc.property(fc.nat({ max: 0xffffffff }), fc.nat({ max: 0xffffffff }), (t, i) => {
        expect(ctToParts(ctFromParts(t, i))).toEqual({ t, i })
      }),
    )
  })

  it("compares numerically, not as strings", () => {
    expect(compareCt("9", "10")).toBeLessThan(0)
    expect(compareCt("10", "9")).toBeGreaterThan(0)
    expect(compareCt("7704617278242816001", "7704617278242816001")).toBe(0)
    expect(maxCt("9", "10")).toBe("10")
  })

  it("orders any two cluster times like their uint64 values, leading zeros included", () => {
    const ct = fc.oneof(
      fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((value) => value.toString()),
      fc.bigInt({ min: 0n, max: 999n }).map((value) => `00${value}`),
      fc.constantFrom("0", "9", "10", "9999999999999999999", "10000000000000000000"),
    )
    fc.assert(
      fc.property(ct, ct, (a, b) => {
        const x = BigInt(a)
        const y = BigInt(b)
        expect(Math.sign(compareCt(a, b))).toBe(x < y ? -1 : x > y ? 1 : 0)
        expect(maxCt(a, b)).toBe(x < y ? b : a)
      }),
      { numRuns: 5000 },
    )
    expect(() => compareCt("12", "1x")).toThrow(TypeError)
    expect(() => compareCt("", "1")).toThrow(TypeError)
    expect(() => compareCt("18446744073709551616", "1")).toThrow(TypeError)
  })

  it("validates the wire form", () => {
    expect(isClusterTime("0")).toBe(true)
    expect(isClusterTime("18446744073709551615")).toBe(true)
    expect(isClusterTime("18446744073709551616")).toBe(false)
    expect(isClusterTime("-1")).toBe(false)
    expect(isClusterTime("1.5")).toBe(false)
    expect(isClusterTime(5)).toBe(false)
  })

  it("converts driver and local timestamps", () => {
    expect(toCt(new bson.Timestamp({ t: 1_793_871_004, i: 3 }))).toBe(ctFromParts(1_793_871_004, 3))
    expect(toCt(new Timestamp(5, 6))).toBe(ctFromParts(5, 6))
    expect(toCt({ t: 5 })).toBeUndefined()
  })

  it("reads the snapshot time of a driver session only when it is a timestamp", () => {
    expect(snapshotTimeOf({ snapshotTime: new bson.Timestamp({ t: 9, i: 2 }) })).toBe(
      ctFromParts(9, 2),
    )
    expect(snapshotTimeOf({})).toBeUndefined()
    expect(snapshotTimeOf({ snapshotTime: undefined })).toBeUndefined()
    expect(snapshotTimeOf({ snapshotTime: "9" })).toBeUndefined()
    expect(snapshotTimeOf({ snapshotTime: { t: 9, i: 2 } })).toBeUndefined()
  })
})

describe("errors", () => {
  it("maps codes to their REST HTTP statuses", () => {
    expect(httpStatusOf(ErrorCode.InvalidQuery)).toBe(400)
    expect(httpStatusOf(ErrorCode.BulkLimit)).toBe(400)
    expect(httpStatusOf(ErrorCode.Unauthorized)).toBe(401)
    expect(httpStatusOf(ErrorCode.TokenExpired)).toBe(401)
    expect(httpStatusOf(ErrorCode.Forbidden)).toBe(403)
    expect(httpStatusOf(ErrorCode.PolicyViolation)).toBe(403)
    expect(httpStatusOf(ErrorCode.NotFound)).toBe(404)
    expect(httpStatusOf(ErrorCode.Conflict)).toBe(409)
    expect(httpStatusOf(ErrorCode.DuplicateKey)).toBe(409)
    expect(httpStatusOf(ErrorCode.PayloadTooLarge)).toBe(413)
    expect(httpStatusOf(ErrorCode.ValidationFailed)).toBe(422)
    expect(httpStatusOf(ErrorCode.RateLimited)).toBe(429)
    expect(httpStatusOf(ErrorCode.Internal)).toBe(500)
    expect(httpStatusOf(ErrorCode.Unavailable)).toBe(503)
    expect(httpStatusOf(ErrorCode.Timeout)).toBe(504)
  })

  it("rebuilds typed errors from the wire", () => {
    expect(errorFromWire({ code: ErrorCode.Conflict, msg: "x" })).toBeInstanceOf(ConflictError)
    expect(errorFromWire({ code: ErrorCode.PolicyViolation, msg: "x" })).toBeInstanceOf(
      PolicyViolationError,
    )
    const expired = errorFromWire({ code: ErrorCode.TokenExpired, msg: "late" })
    expect(expired).toBeInstanceOf(UnauthorizedError)
    expect(expired.code).toBe(ErrorCode.TokenExpired)
    const generic = errorFromWire({ code: ErrorCode.BulkLimit, msg: "big" })
    expect(generic).toBeInstanceOf(CanopyError)
    expect(generic.toWire()).toEqual({ code: ErrorCode.BulkLimit, msg: "big" })
  })

  it("hides unknown failures behind CANOPY_INTERNAL", () => {
    const wrapped = toCanopyError(new Error("secret connection string"))
    expect(wrapped.code).toBe(ErrorCode.Internal)
    expect(wrapped.message).not.toContain("secret")
  })
})

describe("closeReaction", () => {
  it("reconnects, refreshes or gives up as each close code requires", () => {
    expect(closeReaction(CloseCode.Normal).reconnect).toBe(false)
    expect(closeReaction(CloseCode.Forbidden).reconnect).toBe(false)
    expect(closeReaction(CloseCode.UnsupportedVersion).reconnect).toBe(false)
    expect(closeReaction(CloseCode.Unauthorized).refreshToken).toBe(true)
    expect(closeReaction(CloseCode.RateLimited).minDelayMs).toBeGreaterThanOrEqual(30_000)
    expect(closeReaction(CloseCode.SlowConsumer)).toMatchObject({ reconnect: true, minDelayMs: 0 })
    expect(closeReaction(3999).reconnect).toBe(true)
  })
})
