import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { recordStudio } from "./conformance/record.ts"

it("matches the standalone Studio HTTP oracle", async () => {
  const dir = fileURLToPath(new URL("../../../conformance/http/studio/", import.meta.url))
  expect(await recordStudio(dir, true)).toBe(true)
})
