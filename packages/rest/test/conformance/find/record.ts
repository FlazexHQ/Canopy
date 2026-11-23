import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TEST_ENGINE } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { forgeCursor, GROUPS, type Group, type Recorded, type Spec, type Value } from "./cases.ts"
import { buildFixture } from "./fixture.ts"
import {
  buildHandler,
  type CaseFile,
  capture,
  type Fixture,
  queryOf,
  type RecordedRequest,
  seed,
  send,
} from "./harness.ts"

/** Options of {@link recordFind}. */
export interface RecordOptions {
  /** A MongoDB replica set. */
  readonly uri: string
  /** The folder to write, such as `conformance/http/find`. */
  readonly dir: string
  /** Compare with the files in `dir` instead of writing them. */
  readonly check?: boolean
}

type RecordedCase = CaseFile["cases"][number]

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function cursorParts(cursor: string): { s: unknown; q: string } {
  const padded = cursor.replaceAll("-", "+").replaceAll("_", "/")
  const json = Buffer.from(padded, "base64").toString("utf8")
  return JSON.parse(json) as { s: unknown; q: string }
}

/**
 * Records the cases of `find`: builds the fixture, seeds a scratch database on the replica set, serves every
 * case with the TypeScript REST handler and writes (or, with `check`, compares) `fixture.json` and one file
 * per group under `cases/`. Returns the files that differ from the ones on disk, which is none for a
 * deterministic recording of unchanged behavior.
 */
export function recordFind(options: RecordOptions): Promise<string[]> {
  return recordGroups(options, GROUPS)
}

/**
 * Records the cases of `groups` the way {@link recordFind} records those of `find`, against the same fixture:
 * `fixture.json` and one file per group under `cases/` in `options.dir`.
 */
export async function recordGroups(
  options: RecordOptions,
  groups: readonly Group[],
): Promise<string[]> {
  if (TEST_ENGINE !== "ts")
    throw new Error(
      "The cases are recorded against the TypeScript engine; unset CANOPY_TEST_ENGINE",
    )
  const outputs = new Map<string, string>()
  const fixtureText = text(await buildFixture())
  outputs.set("fixture.json", fixtureText)
  const fixture = JSON.parse(fixtureText) as Fixture

  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  const database = `canopy_conformance_find_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  try {
    await seed(client, database, fixture)
    const handler = buildHandler(client, database, fixture)
    const done = new Map<string, RecordedCase>()
    const responseOf = (id: string): RecordedCase => {
      const found = done.get(id)
      if (found === undefined)
        throw new Error(`A case refers to ${id}, which is not recorded before it`)
      return found
    }
    const nextOf = (id: string): string => {
      const next = (JSON.parse(responseOf(id).response.body) as { page?: { next?: unknown } }).page
        ?.next
      if (typeof next !== "string") throw new Error(`${id} has no next cursor`)
      return next
    }
    const recorded: Recorded = {
      next: nextOf,
      etag: (id) => {
        const etag = responseOf(id).response.headers["etag"]
        if (etag === undefined) throw new Error(`${id} has no etag`)
        return etag
      },
      forge: (id, values) => forgeCursor(cursorParts(nextOf(id)).q, values),
      raw: (value) => Buffer.from(value, "utf8").toString("base64url"),
      hash: (id) => cursorParts(nextOf(id)).q,
    }
    const resolve = (value: Value): string => (typeof value === "string" ? value : value(recorded))

    for (const group of groups) {
      const cases: RecordedCase[] = []
      for (const spec of group.specs) {
        if (done.has(spec.id)) throw new Error(`The case id ${spec.id} is used twice`)
        const request = requestOf(group.name, spec, resolve)
        const response = await capture(
          await send(handler, fixture, request),
          undefined,
          spec.engineDetail ? [{ rule: "engine-text", body: "$.detail" }] : [],
        )
        for (const forbidden of spec.neverInBody) {
          if (response.body.includes(forbidden))
            throw new Error(`${spec.id}: the body contains ${JSON.stringify(forbidden)}`)
        }
        const item: RecordedCase = {
          id: spec.id,
          title: spec.title,
          request,
          response: { ...response, neverInBody: spec.neverInBody },
          ...(spec.known === undefined ? {} : { known: spec.known }),
        }
        done.set(spec.id, item)
        cases.push(item)
      }
      const file: CaseFile = { group: group.name, description: group.description, cases }
      outputs.set(join("cases", `${group.name}.json`), text(file))
    }
  } finally {
    await client.db(database).dropDatabase()
    await client.close()
  }

  const differing: string[] = []
  for (const [name, content] of outputs) {
    const path = join(options.dir, name)
    if (options.check === true) {
      const current = await readFile(path, "utf8").catch(() => undefined)
      if (current !== content) differing.push(name)
    } else {
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, content)
    }
  }
  return differing
}

function requestOf(group: string, spec: Spec, resolve: (value: Value) => string): RecordedRequest {
  const query = spec.query.map(([name, value]) => [name, resolve(value)] as [string, string])
  const target =
    query.length === 0 ? spec.path : `${spec.path}?${new URLSearchParams(query).toString()}`
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(spec.headers)) headers[name] = resolve(value)
  if (!spec.minted) headers["x-request-id"] = `${group}.${spec.id}`
  return {
    method: spec.method,
    target,
    query: queryOf(target),
    caller: spec.caller,
    headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1))),
    ...(spec.body === undefined ? {} : { body: resolve(spec.body) }),
  }
}
