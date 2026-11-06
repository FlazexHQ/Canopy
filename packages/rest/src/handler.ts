import { type Authenticator, credentialsFromHeaders } from "@canopy/auth"
import type { PolicyEngine } from "@canopy/policy"
import {
  CanopyError,
  ErrorCode,
  InvalidQueryError,
  isDocument,
  toCanopyError,
} from "@canopy/protocol"
import type { QueryLimits } from "@canopy/query"
import type { MongoClient } from "mongodb"
import {
  type CorsOptions,
  type Encoding,
  jsonResponse,
  negotiate,
  type Preferences,
  preferencesOf,
  preflight,
  problemResponse,
  readBody,
  requestIdOf,
  withCors,
} from "./http.ts"
import { type IdType, parseId } from "./ids.ts"
import {
  type FindParams,
  findParamsFromBody,
  findParamsFromQuery,
  type PageLimits,
} from "./params.ts"
import { DEFAULT_PROBLEM_TYPE_BASE, toProblem } from "./problem.ts"
import { type FindRequest, type FindResult, type ReadLimits, ReadPath } from "./read-path.ts"
import type { Caller } from "./write-path.ts"

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
  readonly queryLimits?: QueryLimits
  /** The largest request body. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number
  /** The prefix of Problem Details `type` URIs. Defaults to `urn:canopy:error:`. */
  readonly problemTypeBase?: string
  /** Cross origin settings. Without them no CORS headers are sent. */
  readonly cors?: CorsOptions
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
}

const DEFAULT_BODY_BYTES = 1024 * 1024

interface Exchange {
  readonly request: Request
  readonly url: URL
  readonly segments: readonly string[]
  readonly encoding: Encoding
  readonly prefer: Preferences
  readonly caller: Caller
}

type Route = (exchange: Exchange) => Promise<Response>

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
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES
  const typeBase = options.problemTypeBase ?? DEFAULT_PROBLEM_TYPE_BASE
  const idTypes = options.idTypes ?? {}
  const pageLimits: PageLimits = {
    maxLimit: reads.readLimits.maxLimit,
    maxSkip: reads.readLimits.maxSkip,
  }

  const body = async (exchange: Exchange): Promise<unknown> =>
    (await readBody(exchange.request, maxBodyBytes))?.value

  const page = (result: FindResult, encoding: Encoding): Response =>
    jsonResponse(
      {
        data: result.docs,
        page: {
          limit: result.limit,
          next: result.next,
          ...(result.total === undefined ? {} : { total: result.total }),
        },
        ct: result.ct,
      },
      encoding,
    )

  const listCollections: Route = async ({ caller, request, encoding }) =>
    jsonResponse({ data: await reads.collections(caller, { signal: request.signal }) }, encoding)

  const find: Route = async ({ caller, request, url, segments, encoding, prefer }) => {
    const params = findParamsFromQuery(url.searchParams, pageLimits, prefer.count)
    for (const name of ["where", "upsert"]) {
      if (url.searchParams.has(name)) throw new InvalidQueryError(`${name} only applies to writes`)
    }
    return page(
      await reads.find(caller, findRequest(segments[0] ?? "", params), {
        signal: request.signal,
      }),
      encoding,
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

  /** Picks the route of a path and method, or the methods the path allows. */
  const resolve = (
    segments: readonly string[],
    method: string,
  ): { readonly route?: Route; readonly allow: readonly string[] } => {
    const table: Readonly<Record<string, Route>> =
      segments.length === 0
        ? { GET: listCollections }
        : segments.length === 1
          ? { GET: find }
          : segments.length === 2 && segments[1] === "_query"
            ? { POST: query }
            : segments.length === 2 && segments[1] === "_count"
              ? { POST: count }
              : segments.length === 2 && segments[1] === "_distinct"
                ? { POST: distinct }
                : segments.length === 2
                  ? { GET: findOne }
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
      return await route({
        request,
        url,
        segments,
        encoding,
        prefer: preferencesOf(request.headers),
        caller: { context: principal.context, subject: principal.subject },
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
