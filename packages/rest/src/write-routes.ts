import {
  CanopyError,
  ErrorCode,
  InvalidQueryError,
  isDocument,
  objectIdHex,
  toCanonical,
  toCanopyError,
} from "@canopy/protocol"
import { type Exchange, jsonResponse, type Route, readBody } from "./http.ts"
import { type IdType, parseId } from "./ids.ts"
import { MERGE_PATCH_MEDIA_TYPE, mergePatchToUpdate } from "./merge-patch.ts"
import { combineFilters, parseEjsonParam, RESERVED_PARAMS, shorthandFilter } from "./params.ts"
import { type Problem, toProblem } from "./problem.ts"
import type { BatchOperationResult, WritePath, WriteRequest, WriteResult } from "./write-path.ts"

/** What the write routes need from the handler. */
export interface WriteRouteOptions {
  readonly writes: WritePath
  readonly basePath: string
  readonly idTypes: Readonly<Record<string, IdType>>
  readonly maxBodyBytes: number
  readonly problemTypeBase: string
  readonly requestId: (exchange: Exchange) => string
}

/** The write routes of the Data API. */
export interface WriteRoutes {
  readonly insert: Route
  readonly update: Route
  readonly replace: Route
  readonly remove: Route
  readonly updateMany: Route
  readonly deleteMany: Route
  readonly batch: Route
}

const JSON_BODY = new Set(["application/json", "application/ejson"])
const PATCH_BODY = new Set([...JSON_BODY, MERGE_PATCH_MEDIA_TYPE])
const BATCH_KEYS = new Set(["atomic", "ops"])
const OP_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  insert: new Set(["op", "c", "doc", "mid"]),
  insertMany: new Set(["op", "c", "docs", "mid"]),
  update: new Set(["op", "c", "id", "update", "where", "mid"]),
  replace: new Set(["op", "c", "id", "doc", "where", "upsert", "mid"]),
  delete: new Set(["op", "c", "id", "where", "mid"]),
  updateMany: new Set(["op", "c", "filter", "update", "mid"]),
  deleteMany: new Set(["op", "c", "filter", "mid"]),
}

