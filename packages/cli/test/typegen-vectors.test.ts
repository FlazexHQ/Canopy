import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { expect, it } from "vitest"
import { recordTypegen } from "./conformance/typegen/record.ts"

const dir = fileURLToPath(new URL("../../../conformance/typegen", import.meta.url))

it("reproduces the type generation vectors", async () => {
  expect(await recordTypegen({ dir, check: true })).toEqual([])
})

const uri = MONGODB_URI
it.skipIf(uri === undefined)(
  "reproduces the canopy pull vectors",
  { timeout: 90_000 },
  async () => {
    if (uri === undefined) throw new Error("Missing MongoDB URI")
    await using client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
    expect(await recordTypegen({ dir, check: true, mongo: { client, uri } })).toEqual([])
  },
)
