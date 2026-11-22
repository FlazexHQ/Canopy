import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Collection, Document } from "mongodb"

const revision = "2a20bd509e2ad4ee354b552145094ecdf434ee9d"
const source = `https://raw.githubusercontent.com/mongodb/specifications/${revision}/source/crud/tests/unified`
const allowlist = {
  find: [
    "Find with filter",
    "Find with filter, sort, skip, and limit",
    "Find with limit, sort, and batchsize",
  ],
  aggregate: ["Aggregate with multiple stages"],
  insertOne: ["InsertOne with a non-existing document"],
  updateOne: ["UpdateOne when one document matches", "UpdateOne when no documents match"],
} as const

type FixtureDocument = { _id: number; x: number }
type OwnedDocument = FixtureDocument & { ownerId: string }
type FixtureArguments = {
  filter?: Document
  sort?: Document
  skip?: number
  limit?: number
  batchSize?: number
  pipeline?: Document[]
  document?: OwnedDocument
  update?: Document
}
type Operation = {
  name: string
  object: string
  arguments: FixtureArguments
  expectResult: unknown
}
type Suite = {
  initialData: [{ documents: FixtureDocument[] }]
  tests: {
    description: string
    operations: Operation[]
    outcome?: [{ documents: FixtureDocument[] }]
    expectEvents?: unknown
    runOnRequirements?: unknown
  }[]
}
type Input = { operation: Operation; result: string }

function shiftedFilter(filter: Document, base: number): Document {
  if ("_id" in filter) {
    const id: unknown = filter["_id"]
    if (typeof id === "number") return { _id: base + id }
    assert.ok(id !== null && typeof id === "object" && "$gt" in id && typeof id.$gt === "number")
    return { _id: { $gt: base + id.$gt } }
  }
  assert.deepEqual(filter, {})
  return filter
}

export async function runNodeCase(items: Collection<OwnedDocument>, input: string) {
  const { operation, result } = JSON.parse(await readFile(input, "utf8")) as Input
  const args = operation.arguments
  let value: unknown
  switch (operation.name) {
    case "find":
      value = await items
        .find(args.filter ?? {}, {
          sort: args.sort,
          skip: args.skip,
          limit: args.limit,
          batchSize: args.batchSize,
        })
        .toArray()
      break
    case "aggregate":
      value = await items.aggregate(args.pipeline, { batchSize: args.batchSize }).toArray()
      break
    case "insertOne":
      assert.ok(args.document)
      value = { insertedId: (await items.insertOne(args.document)).insertedId }
      break
    case "updateOne": {
      assert.ok(args.filter && args.update)
      const write = await items.updateOne(args.filter, args.update)
      value = {
        matchedCount: write.matchedCount,
        modifiedCount: write.modifiedCount,
        upsertedCount: write.upsertedCount,
      }
      break
    }
    default:
      throw new Error(`Unexpected operation: ${operation.name}`)
  }
  await writeFile(result, JSON.stringify(value))
}

export async function verifyUnified(
  items: Collection<OwnedDocument>,
  ownerId: string,
  scratch: string,
  runners: [string, (path: string) => Promise<void>][],
) {
  const path = join(scratch, "unified-input.json")
  const result = join(scratch, "unified-result.json")
  const suites = await Promise.all(
    Object.entries(allowlist).map(async ([name, cases]) => {
      const response = await fetch(`${source}/${name}.json`, {
        signal: AbortSignal.timeout(30_000),
      })
      assert.ok(response.ok, `Download ${name}.json: ${response.status}`)
      return { name, cases, suite: (await response.json()) as Suite }
    }),
  )
  let passed = 0
  for (const { name, cases, suite } of suites) {
    for (const description of cases) {
      const fixture = suite.tests.find((test) => test.description === description)
      assert.ok(fixture, description)
      assert.equal(fixture.expectEvents, undefined, description)
      assert.equal(fixture.runOnRequirements, undefined, description)
      const [operation, ...extra] = fixture.operations
      assert.ok(
        operation &&
          extra.length === 0 &&
          operation.name === name &&
          operation.object === "collection0",
      )
      const initial = suite.initialData[0].documents
      for (const [driver, run] of runners) {
        const base = randomInt(10_000, 2_000_000_000)
        const adapt = (doc: FixtureDocument) => ({ ...doc, _id: base + doc._id, ownerId })
        const args: FixtureArguments = { ...operation.arguments }
        let expected: unknown = operation.expectResult
        if (args.filter !== undefined) args.filter = shiftedFilter(args.filter, base)
        if (args.pipeline !== undefined)
          args.pipeline = args.pipeline.map((stage) => {
            if (!("$match" in stage)) return stage
            return { $match: shiftedFilter(stage["$match"], base) }
          })
        if (operation.name === "insertOne") {
          assert.ok(args.document)
          assert.deepEqual(expected, {
            $$unsetOrMatches: { insertedId: { $$unsetOrMatches: args.document._id } },
          })
          args.document = adapt(args.document)
          expected = { insertedId: args.document._id }
        } else if (Array.isArray(expected)) {
          expected = expected.map(adapt)
        }
        const docs = initial.map(adapt)
        const scope = { ownerId }
        try {
          await items.insertMany(docs)
          await writeFile(
            path,
            JSON.stringify({ operation: { ...operation, arguments: args }, result }),
          )
          await writeFile(result, "")
          await run(path)
          assert.deepEqual(
            JSON.parse(await readFile(result, "utf8")),
            expected,
            `${driver}: ${description}`,
          )
          const outcome: FixtureDocument[] | undefined = fixture.outcome?.[0]?.documents
          if (outcome !== undefined) {
            assert.deepEqual(
              await items.find(scope).sort({ _id: 1 }).toArray(),
              outcome.map(adapt),
              description,
            )
          }
          passed++
          process.stdout.write(`Unified fixture passed: ${driver}, ${description}\n`)
        } finally {
          await items.deleteMany(scope)
        }
      }
    }
  }
  process.stdout.write(`Unified CRUD fixtures: ${passed} passed\n`)
}