/** Builds the write routes. Every write goes through the transactional write path. */
export function writeRoutes(options: WriteRouteOptions): WriteRoutes {
  const { writes } = options

  const required = async (
    exchange: Exchange,
    accepted: ReadonlySet<string> = JSON_BODY,
  ): Promise<{ readonly value: unknown; readonly mediaType: string }> => {
    const body = await readBody(exchange.request, options.maxBodyBytes, accepted)
    if (body === undefined) throw new InvalidQueryError("The request needs a body")
    return body
  }

  const mutationIdOf = (exchange: Exchange): { mutationId?: string; signal: AbortSignal } => {
    const key = exchange.request.headers.get("idempotency-key")
    return {
      signal: exchange.request.signal,
      ...(key === null ? {} : { mutationId: key }),
    }
  }

  const allowOnly = (exchange: Exchange, names: readonly string[]): void => {
    for (const name of exchange.url.searchParams.keys()) {
      if (!names.includes(name)) throw new InvalidQueryError(`Unknown parameter ${name}`)
    }
  }

  const whereOf = (exchange: Exchange): unknown => {
    const values = exchange.url.searchParams.getAll("where")
    if (values.length > 1) throw new InvalidQueryError("where may only be given once")
    const [text] = values
    return text === undefined ? undefined : parseEjsonParam("where", text)
  }

  const idOf = (exchange: Exchange): unknown => {
    const collection = exchange.segments[0] ?? ""
    return parseId(exchange.segments[1] ?? "", options.idTypes[collection] ?? "auto")
  }

  const written = (
    exchange: Exchange,
    result: WriteResult,
    body: Record<string, unknown>,
    status = 200,
    headers: Record<string, string> = {},
  ): Response => {
    const all = { "x-canopy-ct": result.ct, ...headers }
    if (exchange.prefer.return === "minimal")
      return new Response(null, { status: 204, headers: all })
    return jsonResponse(
      { ...body, ct: result.ct, replayed: result.replayed },
      exchange.encoding,
      status,
      all,
    )
  }

  const notFound = (): CanopyError => new CanopyError(ErrorCode.NotFound, "Document not found")

  const location = (collection: string, id: unknown): string => {
    const type = options.idTypes[collection] ?? "auto"
    const hex = objectIdHex(id)
    let segment: string
    if (hex !== undefined && (type === "auto" || type === "objectId")) segment = hex
    else if (typeof id === "string" && (type === "string" || !/^[0-9a-f]{24}$/i.test(id)))
      segment = id
    else if (typeof id === "number" && type === "number") segment = String(id)
    else segment = JSON.stringify(toCanonical(id))
    return `${options.basePath}/${encodeURIComponent(collection)}/${encodeURIComponent(segment)}`
  }

  const insert: Route = async (exchange) => {
    allowOnly(exchange, [])
    const collection = exchange.segments[0] ?? ""
    const { value } = await required(exchange)
    if (Array.isArray(value)) {
      const result = await writes.execute(
        exchange.caller,
        { op: "insertMany", collection, docs: value },
        mutationIdOf(exchange),
      )
      return written(
        exchange,
        result,
        { data: result.documents ?? null, ids: result.insertedIds },
        201,
      )
    }
    const result = await writes.execute(
      exchange.caller,
      { op: "insert", collection, doc: value },
      mutationIdOf(exchange),
    )
    const [id] = result.insertedIds
    return written(exchange, result, { data: result.documents?.[0] ?? null }, 201, {
      location: location(collection, id),
    })
  }

  const update: Route = async (exchange) => {
    allowOnly(exchange, ["where"])
    const { value, mediaType } = await required(exchange, PATCH_BODY)
    const where = whereOf(exchange)
    const result = await writes.execute(
      exchange.caller,
      {
        op: "update",
        collection: exchange.segments[0] ?? "",
        id: idOf(exchange),
        update: mediaType === MERGE_PATCH_MEDIA_TYPE ? mergePatchToUpdate(value) : value,
        ...(where === undefined ? {} : { where }),
      },
      mutationIdOf(exchange),
    )
    if (result.matched === 0) throw notFound()
    return written(exchange, result, { data: result.documents?.[0] ?? null })
  }

  const replace: Route = async (exchange) => {
    allowOnly(exchange, ["where", "upsert"])
    const upsertText = exchange.url.searchParams.get("upsert")
    if (upsertText !== null && upsertText !== "true" && upsertText !== "false")
      throw new InvalidQueryError("upsert must be true or false")
    const { value } = await required(exchange)
    const where = whereOf(exchange)
    const result = await writes.execute(
      exchange.caller,
      {
        op: "replace",
        collection: exchange.segments[0] ?? "",
        id: idOf(exchange),
        doc: value,
        upsert: upsertText === "true",
        ...(where === undefined ? {} : { where }),
      },
      mutationIdOf(exchange),
    )
    if (result.upsertedId !== undefined)
      return written(exchange, result, { data: result.documents?.[0] ?? null }, 201)
    if (result.matched === 0) throw notFound()
    return written(exchange, result, { data: result.documents?.[0] ?? null })
  }

  const remove: Route = async (exchange) => {
    allowOnly(exchange, ["where"])
    const where = whereOf(exchange)
    const result = await writes.execute(
      exchange.caller,
      {
        op: "delete",
        collection: exchange.segments[0] ?? "",
        id: idOf(exchange),
        ...(where === undefined ? {} : { where }),
      },
      mutationIdOf(exchange),
    )
    if (result.deleted === 0) throw notFound()
    return written(exchange, result, { data: result.documents?.[0] ?? null })
  }

  const bulkFilter = (exchange: Exchange): Record<string, unknown> => {
    if (exchange.prefer.bulk !== true)
      throw new InvalidQueryError("Writes to many documents need the header Prefer: bulk=true")
    const params = exchange.url.searchParams
    for (const name of RESERVED_PARAMS) {
      if (name !== "filter" && params.has(name))
        throw new InvalidQueryError(`${name} does not apply to bulk writes`)
    }
    const texts = params.getAll("filter")
    if (texts.length > 1) throw new InvalidQueryError("filter may only be given once")
    const explicit = texts[0] === undefined ? {} : parseEjsonParam("filter", texts[0])
    if (!isDocument(explicit)) throw new InvalidQueryError("filter must be a document")
    const filter = combineFilters(explicit, shorthandFilter(params))
    if (Object.keys(filter).length === 0) throw new InvalidQueryError("A bulk write needs a filter")
    return filter
  }

  const updateMany: Route = async (exchange) => {
    const filter = bulkFilter(exchange)
    const { value, mediaType } = await required(exchange, PATCH_BODY)
    const result = await writes.execute(
      exchange.caller,
      {
        op: "updateMany",
        collection: exchange.segments[0] ?? "",
        filter,
        update: mediaType === MERGE_PATCH_MEDIA_TYPE ? mergePatchToUpdate(value) : value,
        bulk: true,
      },
      mutationIdOf(exchange),
    )
    return written(exchange, result, {
      data: { matched: result.matched, modified: result.modified },
    })
  }

  const deleteMany: Route = async (exchange) => {
    const filter = bulkFilter(exchange)
    const result = await writes.execute(
      exchange.caller,
      { op: "deleteMany", collection: exchange.segments[0] ?? "", filter, bulk: true },
      mutationIdOf(exchange),
    )
    return written(exchange, result, { data: { deleted: result.deleted } })
  }

  const batch: Route = async (exchange) => {
    allowOnly(exchange, [])
    const { value } = await required(exchange)
    if (!isDocument(value)) throw new InvalidQueryError("A batch must be a document")
    for (const key of Object.keys(value)) {
      if (!BATCH_KEYS.has(key)) throw new InvalidQueryError(`Unknown batch field ${key}`)
    }
    const atomic = value["atomic"] ?? false
    if (typeof atomic !== "boolean") throw new InvalidQueryError("atomic must be a boolean")
    const ops = value["ops"]
    if (!Array.isArray(ops)) throw new InvalidQueryError("ops must be an array")
    const bulk = exchange.prefer.bulk === true
    if (atomic) {
      const requests = ops.map((op, index) => batchRequest(op, index, bulk))
      for (const [index, op] of ops.entries()) {
        if (isDocument(op) && op["mid"] !== undefined)
          throw new InvalidQueryError(
            `Operation ${index}: an atomic batch takes its idempotency key from the Idempotency-Key header`,
          )
      }
      const result = await writes.executeBatch(
        exchange.caller,
        requests.map((entry) => entry.request),
        mutationIdOf(exchange),
      )
      const headers = { "x-canopy-ct": result.ct }
      if (exchange.prefer.return === "minimal") return new Response(null, { status: 204, headers })
      return jsonResponse(
        {
          data: result.results.map((entry, index) =>
            operationBody(requests[index]?.request.op, entry),
          ),
          ct: result.ct,
          replayed: result.replayed,
        },
        exchange.encoding,
        200,
        headers,
      )
    }
    if (ops.length === 0) throw new InvalidQueryError("A batch needs at least one operation")
    if (ops.length > writes.writeLimits.maxBatch)
      throw new CanopyError(
        ErrorCode.BulkLimit,
        `A batch may not have more than ${writes.writeLimits.maxBatch} operations`,
      )
    const results: Record<string, unknown>[] = []
    for (const [index, op] of ops.entries()) {
      try {
        const { request, mid } = batchRequest(op, index, bulk)
        const result = await writes.execute(exchange.caller, request, {
          signal: exchange.request.signal,
          ...(mid === undefined ? {} : { mutationId: mid }),
        })
        results.push({
          status: 200,
          ...operationBody(request.op, result),
          ct: result.ct,
          replayed: result.replayed,
        })
      } catch (error: unknown) {
        const canopy = toCanopyError(error)
        const problem: Problem = toProblem(
          canopy,
          exchange.url.pathname,
          options.requestId(exchange),
          options.problemTypeBase,
        )
        results.push({ status: problem.status, error: problem })
      }
    }
    return jsonResponse({ data: results }, exchange.encoding)
  }

  return { insert, update, replace, remove, updateMany, deleteMany, batch }
}

