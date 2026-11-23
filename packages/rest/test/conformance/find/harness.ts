import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Authenticator } from "@canopy/auth"
import { contextsFromStored, createPolicySet, fromStored } from "@canopy/policy"
import { isClusterTime, isUuidV7 } from "@canopy/protocol"
import { testPolicyEngine } from "@canopy/testing"
import type { JWK } from "jose"
import { BSON, type Document, type MongoClient } from "mongodb"
import { createRestHandler, type RestHandler, type RestHandlerOptions } from "../../../src/index.ts"

/** The origin the recorded requests are built against; only the path and query are part of a case. */
const ORIGIN = "http://canopy.test"

/** The committed description of everything a `find` case depends on besides the request itself. */
export interface Fixture {
  readonly name: string
  readonly basePath: string
  /** The read limits the handler runs with; every other limit keeps its default. */
  readonly readLimits: {
    readonly defaultLimit: number
    readonly maxLimit: number
    readonly maxSkip: number
  }
  readonly idTypes: Readonly<Record<string, string>>
  readonly auth: {
    readonly issuer: string
    readonly rolesClaim: string
    readonly jwks: { readonly keys: readonly JWK[] }
    readonly publishableKeys: readonly string[]
    readonly secretKeys: readonly string[]
  }
  /** The headers each named caller sends, credentials included. */
  readonly callers: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The documents of every collection, as canonical Extended JSON. */
  readonly collections: Readonly<Record<string, readonly unknown[]>>
  /** The policies in the stored form of `canopy.policies`, and the context lookups of `_context`. */
  readonly policies: {
    readonly collections: readonly unknown[]
    readonly contexts: Readonly<Record<string, unknown>>
  }
}

/** The response headers a case pins. Every other header (`date`, `content-length`, ...) is transport. */
const CONTRACT_HEADERS: readonly string[] = [
  "allow",
  "content-type",
  "etag",
  "location",
  "retry-after",
  "vary",
  "www-authenticate",
  "x-canopy-ct",
  "x-request-id",
]

/**
 * The kinds of value a response may carry that no fixture can fix: the cluster time of the snapshot, a request
 * id the server minted, and an error detail that quotes text of the regular expression engine, which differs
 * between implementations.
 */
type VolatileRule = "cluster-time" | "request-id" | "engine-text"

/** Where a volatile value sits in a response: a header, a JSON path of the body, or both. */
export interface Volatile {
  readonly rule: VolatileRule
  readonly header?: string
  readonly body?: string
}

/** The request of one case. `target` is the exact request target, path and query, as sent. */
export interface RecordedRequest {
  readonly method: string
  readonly target: string
  /** The decoded query parameters of `target`, in order, for readers; `target` is what is sent. */
  readonly query: readonly (readonly [string, string])[]
  /** A key of {@link Fixture.callers}, whose headers are sent in addition to `headers`. */
  readonly caller: string
  readonly headers: Readonly<Record<string, string>>
  /** The exact request body, for the routes that take one. */
  readonly body?: string
}

/** The response of one case. */
export interface RecordedResponse {
  readonly status: number
  /** The {@link CONTRACT_HEADERS} the response carried, by lower case name, with volatile values replaced. */
  readonly headers: Readonly<Record<string, string>>
  /** The exact body text, with volatile values replaced by their placeholder. */
  readonly body: string
  readonly volatile: readonly Volatile[]
  /** Text no body of the case may contain, whatever else the response says. */
  readonly neverInBody: readonly string[]
}

/** One recorded request and response. */
interface RecordedCase {
  readonly id: string
  readonly title: string
  readonly request: RecordedRequest
  readonly response: RecordedResponse
  /** Set when the pinned behavior is a known defect or a known gap between the documentation and the code. */
  readonly known?: string
}

/** One file of cases. */
export interface CaseFile {
  readonly group: string
  readonly description: string
  readonly cases: readonly RecordedCase[]
}

const CT_PLACEHOLDER = "<ct>"
const REQUEST_ID_PLACEHOLDER = "<request-id>"
const ENGINE_TEXT_PLACEHOLDER = "<engine-text>"
const DETAIL = /"detail":("(?:[^"\\]|\\.)*")/
const CT_SUFFIX = /,"ct":"(\d+)"\}$/

/** Reads the fixture from `dir`. */
export async function loadFixture(dir: string): Promise<Fixture> {
  return JSON.parse(await readFile(join(dir, "fixture.json"), "utf8")) as Fixture
}

/** Reads every case file of `dir/cases`, in file name order. */
export async function loadCaseFiles(dir: string): Promise<CaseFile[]> {
  const names = (await readdir(join(dir, "cases"))).filter((name) => name.endsWith(".json")).sort()
  const files: CaseFile[] = []
  for (const name of names)
    files.push(JSON.parse(await readFile(join(dir, "cases", name), "utf8")) as CaseFile)
  return files
}

/** Fills the collections of a database with the documents of the fixture. */
export async function seed(client: MongoClient, database: string, fixture: Fixture): Promise<void> {
  const db = client.db(database)
  for (const [name, documents] of Object.entries(fixture.collections)) {
    const parsed = BSON.EJSON.parse(JSON.stringify(documents), { relaxed: false }) as Document[]
    if (parsed.length > 0) await db.collection(name).insertMany(parsed)
  }
}

