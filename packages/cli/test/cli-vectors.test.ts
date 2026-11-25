import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { expect, it } from "vitest"
import { recordCli } from "./conformance/cli/record.ts"

const dir = fileURLToPath(new URL("../../../conformance/cli", import.meta.url))
const uri = MONGODB_URI

it.skipIf(uri === undefined)(
  "reproduces the TypeScript CLI oracle",
  { timeout: 240_000 },
  async () => {
    if (uri === undefined) throw new Error("Missing MongoDB URI")
    expect(await recordCli(dir, uri, true)).toEqual([])
  },
)
