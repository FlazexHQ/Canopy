import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { describe, expect, it } from "vitest"
import { recordStorage } from "./conformance/record.ts"

const DIR = fileURLToPath(new URL("../../../conformance/http/storage", import.meta.url))

/**
 * `conformance/http/storage` is what the Rust Storage endpoint is held to: every case is sent again to the TypeScript
 * handler on a fresh scratch database and local backend, and the responses and observed documents must be what the
 * files hold. Regenerate with `bun run vectors:http-storage`.
 */
describe.skipIf(MONGODB_URI === undefined)("conformance/http/storage", () => {
  it("is what the TypeScript Storage endpoint answers", async () => {
    const client = new MongoClient(MONGODB_URI ?? "", { serverSelectionTimeoutMS: 10_000 })
    await client.connect()
    try {
      expect(await recordStorage({ client, dir: DIR, check: true })).toEqual([])
    } finally {
      await client.close()
    }
  }, 300_000)
})
