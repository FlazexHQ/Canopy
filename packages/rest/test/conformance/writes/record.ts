import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isClusterTime } from "@canopy/protocol"
import { TEST_ENGINE } from "@canopy/testing"
import { BSON, type Document, type MongoClient } from "mongodb"
import { buildHandler, type RecordedRequest, send } from "../find/harness.ts"
import { type Step, WRITE_GROUPS, type WriteGroup } from "./cases.ts"
import { buildWritesFixture, type WritesFixture } from "./fixture.ts"

/** The response headers a write case pins. */
const CONTRACT_HEADERS: readonly string[] = [
  "allow",
  "content-type",
  "location",
  "x-canopy-ct",
  "x-request-id",
]

const CT_PLACEHOLDER = "<ct>"
const CT_IN_BODY = /"ct":"(\d+)"/g

/** One recorded step: the request and what answered it, with every cluster time replaced by `<ct>`. */
interface RecordedStep {
  readonly request: RecordedRequest
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }
}

/** One recorded case: its steps and the state after the last one. */
interface RecordedWriteCase {
  readonly id: string
  readonly title: string
  readonly steps: readonly RecordedStep[]
  /** The documents of each observed collection after the last step, in `_id` order, as canonical EJSON. */
  readonly state: Readonly<Record<string, readonly string[]>>
  /** The idempotency records after the last step, in `_id` order, without their time, as canonical EJSON. */
  readonly records?: readonly string[]
}

/** Replaces the cluster times of a response, checking that each is one. */
export function withoutCt(headers: Record<string, string>, body: string): string {
  const header = headers["x-canopy-ct"]
  if (header !== undefined) {
    if (!isClusterTime(header) || header === "0") throw new Error(`${header} is not a cluster time`)
    headers["x-canopy-ct"] = CT_PLACEHOLDER
  }
  return body.replace(CT_IN_BODY, (_, value: string) => {
    if (!isClusterTime(value) || value === "0") throw new Error(`${value} is not a cluster time`)
    return `"ct":"${CT_PLACEHOLDER}"`
  })
}

/** Drops the databases of a case and creates its collections, options, indexes and documents again. */
async function reset(
  client: MongoClient,
  database: string,
  meta: string,
  fixture: WritesFixture,
): Promise<void> {
  await client.db(database).dropDatabase()
  await client.db(meta).dropDatabase()
  const db = client.db(database)
  for (const [name, documents] of Object.entries(fixture.collections)) {
    const setup = fixture.setup[name]
    await db.createCollection(name, setup?.options ?? {})
    for (const index of setup?.indexes ?? [])
      await db.collection(name).createIndex(index.key, {
        name: index.name,
        ...(index.unique === true ? { unique: true } : {}),
      })
    const parsed = BSON.EJSON.parse(JSON.stringify(documents), { relaxed: false }) as Document[]
    if (parsed.length > 0) await db.collection(name).insertMany(parsed)
  }
}

/** The documents of `name`, in `_id` order, as canonical EJSON. */
export async function documentsOf(
  client: MongoClient,
  database: string,
  name: string,
): Promise<string[]> {
  const found = await client
    .db(database)
    .collection(name)
    .find({}, { promoteValues: false, promoteLongs: false, promoteBuffers: false })
    .sort({ _id: 1 })
    .toArray()
  return found.map((doc) => BSON.EJSON.stringify(doc, { relaxed: false }))
}

/** The idempotency records, in `_id` order, without their time. */
async function recordsOf(client: MongoClient, meta: string): Promise<string[]> {
  const found = await client
    .db(meta)
    .collection("mutations")
    .find(
      {},
      { promoteValues: false, promoteLongs: false, promoteBuffers: false, projection: { at: 0 } },
    )
    .sort({ _id: 1 })
    .toArray()
  return found.map((doc) => BSON.EJSON.stringify(doc, { relaxed: false }))
}

function requestOf(
  group: string,
  id: string,
  index: number,
  step: Step,
  basePath: string,
): RecordedRequest {
  const headers: Record<string, string> = {
    ...step.headers,
    "x-request-id": `${group}.${id}.${index}`,
  }
  const target = `${basePath}${step.target}`
  return {
    method: step.method,
    target,
    query: [...new URL(`http://canopy.test${target}`).searchParams],
    caller: step.caller,
    headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1))),
    ...(step.body === undefined
      ? {}
      : { body: step.raw === true ? String(step.body) : JSON.stringify(step.body) }),
  }
}

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Records the writes oracle: for each case, the app and meta databases are dropped and seeded again, the steps
 * are sent to the TypeScript REST handler one after the other, and the responses, the observed collections and
 * the idempotency records are written (or, with `check`, compared) under `options.dir`. Returns the files that
 * differ from the ones on disk.
 */
export async function recordWrites(options: {
  readonly client: MongoClient
  readonly dir: string
  readonly check?: boolean
  readonly groups?: readonly WriteGroup[]
}): Promise<string[]> {
  if (TEST_ENGINE !== "ts")
    throw new Error(
      "The cases are recorded against the TypeScript engine; unset CANOPY_TEST_ENGINE",
    )
  const outputs = new Map<string, string>()
  const fixtureText = text(await buildWritesFixture())
  outputs.set("fixture.json", fixtureText)
  const fixture = JSON.parse(fixtureText) as WritesFixture
  const { client } = options
  const database = `canopy_conformance_writes_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  const meta = `${database}_meta`
  try {
    const ids = new Set<string>()
    for (const group of options.groups ?? WRITE_GROUPS) {
      const cases: RecordedWriteCase[] = []
      for (const spec of group.specs) {
        if (ids.has(spec.id)) throw new Error(`The case id ${spec.id} is used twice`)
        ids.add(spec.id)
        await reset(client, database, meta, fixture)
        const handler = buildHandler(client, database, fixture, { metaDatabase: meta })
        const steps: RecordedStep[] = []
        for (const [index, step] of spec.steps.entries()) {
          const request = requestOf(group.name, spec.id, index, step, fixture.basePath)
          const response = await send(handler, fixture, request)
          const headers: Record<string, string> = {}
          for (const name of CONTRACT_HEADERS) {
            const value = response.headers.get(name)
            if (value !== null) headers[name] = value
          }
          const body = withoutCt(headers, await response.text())
          steps.push({ request, response: { status: response.status, headers, body } })
        }
        const state: Record<string, string[]> = {}
        for (const name of spec.observe) state[name] = await documentsOf(client, database, name)
        cases.push({
          id: spec.id,
          title: spec.title,
          steps,
          state,
          ...(spec.records === true ? { records: await recordsOf(client, meta) } : {}),
        })
      }
      outputs.set(
        join("cases", `${group.name}.json`),
        text({ group: group.name, description: group.description, cases }),
      )
    }
  } finally {
    await client.db(database).dropDatabase()
    await client.db(meta).dropDatabase()
  }
  const differing: string[] = []
  for (const [name, content] of outputs) {
    const path = join(options.dir, name)
    if (options.check === true) {
      const current = await readFile(path, "utf8").catch(() => undefined)
      if (current?.replaceAll("\r\n", "\n") !== content) differing.push(name)
    } else {
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, content)
    }
  }
  return differing
}
