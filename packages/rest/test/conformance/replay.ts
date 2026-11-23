import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { RestHandler } from "../../src/index.ts"
import {
  buildHandler,
  capture,
  loadCaseFiles,
  loadFixture,
  queryOf,
  seed,
  send,
} from "./find/harness.ts"

/**
 * Replays every recorded case of a `conformance/http` folder against the TypeScript handler. A recording is
 * the oracle the Rust data plane is held to, so TypeScript must keep reproducing it byte for byte (after the
 * documented placeholders only). When behavior changes on purpose, regenerate it with `bun run vectors:http`.
 * `minimumCases` guards against a recording that lost cases.
 */
export async function replayRecordedCases(
  name: string,
  dir: string,
  minimumCases: number,
): Promise<void> {
  const fixture = await loadFixture(dir)
  const files = await loadCaseFiles(dir)
  const suite = MONGODB_URI === undefined ? describe.skip : describe

  suite(`conformance/http/${name} replayed against the TypeScript handler`, () => {
    const database = `canopy_conformance_${name}_${process.pid}_${Math.floor(Math.random() * 1e9)}`
    let client: MongoClient
    let handler: RestHandler

    beforeAll(async () => {
      client = new MongoClient(MONGODB_URI ?? "", { serverSelectionTimeoutMS: 10_000 })
      await client.connect()
      await seed(client, database, fixture)
      handler = buildHandler(client, database, fixture)
    })

    afterAll(async () => {
      await client.db(database).dropDatabase()
      await client.close()
    })

    it("has recorded cases with unique ids, in files named after their group", () => {
      const ids = files.flatMap((file) => file.cases.map((item) => item.id))
      expect(ids.length).toBeGreaterThanOrEqual(minimumCases)
      expect(new Set(ids).size).toBe(ids.length)
      for (const file of files) expect(file.cases.length).toBeGreaterThan(0)
    })

    for (const file of files) {
      describe(file.group, () => {
        for (const item of file.cases) {
          it(`${item.id}: ${item.title}`, async () => {
            expect(item.request.query, "the decoded query matches the target").toEqual(
              queryOf(item.request.target),
            )
            const actual = await capture(
              await send(handler, fixture, item.request),
              item.response.volatile,
            )
            expect(actual.status).toBe(item.response.status)
            expect(actual.headers).toEqual(item.response.headers)
            expect(actual.body).toBe(item.response.body)
            for (const forbidden of item.response.neverInBody)
              expect(actual.body).not.toContain(forbidden)
          })
        }
      })
    }
  })
}
