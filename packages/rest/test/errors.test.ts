import { allow, collection, createPolicySet } from "@canopy/policy"
import { CanopyError, ErrorCode, serverErrorCode } from "@canopy/protocol"
import { describeWithMongo, testPolicyEngine } from "@canopy/testing"
import { BSON, MongoServerError } from "mongodb"
import { describe, expect, it } from "vitest"
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

  it("reports a read that runs out of time as CANOPY_TIMEOUT", async () => {
    const { client } = db()
    const coll = db().collection("orders")
    await coll.insertOne({ amount: 100 })
    const reads = new ReadPath({
      client,
      database: coll.dbName,
      policies: testPolicyEngine(createPolicySet([orders])),
      limits: { maxTimeMS: 1 },
    })
    const admin = client.db("admin")
    await admin.command({
      configureFailPoint: "failCommand",
      mode: { times: 1 },
      data: {
        namespace: `${coll.dbName}.${coll.collectionName}`,
        failCommands: ["find"],
        blockConnection: true,
        blockTimeMS: 100,
      },
    })
    try {
      await expect(reads.find(auditor, { collection: "orders", limit: 10 })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(CanopyError)
          if (!(error instanceof CanopyError)) return false
          expect(error.code).toBe(ErrorCode.Timeout)
          expect(error.cause).toBeInstanceOf(MongoServerError)
          expect(serverErrorCode(error.cause)).toBe(50)
          return true
        },
      )
    } finally {
      await admin.command({ configureFailPoint: "failCommand", mode: "off" })
    }
  })
})
