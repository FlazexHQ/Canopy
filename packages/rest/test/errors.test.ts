import { allow, collection, createPolicySet } from "@canopy/policy"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { describeWithMongo, testPolicyEngine } from "@canopy/testing"
import { BSON, MongoServerError } from "mongodb"
import { beforeAll, describe, expect, it } from "vitest"
import { type Caller, fromDriverError, ReadPath } from "../src/index.ts"

function serverError(code: number | BSON.Int32, codeName: string): MongoServerError {
  return new MongoServerError({ message: codeName, code: code as number, codeName })
}

describe("fromDriverError", () => {
  for (const [label, wrap] of [
    ["a number", (n: number) => n],
    ["an Int32", (n: number) => new BSON.Int32(n)],
  ] as const) {
    describe(`with the server code as ${label}`, () => {
      it("maps MaxTimeMSExpired to CANOPY_TIMEOUT", () => {
        expect(fromDriverError(serverError(wrap(50), "MaxTimeMSExpired"), false).code).toBe(
          ErrorCode.Timeout,
        )
      })

      it("maps a duplicate key to CANOPY_DUPLICATE_KEY", () => {
        expect(fromDriverError(serverError(wrap(11000), "DuplicateKey"), false).code).toBe(
          ErrorCode.DuplicateKey,
        )
      })

      it("maps a validator failure to CANOPY_VALIDATION_FAILED", () => {
        expect(
          fromDriverError(serverError(wrap(121), "DocumentValidationFailure"), false).code,
        ).toBe(ErrorCode.ValidationFailed)
      })

      it("maps a rejected query to CANOPY_INVALID_QUERY", () => {
        expect(fromDriverError(serverError(wrap(2), "BadValue"), false).code).toBe(
          ErrorCode.InvalidQuery,
        )
      })

      it("keeps other server errors internal", () => {
        expect(fromDriverError(serverError(wrap(8000), "AtlasError"), false).code).toBe(
          ErrorCode.Internal,
        )
      })
    })
  }
})

describeWithMongo("read time limit", (db) => {
  const orders = collection("orders", { exposed: true, policies: [allow.read("auditor")] })
  const auditor: Caller = {
    context: {
      roles: new Set(["authenticated", "auditor"]),
      claims: { sub: "a" },
      now: new Date(),
    },
    subject: "a",
  }

  beforeAll(async () => {
    const coll = db().collection<{ _id: number; amount: number }>("orders")
    for (let from = 0; from < 100_000; from += 10_000)
      await coll.insertMany(
        Array.from({ length: 10_000 }, (_, i) => ({ _id: from + i, amount: (from + i) % 1000 })),
      )
  })

  it("reports a read that runs out of time as CANOPY_TIMEOUT", async () => {
    const reads = new ReadPath({
      client: db().client,
      database: db().collection("orders").dbName,
      policies: testPolicyEngine(createPolicySet([orders])),
      limits: { maxTimeMS: 1 },
    })
    const error: unknown = await reads
      .find(auditor, { collection: "orders", filter: { amount: { $gt: 5000 } }, limit: 10 })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    expect(error).toBeInstanceOf(CanopyError)
    expect((error as CanopyError).code).toBe(ErrorCode.Timeout)
  })
})
