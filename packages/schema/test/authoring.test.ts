import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import { recordSchemaAuthoring } from "./authoring-record.ts"

it("replays schema builder output, invalid authoring and pull", async () => {
  const fixture = new URL("../../../conformance/authoring/schema/vectors.json", import.meta.url)
  const actual = await recordSchemaAuthoring()
  expect(`${JSON.stringify(actual, null, 2)}\n`).toBe(await readFile(fixture, "utf8"))
})
