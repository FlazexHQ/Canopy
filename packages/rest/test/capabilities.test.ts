import { CanopyError, ErrorCode } from "@canopy/protocol"
import { type Db, MongoNetworkError, MongoServerError } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { probeSearch, searchDiagnostics } from "../src/index.ts"

const ready = { name: "text", type: "search", status: "READY", queryable: true }
const building = { name: "embedding", type: "vectorSearch", status: "BUILDING", queryable: false }
const reason =
  "Search is not available on this MongoDB deployment; it needs Atlas, an Atlas local deployment or MongoDB Search"

function deployment(list: (name: string) => unknown[]) {
  const aggregate = vi.fn(
    (name: string, _pipeline: unknown, _options: { signal?: AbortSignal }) => ({
      toArray: async () => list(name),
      [Symbol.asyncDispose]: async () => {},
    }),
  )
  const db = {
    collection: (name: string) => ({
      aggregate: (pipeline: unknown, options: { signal?: AbortSignal }) =>
        aggregate(name, pipeline, options),
    }),
  } as unknown as Db
  return { db, aggregate }
}

describe("search capability", () => {
  it("lists the configured collections and reports indexes that are still building", async () => {
    const { db, aggregate } = deployment((name) =>
      name === "notes" ? [{ ...ready, latestDefinition: {} }] : [building],
    )
    const signal = new AbortController().signal
    const capability = await probeSearch(db, ["notes", "photos"], { signal })
    expect(aggregate.mock.calls).toEqual([
      ["notes", [{ $listSearchIndexes: {} }], { signal }],
      ["photos", [{ $listSearchIndexes: {} }], { signal }],
    ])
    expect(capability).toEqual({
      available: true,
      collections: [
        { name: "notes", indexes: [ready] },
        { name: "photos", indexes: [building] },
      ],
    })
    expect(searchDiagnostics(capability, 2)).toEqual([
      { status: "ok", message: "search: 2 collections, 1 indexes ready" },
      { status: "warn", message: "search index photos.embedding is BUILDING" },
    ])
  })

  it.each([
    { collections: ["notes"], status: "warn" },
    { collections: [], status: "ok" },
  ])("reports SearchNotEnabled as $status for $collections", async ({ collections, status }) => {
    const { db, aggregate } = deployment(() => {
      throw new MongoServerError({ code: 31082, codeName: "SearchNotEnabled", message: "disabled" })
    })
    const capability = await probeSearch(db, collections)
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(capability).toEqual({ available: false, reason })
    expect(searchDiagnostics(capability, collections.length)).toEqual([
      { status, message: `search: ${reason}` },
    ])
  })

  it("propagates connectivity failures as Canopy errors", async () => {
    const cause = new MongoNetworkError("connection closed")
    const { db } = deployment(() => {
      throw cause
    })
    const result = probeSearch(db, ["notes"])
    await expect(result).rejects.toBeInstanceOf(CanopyError)
    await expect(result).rejects.toMatchObject({ code: ErrorCode.Unavailable, cause })
  })

  it("probes once without counting the probe collection or its indexes", async () => {
    const { db, aggregate } = deployment(() => [ready])
    expect(await probeSearch(db, [])).toEqual({ available: true, collections: [] })
    expect(aggregate).toHaveBeenCalledTimes(1)
  })

  it("defaults missing or invalid index fields and skips entries without a string name", async () => {
    const { db } = deployment(() => [
      { name: "legacy" },
      { status: "BUILDING" },
      { name: 7 },
      { ...building, queryable: "true" },
    ])
    expect(await probeSearch(db, ["notes"])).toEqual({
      available: true,
      collections: [
        {
          name: "notes",
          indexes: [
            { name: "legacy", type: "search", status: "UNKNOWN", queryable: false },
            building,
          ],
        },
      ],
    })
  })
})