/** Builds the TypeScript REST handler the cases were recorded against, with `extra` options on top. */
export function buildHandler(
  client: MongoClient,
  database: string,
  fixture: Fixture,
  extra: Partial<RestHandlerOptions> = {},
): RestHandler {
  const definitions = fixture.policies.collections.map((stored) => fromStored(stored))
  const set = createPolicySet(definitions, contextsFromStored(fixture.policies.contexts))
  return createRestHandler({
    client,
    database,
    policies: testPolicyEngine(set),
    authenticator: new Authenticator(
      {
        jwks: { keys: [...fixture.auth.jwks.keys] },
        issuer: fixture.auth.issuer,
        rolesClaim: fixture.auth.rolesClaim,
      },
      { publishable: fixture.auth.publishableKeys, secret: fixture.auth.secretKeys },
    ),
    basePath: fixture.basePath,
    idTypes: fixture.idTypes as Record<string, "auto">,
    readLimits: fixture.readLimits,
    ...extra,
  })
}

/** The headers a request is sent with: those of its caller, then its own. */
function headersOf(fixture: Fixture, request: RecordedRequest): Record<string, string> {
  const caller = fixture.callers[request.caller]
  if (caller === undefined) throw new Error(`The fixture has no caller named ${request.caller}`)
  return { ...caller, ...request.headers }
}

/** Sends a request to the handler. */
export function send(
  handler: RestHandler,
  fixture: Fixture,
  request: RecordedRequest,
): Promise<Response> {
  return handler.fetch(
    new Request(`${ORIGIN}${request.target}`, {
      method: request.method,
      headers: headersOf(fixture, request),
      ...(request.body === undefined ? {} : { body: request.body }),
    }),
  )
}

/** Thrown when a response does not satisfy the rule of a volatile value. */
class VolatileError extends Error {}

/**
 * Turns a response into its recorded form. `rules` are the volatile rules to apply, or `undefined` to detect
 * them from the response (recording). Every volatile value is checked against its rule and replaced by a
 * placeholder, so the rest of the response can be compared byte for byte.
 */
export async function capture(
  response: Response,
  rules?: readonly Volatile[],
  extra: readonly Volatile[] = [],
): Promise<Pick<RecordedResponse, "status" | "headers" | "body" | "volatile">> {
  const text = await response.text()
  const headers: Record<string, string> = {}
  for (const name of CONTRACT_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  const volatile = rules ?? [...detect(headers, text), ...extra]
  let body = text
  for (const item of volatile) {
    if (item.rule === "cluster-time") {
      const fromHeader = item.header === undefined ? undefined : headers[item.header]
      const fromBody = item.body === undefined ? undefined : ctOfBody(body)
      for (const value of [fromHeader, fromBody]) {
        if (value !== undefined && (!isClusterTime(value) || value === "0"))
          throw new VolatileError(`${value} is not a cluster time`)
      }
      if (fromHeader !== undefined && fromBody !== undefined && fromHeader !== fromBody)
        throw new VolatileError("The cluster time of the header and of the body differ")
      if (item.header !== undefined && fromHeader !== undefined)
        headers[item.header] = CT_PLACEHOLDER
      if (item.body !== undefined && fromBody !== undefined)
        body = body.replace(CT_SUFFIX, `,"ct":"${CT_PLACEHOLDER}"}`)
      if (
        (item.header !== undefined && fromHeader === undefined) ||
        (item.body !== undefined && fromBody === undefined)
      )
        throw new VolatileError("The response lacks a cluster time the recording has")
    } else if (item.rule === "engine-text") {
      const match = DETAIL.exec(body)
      const detail = match?.[1] === undefined ? undefined : (JSON.parse(match[1]) as string)
      if (match === null || detail === undefined || detail === "")
        throw new VolatileError("The body has no detail text")
      body = body.replace(match[0], `"detail":"${ENGINE_TEXT_PLACEHOLDER}"`)
    } else {
      const fromHeader = item.header === undefined ? undefined : headers[item.header]
      if (fromHeader === undefined || !isUuidV7(fromHeader))
        throw new VolatileError(`${fromHeader ?? "nothing"} is not a minted request id`)
      if (item.header !== undefined) headers[item.header] = REQUEST_ID_PLACEHOLDER
      if (item.body !== undefined) {
        const needle = `"requestId":${JSON.stringify(fromHeader)}`
        if (body.split(needle).length !== 2)
          throw new VolatileError("The body does not carry the request id of the header once")
        body = body.replace(needle, `"requestId":"${REQUEST_ID_PLACEHOLDER}"`)
      }
    }
  }
  return { status: response.status, headers: sorted(headers), body, volatile }
}

function ctOfBody(text: string): string | undefined {
  return CT_SUFFIX.exec(text)?.[1]
}

function detect(headers: Readonly<Record<string, string>>, text: string): Volatile[] {
  const found: Volatile[] = []
  if (headers["x-canopy-ct"] !== undefined)
    found.push({
      rule: "cluster-time",
      header: "x-canopy-ct",
      ...(CT_SUFFIX.test(text) ? { body: "$.ct" } : {}),
    })
  else if (CT_SUFFIX.test(text)) found.push({ rule: "cluster-time", body: "$.ct" })
  const id = headers["x-request-id"]
  if (id !== undefined && isUuidV7(id))
    found.push({
      rule: "request-id",
      header: "x-request-id",
      ...(text.includes(`"requestId":${JSON.stringify(id)}`) ? { body: "$.requestId" } : {}),
    })
  return found
}

function sorted(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The decoded query parameters of a request target. */
export function queryOf(target: string): [string, string][] {
  return [...new URL(`${ORIGIN}${target}`).searchParams]
}
