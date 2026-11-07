import { type Authenticator, credentialsFromHeaders } from "@canopy/auth"
import { ContextResolver, type PolicyEngine } from "@canopy/policy"
import {
  CanopyError,
  canonicalString,
  ErrorCode,
  ForbiddenError,
  InvalidQueryError,
  isDocument,
  sha256Hex,
  toCanopyError,
} from "@canopy/protocol"
import type { QueryLimits } from "@canopy/query"
import type { MongoClient } from "mongodb"
import { mongoContextReader } from "./context-reader.ts"
import { explainRoute } from "./explain-route.ts"
import {
  type CorsOptions,
  type Encoding,
  type Exchange,
  jsonResponse,
  negotiate,
  preferencesOf,
  preflight,
  problemResponse,
  type Route,
  readBody,
  requestIdOf,
  withCors,
} from "./http.ts"
import { type IdType, parseId } from "./ids.ts"
import { buildOpenApi } from "./openapi.ts"
import {
  type FindParams,
  findParamsFromBody,
  findParamsFromQuery,
  type PageLimits,
} from "./params.ts"
import { DEFAULT_PROBLEM_TYPE_BASE, toProblem } from "./problem.ts"
import { type FindRequest, type FindResult, type ReadLimits, ReadPath } from "./read-path.ts"
import { SchemaCache } from "./schema-source.ts"
import { type WriteLimits, WritePath } from "./write-path.ts"
import { writeRoutes } from "./write-routes.ts"

/** Options for {@link createRestHandler}. */
export interface RestHandlerOptions {
  readonly client: MongoClient
  /** The app database. */
  readonly database: string
  /** The policy engine, or a function returning the current one when policies are hot reloaded. */
  readonly policies: PolicyEngine | (() => PolicyEngine)
  /** Verifies the `apikey` and `Authorization` headers. */
  readonly authenticator: Authenticator
  /** The path the API is served under. Defaults to `/rest/v1`. */
  readonly basePath?: string
  /** How the `{id}` segment is read per collection. Collections without an entry use `auto`. */
  readonly idTypes?: Readonly<Record<string, IdType>>
  readonly readLimits?: Partial<ReadLimits>
  readonly writeLimits?: Partial<WriteLimits>
  readonly queryLimits?: QueryLimits
  /** The Canopy meta database, which holds idempotency records. Defaults to `canopy`. */
  readonly metaDatabase?: string
  /** How long idempotency records live. Defaults to 24 hours. */
  readonly mutationTtlSeconds?: number
  /** The largest request body. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number
  /** The prefix of Problem Details `type` URIs. Defaults to `urn:canopy:error:`. */
  readonly problemTypeBase?: string
  /** Cross origin settings. Without them no CORS headers are sent. */
  readonly cors?: CorsOptions
  /**
   * The schemas the OpenAPI document describes. Defaults to a cache that reads validators and samples
   * documents of the app database.
   */
  readonly schemas?: SchemaCache
  /** The `info` of the OpenAPI document. */
  readonly openapi?: { readonly title?: string; readonly version?: string }
  /**
   * Resolves context lookups (`$ctx`). Share the realtime engine's resolver (`realtime.contexts`) so
   * membership changes seen on its change stream reach REST at once. Defaults to a resolver of its own
   * that reads the app database; without a change stream, its results only expire after their `ttl`.
   */
  readonly contexts?: ContextResolver
  /** Called with every error that becomes a `5xx` response, for logging. */
  readonly onError?: (error: unknown, request: Request) => void
}

/** A Data API handler built on the Web `Request` and `Response` types. */
export interface RestHandler {
  /**
   * Serves one request. Pass it to `Bun.serve({ fetch })`, `Deno.serve`, a Hono route
   * (`app.all('/rest/v1/*', (c) => rest.fetch(c.req.raw))`) or {@link toNodeListener} for `node:http` and
   * Express. Never rejects: failures become Problem Details responses.
   */
  fetch(request: Request): Promise<Response>
  /** The read path, for embedding without HTTP. */
  readonly reads: ReadPath
  /** The write path, shared with realtime mutations when both are embedded. */
  readonly writes: WritePath
}

const DEFAULT_BODY_BYTES = 1024 * 1024