/** The body of one batch operation's result. */
function operationBody(
  op: WriteRequest["op"] | undefined,
  result: BatchOperationResult,
): Record<string, unknown> {
  switch (op) {
    case "insertMany":
      return { data: result.documents ?? null, ids: result.insertedIds }
    case "updateMany":
      return { data: { matched: result.matched, modified: result.modified } }
    case "deleteMany":
      return { data: { deleted: result.deleted } }
    default:
      return {
        data: result.documents?.[0] ?? null,
        matched: result.matched,
        ...(result.upsertedId === undefined ? {} : { upserted: true }),
      }
  }
}

/** Reads one operation of a `_batch` body. Bulk operations need `Prefer: bulk=true` on the request. */
function batchRequest(
  input: unknown,
  index: number,
  bulk: boolean,
): { readonly request: WriteRequest; readonly mid: string | undefined } {
  const fail = (message: string): never => {
    throw new InvalidQueryError(`Operation ${index}: ${message}`, { details: { index } })
  }
  if (!isDocument(input)) return fail("must be a document")
  const op = input["op"]
  const allowed = typeof op === "string" && Object.hasOwn(OP_KEYS, op) ? OP_KEYS[op] : undefined
  if (allowed === undefined) return fail(`op must be one of ${Object.keys(OP_KEYS).join(", ")}`)
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`unknown field ${key}`)
  }
  const collection = input["c"]
  if (typeof collection !== "string") return fail("c must be a collection name")
  const mid = input["mid"]
  if (mid !== undefined && typeof mid !== "string") return fail("mid must be a string")
  const where = input["where"] === undefined ? {} : { where: input["where"] }
  let request: WriteRequest
  switch (op) {
    case "insert":
      request = { op, collection, doc: input["doc"] }
      break
    case "insertMany":
      request = { op, collection, docs: input["docs"] }
      break
    case "update":
      request = { op, collection, id: input["id"], update: input["update"], ...where }
      break
    case "replace": {
      const upsert = input["upsert"]
      if (upsert !== undefined && typeof upsert !== "boolean")
        return fail("upsert must be a boolean")
      request = {
        op,
        collection,
        id: input["id"],
        doc: input["doc"],
        ...where,
        ...(upsert === undefined ? {} : { upsert }),
      }
      break
    }
    case "delete":
      request = { op, collection, id: input["id"], ...where }
      break
    case "updateMany":
    case "deleteMany": {
      if (!bulk) return fail("writes to many documents need the header Prefer: bulk=true")
      const filter = input["filter"]
      if (!isDocument(filter) || Object.keys(filter).length === 0)
        return fail("a bulk write needs a filter")
      request =
        op === "updateMany"
          ? { op, collection, filter, update: input["update"], bulk: true }
          : { op, collection, filter, bulk: true }
      break
    }
    default:
      return fail("unknown op")
  }
  if ((op === "update" || op === "replace" || op === "delete") && input["id"] === undefined)
    fail("id is required")
  return { request, mid }
}
