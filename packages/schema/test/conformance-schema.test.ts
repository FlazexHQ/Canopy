import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { recordSchemas } from "./conformance/record.ts"

const file = fileURLToPath(new URL("../../../conformance/schema/schema.json", import.meta.url))

it("keeps the Rust schema vectors current with the TypeScript answers", async () => {
  expect(await recordSchemas({ file, check: true })).toBe(false)
})