/** Creates the REST handler of the Data API. */
export function createRestHandler(options: RestHandlerOptions): RestHandler {
  const basePath = (options.basePath ?? "/rest/v1").replace(/\/+$/, "")
  const reads = new ReadPath({
    client: options.client,
    database: options.database,
    policies: options.policies,
    ...(options.readLimits === undefined ? {} : { limits: options.readLimits }),
    ...(options.queryLimits === undefined ? {} : { queryLimits: options.queryLimits }),
  })
  const writes = new WritePath({
    client: options.client,
    database: options.database,
    policies: options.policies,
    ...(options.metaDatabase === undefined ? {} : { metaDatabase: options.metaDatabase }),
    ...(options.writeLimits === undefined ? {} : { limits: options.writeLimits }),
    ...(options.queryLimits === undefined ? {} : { queryLimits: options.queryLimits }),
    ...(options.mutationTtlSeconds === undefined
      ? {}
      : { mutationTtlSeconds: options.mutationTtlSeconds }),
  })
  const engine =
    typeof options.policies === "function"
      ? options.policies
      : () => options.policies as PolicyEngine
  const contexts =
    options.contexts ??
    new ContextResolver({ reader: mongoContextReader(options.client.db(options.database)) })
  const schemaCache = options.schemas ?? new SchemaCache(options.client.db(options.database))
  const documents = new Map<string, Record<string, unknown>>()
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES
  const typeBase = options.problemTypeBase ?? DEFAULT_PROBLEM_TYPE_BASE
  const idTypes = options.idTypes ?? {}
  const pageLimits: PageLimits = {
    maxLimit: reads.readLimits.maxLimit,
    maxSkip: reads.readLimits.maxSkip,
  }

  const write = writeRoutes({
    writes,
    basePath,
    idTypes,
    maxBodyBytes,
    problemTypeBase: typeBase,
    requestId: (exchange) => exchange.requestId,
  })

  const body = async (exchange: Exchange): Promise<unknown> =>
    (await readBody(exchange.request, maxBodyBytes))?.value

  const pageBody = (result: FindResult) => ({
    data: result.docs,
    page: {
      limit: result.limit,
      next: result.next,
      ...(result.total === undefined ? {} : { total: result.total }),
    },
  })

  const page = (result: FindResult, encoding: Encoding): Response =>
    jsonResponse({ ...pageBody(result), ct: result.ct }, encoding)

  /**
   * A page with a validator over its content (not its cluster time), so a poller that sends
   * `If-None-Match` gets `304` while the result is unchanged.
   */
  const conditionalPage = (result: FindResult, exchange: Exchange): Response => {
    const body = pageBody(result)
    const tag = `W/"${sha256Hex(`${exchange.encoding}:${canonicalString(body)}`).slice(0, 32)}"`
    const headers = { etag: tag, "x-canopy-ct": result.ct }
    const match = exchange.request.headers.get("if-none-match")
    if (match?.split(",").some((value) => value.trim() === tag) === true)
      return new Response(null, { status: 304, headers })
    return jsonResponse({ ...body, ct: result.ct }, exchange.encoding, 200, headers)
  }

  const listCollections: Route = async ({ caller, request, encoding }) =>
    jsonResponse({ data: await reads.collections(caller, { signal: request.signal }) }, encoding)

  const find: Route = async (exchange) => {
    const { caller, request, url, segments, prefer } = exchange
    const params = findParamsFromQuery(url.searchParams, pageLimits, prefer.count)
    for (const name of ["where", "upsert"]) {
      if (url.searchParams.has(name)) throw new InvalidQueryError(`${name} only applies to writes`)
    }
    return conditionalPage(
      await reads.find(caller, findRequest(segments[0] ?? "", params), {
        signal: request.signal,
      }),
      exchange,
    )
  }

  const query: Route = async (exchange) => {
    const params = findParamsFromBody(
      (await body(exchange)) ?? {},
      pageLimits,
      exchange.prefer.count,
    )
    return page(
      await reads.find(exchange.caller, findRequest(exchange.segments[0] ?? "", params), {
        signal: exchange.request.signal,
      }),
      exchange.encoding,
    )
  }

  const count: Route = async (exchange) => {
    const input = (await body(exchange)) ?? {}
    if (!isDocument(input)) throw new InvalidQueryError("The count body must be a document")
    for (const key of Object.keys(input)) {
      if (key !== "filter") throw new InvalidQueryError(`Unknown count field ${key}`)
    }
    const result = await reads.count(
      exchange.caller,
      exchange.segments[0] ?? "",
      input["filter"] ?? {},
      exchange.prefer.count ?? "exact",
      { signal: exchange.request.signal },
    )
    return jsonResponse(
      { data: { count: result.count, exact: result.exact }, ct: result.ct },
      exchange.encoding,
    )
  }

  const distinct: Route = async (exchange) => {
    const input = await body(exchange)
    if (!isDocument(input)) throw new InvalidQueryError("The distinct body must be a document")
    for (const key of Object.keys(input)) {
      if (key !== "field" && key !== "filter")
        throw new InvalidQueryError(`Unknown distinct field ${key}`)
    }
    const result = await reads.distinct(
      exchange.caller,
      exchange.segments[0] ?? "",
      input["field"],
      input["filter"] ?? {},
      { signal: exchange.request.signal },
    )
    return jsonResponse({ data: result.values, ct: result.ct }, exchange.encoding)
  }

  const findOne: Route = async ({ caller, request, url, segments, encoding }) => {
    const collection = segments[0] ?? ""
    for (const name of url.searchParams.keys()) {
      if (name !== "fields") throw new InvalidQueryError(`Unknown parameter ${name}`)
    }
    const fieldsText = url.searchParams.get("fields")
    const fields =
      fieldsText === null
        ? undefined
        : findParamsFromQuery(new URLSearchParams({ fields: fieldsText }), pageLimits, undefined)
            .fields
    const id = parseId(segments[1] ?? "", idTypes[collection] ?? "auto")
    const result = await reads.findById(caller, collection, id, fields, { signal: request.signal })
    if (result.doc === null) throw new CanopyError(ErrorCode.NotFound, "Document not found")
    return jsonResponse({ data: result.doc, ct: result.ct }, encoding)
  }

  const aggregate: Route = async (exchange) => {
    const input = await body(exchange)
    if (!isDocument(input)) throw new InvalidQueryError("The aggregate body must be a document")
    for (const key of Object.keys(input)) {
      if (key !== "pipeline") throw new InvalidQueryError(`Unknown aggregate field ${key}`)
    }
    const result = await reads.aggregate(
      exchange.caller,
      exchange.segments[0] ?? "",
      input["pipeline"],
      { signal: exchange.request.signal },
    )
    return jsonResponse({ data: result.docs, ct: result.ct }, exchange.encoding)
  }

  const openapi: Route = async ({ caller, request, url, encoding }) => {
    if ([...url.searchParams.keys()].length > 0)
      throw new InvalidQueryError("openapi.json takes no parameters")
    const current = engine()
    const names = (await reads.collections(caller, { signal: request.signal })).map(
      (info) => info.name,
    )
    const schemas = await schemaCache.all(names)
    const key = `${current.version}\u0000${schemaCache.version}\u0000${[...caller.context.roles].sort().join(",")}\u0000${names.join(",")}`
    let document = documents.get(key)
    if (document === undefined) {
      document = buildOpenApi({
        engine: current,
        ctx: caller.context,
        schemas,
        collections: names,
        basePath,
        ...(options.openapi?.title === undefined ? {} : { title: options.openapi.title }),
        ...(options.openapi?.version === undefined ? {} : { version: options.openapi.version }),
      })
      if (documents.size >= 64) documents.clear()
      documents.set(key, document)
    }
    return jsonResponse(document, encoding)
  }

  const actions: Readonly<Record<string, Route>> = {
    _query: query,
    _count: count,
    _distinct: distinct,
    _aggregate: aggregate,
    _explain: explainRoute({ engine, contexts, reads, body }),
  }

  /** Picks the route of a path and method, or the methods the path allows. */
  const resolve = (
    segments: readonly string[],
    method: string,
  ): { readonly route?: Route; readonly allow: readonly string[] } => {
    const [first, second] = segments
    const action =
      second !== undefined && Object.hasOwn(actions, second) ? actions[second] : undefined
    const table: Readonly<Record<string, Route>> =
      segments.length === 0
        ? { GET: listCollections }
        : segments.length === 1 && first === "_batch"
          ? { POST: write.batch }
          : segments.length === 1 && first === "openapi.json"
            ? { GET: openapi }
            : segments.length === 1
              ? { GET: find, POST: write.insert, PATCH: write.updateMany, DELETE: write.deleteMany }
              : segments.length === 2 && action !== undefined
                ? { POST: action }
                : segments.length === 2
                  ? { GET: findOne, PATCH: write.update, PUT: write.replace, DELETE: write.remove }
                  : {}
    const route = Object.hasOwn(table, method) ? table[method] : undefined
    return { ...(route === undefined ? {} : { route }), allow: Object.keys(table) }
  }

  const serve = async (request: Request, requestId: string): Promise<Response> => {
    const url = new URL(request.url)
    const instance = url.pathname
    const encoding = negotiate(request.headers.get("accept"))
    try {
      const segments = segmentsOf(url.pathname, basePath)
      if (segments === undefined) throw new CanopyError(ErrorCode.NotFound, "Not found")
      const { route, allow } = resolve(segments, request.method)
      if (request.method === "OPTIONS" && allow.length > 0) {
        const methods = [...allow, "OPTIONS"].join(", ")
        if (options.cors !== undefined) return preflight(options.cors, request, methods)
        return new Response(null, { status: 204, headers: { allow: methods } })
      }
      if (allow.length === 0) throw new CanopyError(ErrorCode.NotFound, "Not found")
      if (route === undefined) {
        const response = problemResponse(
          {
            ...toProblem(
              new InvalidQueryError(`${request.method} is not allowed here`),
              instance,
              requestId,
              typeBase,
            ),
            status: 405,
          },
          undefined,
        )
        response.headers.set("allow", allow.join(", "))
        return response
      }
      const credentials = credentialsFromHeaders(request.headers)
      const principal = await options.authenticator.authenticate(credentials.key, credentials.token)
      if (principal.readOnly === true)
        throw new ForbiddenError("A view token only follows data over realtime")
      const current = engine()
      const names = current.contextNames(lookupScope(segments), principal.context.roles)
      const context =
        names.length === 0
          ? principal.context
          : {
              ...principal.context,
              ctx: (await contexts.resolve(current.set.contexts, names, principal.context)).ctx,
            }
      return await route({
        request,
        url,
        segments,
        encoding,
        prefer: preferencesOf(request.headers),
        caller: { context, subject: principal.subject },
        requestId,
      })
    } catch (error: unknown) {
      const canopy = toCanopyError(error)
      if (canopy.status >= 500) options.onError?.(error, request)
      const retry = canopy.details?.["retryAfterSeconds"]
      return problemResponse(
        toProblem(canopy, instance, requestId, typeBase),
        typeof retry === "number" ? retry : undefined,
      )
    }
  }

  return {
    reads,
    writes,
    async fetch(request: Request): Promise<Response> {
      const requestId = requestIdOf(request.headers)
      let response: Response
      try {
        response = await serve(request, requestId)
      } catch (error: unknown) {
        options.onError?.(error, request)
        response = new Response(null, { status: 500 })
      }
      response.headers.set("x-request-id", requestId)
      return withCors(response, options.cors, request.headers.get("origin"))
    },
  }
}

