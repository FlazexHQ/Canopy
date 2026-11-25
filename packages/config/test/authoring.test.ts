import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import { recordConfigAuthoring } from "./authoring-record.ts"

it("replays config authoring, environment resolution and source attribution", async () => {
  const fixture = new URL("../../../conformance/authoring/config/vectors.json", import.meta.url)
  const actual = await recordConfigAuthoring()
  expect(`${JSON.stringify(actual, null, 2)}\n`).toBe(await readFile(fixture, "utf8"))
})
