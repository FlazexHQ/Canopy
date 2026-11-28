import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { recordGraphqlSchemas } from "./conformance/schema/record.ts"

const file = fileURLToPath(new URL("../../../conformance/graphql/schema.json", import.meta.url))

it("keeps the Rust schema vectors current with the TypeScript answers", async () => {
  expect(await recordGraphqlSchemas({ file, check: true })).toBe(false)
})
