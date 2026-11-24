import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { describe, expect, it } from "vitest"
import { recordWrites } from "./conformance/writes/record.ts"

const DIR = fileURLToPath(new URL("../../../conformance/http/writes", import.meta.url))

/**
 * `conformance/http/writes` is what the Rust write path is held to: every case is sent again to the TypeScript
 * handler on a freshly seeded database, and the responses, documents and idempotency records must be what the
 * files hold. Regenerate with `bun run vectors:http-writes`.
 */
describe.skipIf(MONGODB_URI === undefined)("conformance/http/writes", () => {
  it("is what the TypeScript write routes answer", async () => {
    const client = new MongoClient(MONGODB_URI ?? "", { serverSelectionTimeoutMS: 10_000 })
    await client.connect()
    try {
      expect(await recordWrites({ client, dir: DIR, check: true })).toEqual([])
    } finally {
      await client.close()
    }
  }, 300_000)
})
