import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import {
  recordAuthoringDiagnostics,
  recordAuthoringPolicy,
  recordAuthoringPublishing,
} from "./conformance/authoring/record.ts"

const vector = (name: string) =>
  readFile(new URL(`../../../conformance/authoring/policy/${name}`, import.meta.url), "utf8")

it("replays the policy authoring contract through the Canopy.js builders", async () => {
  expect(await recordAuthoringPolicy()).toBe(await vector("vectors.json"))
})

it("publishes every authoring set to the stored documents the vectors record", async () => {
  expect(recordAuthoringPublishing()).toBe(await vector("publishing.json"))
})

it("reports the lint and explain diagnostics the vectors record", async () => {
  expect(recordAuthoringDiagnostics()).toBe(await vector("diagnostics.json"))
})
