import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Authenticator } from "@canopy/auth"
import {
  CONTEXT_DOCUMENT_ID,
  ContextResolver,
  contextsFromStored,
  createPolicySet,
  fromStored,
} from "@canopy/policy"
import { createRestHandler, mongoContextReader, SchemaCache } from "@canopy/rest"
import { TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import { BSON, type Document, type MongoClient } from "mongodb"
import { type RecordedRequest, seed } from "../../../rest/test/conformance/find/harness.ts"
import { documentsOf, withoutCt } from "../../../rest/test/conformance/writes/record.ts"
import { createGraphqlHandler } from "../../src/handler.ts"
import { GRAPHQL_GROUPS, type Step } from "./cases.ts"
import { buildGraphqlFixture, type GraphqlFixture } from "./fixture.ts"

const ORIGIN = "http://canopy.test"
const CONTRACT_HEADERS = ["content-type", "x-canopy-ct", "x-request-id"] as const
const GENERATED_ID = "<object-id>"
const JSON_PARSER_MESSAGE = /("originalError":\{"name":"SyntaxError","message":)"(?:[^"\\]|\\.)*"/
const BUN_JSON = "application/json;charset=utf-8"
const NODE_JSON = "application/json"

interface RecordedStep {
  readonly request: RecordedRequest
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly alternateContentTypes?: readonly string[]
    readonly body: string
  }
}

interface RecordedCase {
  readonly id: string
  readonly title: string
  readonly steps: readonly RecordedStep[]
  readonly state?: Readonly<Record<string, readonly string[]>>
  readonly generatedId?: { readonly collection: string; readonly title: string }
  readonly known?: string
}

async function buildHandler(
  client: MongoClient,
  database: string,
  meta: string,
  fixture: GraphqlFixture,
) {
  const db = client.db(database)
  const stored = client.db(meta).collection<Document & { readonly _id: string }>("policies")
  await stored.insertMany([
    ...(fixture.policies.collections as (Document & { readonly _id: string })[]),
    { _id: CONTEXT_DOCUMENT_ID, lookups: fixture.policies.contexts },
  ])
  const definitions = (await stored.find({ _id: { $ne: CONTEXT_DOCUMENT_ID } }).toArray()).map(
    (doc) => fromStored(doc),
  )
  const contextDoc = await stored.findOne({ _id: CONTEXT_DOCUMENT_ID })
  const set = createPolicySet(definitions, contextsFromStored(contextDoc?.["lookups"]))
  const policies = testPolicyEngine(set)
  const authenticator = new Authenticator(
    {
      jwks: { keys: [...fixture.auth.jwks.keys] },
      issuer: fixture.auth.issuer,
      rolesClaim: fixture.auth.rolesClaim,
    },
    { publishable: fixture.auth.publishableKeys, secret: fixture.auth.secretKeys },
  )
  const contexts = new ContextResolver({ reader: mongoContextReader(db) })
  const rest = createRestHandler({
    client,
    database,
    metaDatabase: meta,
    policies,
    authenticator,
    contexts,
    readLimits: fixture.readLimits,
  })
  return createGraphqlHandler({
    reads: rest.reads,
    writes: rest.writes,
    policies,
    authenticator,
    contexts,
    schemas: new SchemaCache(db),
    path: fixture.basePath,
    limits: fixture.limits,
    maxBatch: fixture.maxBatch,
    maxBodyBytes: fixture.maxBodyBytes,
    introspection: fixture.introspection,
    persisted: fixture.persisted,
    collections: fixture.relations,
  })
}

function requestOf(
  fixture: GraphqlFixture,
  group: string,
  id: string,
  index: number,
  step: Step,
): RecordedRequest {
  const query = step.query ?? []
  const url = new URL(fixture.basePath, ORIGIN)
  for (const [name, value] of query) url.searchParams.append(name, value)
  return {
    method: step.method,
    target: `${url.pathname}${url.search}`,
    query,
    caller: step.caller,
    headers: { ...step.headers, "x-request-id": `${group}.${id}.${index}` },
    ...(step.body === undefined ? {} : { body: step.body }),
  }
}

