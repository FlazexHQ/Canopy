import { fileURLToPath } from "node:url"
import { MONGODB_URI, TEST_ENGINE } from "@canopy/testing"
import { expect, it } from "vitest"
import { recordAdmin } from "./conformance/admin/record.ts"

it.skipIf(MONGODB_URI === undefined || TEST_ENGINE !== "ts")(
  "matches the TypeScript admin HTTP oracle",
  async () => {
    if (MONGODB_URI === undefined) throw new Error("Missing replica set URI")
    const dir = fileURLToPath(new URL("../../../conformance/http/admin/", import.meta.url))
    expect(await recordAdmin(MONGODB_URI, dir, true)).toEqual([])
  },
  120_000,
)