/**
 * The collections whose context lookups a request may need: the addressed collection, or every collection
 * for batches and aggregations, which can reach several. Requests that evaluate no policy need none.
 */
function lookupScope(segments: readonly string[]): string[] | undefined {
  const [first, second] = segments
  if (first === undefined || first === "openapi.json") return []
  if (first === "_batch" || second === "_aggregate") return undefined
  return [first]
}

/**
 * Splits the path below `basePath` into decoded segments, or returns `undefined` when the path is outside
 * it. A trailing slash is ignored.
 */
export function segmentsOf(pathname: string, basePath: string): string[] | undefined {
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return undefined
  const rest = pathname.slice(basePath.length).replace(/^\/+/, "").replace(/\/+$/, "")
  if (rest === "") return []
  return rest.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch (error: unknown) {
      throw new InvalidQueryError("The path is not validly percent encoded", { cause: error })
    }
  })
}

function findRequest(collection: string, params: FindParams): FindRequest {
  return {
    collection,
    filter: params.filter,
    ...(params.sort === undefined ? {} : { sort: params.sort }),
    ...(params.fields === undefined ? {} : { fields: params.fields }),
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.skip === undefined ? {} : { skip: params.skip }),
    ...(params.after === undefined ? {} : { after: params.after }),
    ...(params.count === undefined ? {} : { count: params.count }),
  }
}
