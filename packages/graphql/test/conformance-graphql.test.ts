import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { describe, expect, it } from "vitest"
import { recordGraphql } from "./conformance/record.ts"

const DIR = fileURLToPath(new URL("../../../conformance/http/graphql", import.meta.url))

/**
 * `conformance/http/graphql` is what the Rust GraphQL endpoint is held to: every case is sent again to the TypeScript
 * handler on a freshly seeded database, and the responses and observed documents must be what the
 * files hold. Regenerate with `bun run vectors:http-graphql`.
 */
describe.skipIf(MONGODB_URI === undefined)("conformance/http/graphql", () => {
  it("is what the TypeScript GraphQL endpoint answers", async () => {
    const client = new MongoClient(MONGODB_URI ?? "", { serverSelectionTimeoutMS: 10_000 })
    await client.connect()
    try {
      expect(await recordGraphql({ client, dir: DIR, check: true })).toEqual([])
    } finally {
      await client.close()
    }
  }, 300_000)
})
