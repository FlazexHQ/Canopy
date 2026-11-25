import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import { recordAuthoringPolicy } from "./conformance/authoring/record.ts"

it("replays the policy authoring contract through the Canopy.js builders", async () => {
  const vectors = new URL("../../../conformance/authoring/policy/vectors.json", import.meta.url)
  expect(await recordAuthoringPolicy()).toBe(await readFile(vectors, "utf8"))
})
