import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { expect, it } from "vitest"
import { recordMigrations } from "./record.ts"

it.skipIf(MONGODB_URI === undefined)(
  "replays the migrations oracle",
  async () => {
    if (MONGODB_URI === undefined) throw new Error("A MongoDB replica set is required")
    await using client = new MongoClient(MONGODB_URI)
    const dir = fileURLToPath(new URL("../../../../../conformance/migrations", import.meta.url))
    expect(await recordMigrations({ client, dir, check: true })).toEqual([])
  },
  60_000,
)