async function capture(
  handler: Awaited<ReturnType<typeof buildHandler>>,
  fixture: GraphqlFixture,
  request: RecordedRequest,
): Promise<RecordedStep> {
  const caller = fixture.callers[request.caller]
  if (caller === undefined) throw new Error(`The fixture has no caller named ${request.caller}`)
  const response = await handler.fetch(
    new Request(`${ORIGIN}${request.target}`, {
      method: request.method,
      headers: { ...caller, ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
    }),
  )
  const headers: Record<string, string> = {}
  for (const name of CONTRACT_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  const body = withoutCt(headers, await response.text()).replace(
    JSON_PARSER_MESSAGE,
    '$1"<json-parser-message>"',
  )
  const contentType = headers["content-type"]
  const bodyLimit = response.status === 413 && body.includes('"code":"CANOPY_PAYLOAD_TOO_LARGE"')
  const variant = bodyLimit && (contentType === BUN_JSON || contentType === NODE_JSON)
  if (variant) headers["content-type"] = BUN_JSON
  return {
    request,
    response: {
      status: response.status,
      headers,
      ...(variant ? { alternateContentTypes: [NODE_JSON] } : {}),
      body,
    },
  }
}

async function captureCase(
  client: MongoClient,
  database: string,
  meta: string,
  fixture: GraphqlFixture,
  group: (typeof GRAPHQL_GROUPS)[number],
  spec: (typeof group.specs)[number],
): Promise<RecordedCase> {
  await client.db(database).dropDatabase()
  await client.db(meta).dropDatabase()
  await seed(client, database, fixture)
  const handler = await buildHandler(client, database, meta, fixture)
  try {
    const steps: RecordedStep[] = []
    for (const [index, step] of spec.steps.entries()) {
      const request = requestOf(fixture, group.name, spec.id, index, step)
      steps.push(await capture(handler, fixture, request))
    }
    const state: Record<string, string[]> = {}
    for (const name of spec.observe ?? []) state[name] = await documentsOf(client, database, name)
    if (spec.generatedId !== undefined) {
      const { collection, title } = spec.generatedId
      const docs = await client
        .db(database)
        .collection(collection)
        .find({ title })
        .limit(2)
        .toArray()
      const id = docs[0]?._id
      const observed = state[collection]
      if (docs.length !== 1 || !(id instanceof BSON.ObjectId) || observed === undefined)
        throw new Error(`Expected one observed document with a generated ObjectId in ${spec.id}`)
      const hex = id.toHexString()
      state[collection] = observed.map((doc) => doc.replaceAll(`"${hex}"`, `"${GENERATED_ID}"`))
      for (const [index, step] of steps.entries()) {
        const body = step.response.body.replaceAll(`"${hex}"`, `"${GENERATED_ID}"`)
        steps[index] = { ...step, response: { ...step.response, body } }
      }
    }
    return {
      id: spec.id,
      title: spec.title,
      steps,
      ...(spec.observe === undefined ? {} : { state }),
      ...(spec.generatedId === undefined ? {} : { generatedId: spec.generatedId }),
      ...(spec.known === undefined ? {} : { known: spec.known }),
    }
  } finally {
    handler.close()
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Runs the GraphQL HTTP cases against freshly seeded databases and writes the oracle under `options.dir`.
 * In check mode it returns the names of the files that differ from a fresh recording.
 */
export async function recordGraphql(options: {
  readonly client: MongoClient
  readonly dir: string
  readonly check?: boolean
}): Promise<string[]> {
  if (TEST_ENGINE !== "ts")
    throw new Error(
      "The cases are recorded against the TypeScript engine; unset CANOPY_TEST_ENGINE",
    )
  const { client } = options
  const fixtureText = json(await buildGraphqlFixture())
  const fixture = JSON.parse(fixtureText) as GraphqlFixture
  const outputs = new Map<string, string>([["fixture.json", fixtureText]])
  const database = `canopy_conformance_graphql_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  const meta = `${database}_meta`
  try {
    const ids = new Set<string>()
    for (const group of GRAPHQL_GROUPS) {
      const cases: RecordedCase[] = []
      for (const spec of group.specs) {
        if (ids.has(spec.id)) throw new Error(`The case id ${spec.id} is used twice`)
        ids.add(spec.id)
        cases.push(await captureCase(client, database, meta, fixture, group, spec))
      }
      outputs.set(
        join("cases", `${group.name}.json`),
        json({ group: group.name, description: group.description, cases }),
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
