import { type Authenticator, type RateLimits, rateLimitError } from "@canopy/auth"
import { type ContextResolver, type PolicyEngine, Role, STORAGE_COLLECTION } from "@canopy/policy"
import {
  CanopyError,
  ErrorCode,
  InvalidQueryError,
  isDocument,
  NotFoundError,
  toCanopyError,
} from "@canopy/protocol"
import {
  type Caller,
  type CorsOptions,
  DEFAULT_PROBLEM_TYPE_BASE,
  preflight,
  problemResponse,
  readBody,
  requestCaller,
  requestIdOf,
  segmentsOf,
  toProblem,
  withCors,
} from "@canopy/rest"
import type { OpenedObject, RangeRequest, Storage } from "./storage.ts"

/** Options of {@link createStorageHandler}. */
export interface StorageHandlerOptions {
  readonly storage: Storage
  readonly authenticator: Authenticator
  readonly policies: () => PolicyEngine
  readonly contexts: ContextResolver
  /** The path the API is served under. @default "/storage/v1" */
  readonly basePath?: string
  readonly cors?: CorsOptions
  readonly rateLimits?: RateLimits
  readonly onRateLimited?: () => void
  readonly onError?: (error: unknown, request: Request) => void
}

/** The storage API as a Web standard fetch handler. */
export interface StorageHandler {
  readonly path: string
  /** `info.ip` is the peer address, for the rate limits. */
  fetch(request: Request, info?: { readonly ip?: string }): Promise<Response>
}

const ALLOWED_HEADERS =
  "apikey, authorization, content-type, range, if-none-match, x-upsert, x-metadata, x-request-id"
const EXPOSED_HEADERS =
  "x-request-id, etag, content-range, accept-ranges, content-length, content-disposition, retry-after"
/** Files are served as data: they cannot run scripts or load anything, even as HTML or SVG. */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
const JSON_BODY = 64 * 1024

/** Parses a single `bytes=` range; other forms (several ranges, other units) are ignored, as HTTP allows. */
function rangeOf(header: string | null): RangeRequest | undefined {
  if (header === null) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, from = "", to = ""] = match
  if (from === "" && to === "") return undefined
  if (from === "") return { suffix: Number(to) }
  return to === "" ? { start: Number(from) } : { start: Number(from), end: Number(to) }
}

async function bytesOf(request: Request, max: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length")
  const tooLarge = () =>
    new CanopyError(ErrorCode.PayloadTooLarge, `The file may not exceed ${max} bytes`)
  if (declared !== null && Number(declared) > max) throw tooLarge()
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await readBody(request, JSON_BODY)
  if (body === undefined) return {}
  if (!isDocument(body.value)) throw new InvalidQueryError("The body must be a JSON object")
  return body.value
}

function metadataOf(header: string | null): Record<string, unknown> | undefined {
  if (header === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(header)
  } catch (error: unknown) {
    throw new InvalidQueryError("x-metadata must be a JSON object", { cause: error })
  }
  if (!isDocument(parsed)) throw new InvalidQueryError("x-metadata must be a JSON object")
  return parsed
}

/** A response for a file: its type, length, etag and range, as an attachment when asked. */
function fileResponse(
  request: Request,
  opened: OpenedObject,
  cache: string,
  download: string | null,
): Response {
  const { object, range, body } = opened
  const etag = `"${object.etag}"`
  const headers: Record<string, string> = {
    "content-type": object.contentType,
    etag,
    "accept-ranges": "bytes",
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "content-security-policy": FILE_CSP,
    "content-length": String(range === undefined ? object.size : range.end - range.start + 1),
  }
  if (range !== undefined)
    headers["content-range"] = `bytes ${range.start}-${range.end}/${object.size}`
  if (download !== null) {
    const name = download === "" ? (object.path.split("/").at(-1) ?? "file") : download
    headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  }
  if (request.headers.get("if-none-match") === etag || request.method === "HEAD") {
    void body.cancel().catch(() => {})
    if (request.method !== "HEAD") return new Response(null, { status: 304, headers: { etag } })
    return new Response(null, { status: range === undefined ? 200 : 206, headers })
  }
  return new Response(body, { status: range === undefined ? 200 : 206, headers })
}

interface Exchange {
  readonly request: Request
  readonly url: URL
  readonly segments: readonly string[]
  readonly peer: string | undefined
}

/**
 * Serves the storage API: `object/<bucket>/<path>` (upload with POST, replace with PUT, read with GET or HEAD,
 * delete), `list/<bucket>`, `sign/<bucket>/<path>`, `signed/<bucket>/<path>?token=`,
 * `public/<bucket>/<path>`, and resumable uploads (`POST upload/<bucket>/<path>`, then `uploads/<id>`).
 * Authentication, rate limits, CORS and problem documents work as in the Data API.
 */
export function createStorageHandler(options: StorageHandlerOptions): StorageHandler {
  const basePath = (options.basePath ?? "/storage/v1").replace(/\/+$/, "")
  const { storage } = options
  const callers = {
    authenticator: options.authenticator,
    policies: options.policies,
    contexts: options.contexts,
    ...(options.rateLimits === undefined ? {} : { rateLimits: options.rateLimits }),
    ...(options.onRateLimited === undefined ? {} : { onRateLimited: options.onRateLimited }),
  }
  const caller = (exchange: Exchange): Promise<Caller> =>
    requestCaller(callers, exchange.request, exchange.peer, [STORAGE_COLLECTION])

  /** Counts a request without credentials (public and signed files) against its client address. */
  const anonymous = (exchange: Exchange): void => {
    const limits = options.rateLimits
    if (limits === undefined) return
    const address = limits.addressOf(exchange.request.headers, exchange.peer)
    if (address === undefined) return
    const wait = limits.request({
      key: "storage:public",
      subject: "anon",
      roles: new Set([Role.Anon]),
      address,
    })
    if (wait > 0) {
      options.onRateLimited?.()
      throw rateLimitError(wait)
    }
  }

  const split = (segments: readonly string[]): { bucket: string; path: string } => {
    const [bucket = "", ...rest] = segments
    if (rest.length === 0) throw new NotFoundError("Not found")
    return { bucket, path: rest.join("/") }
  }

  const route = async (exchange: Exchange): Promise<Response> => {
    const { request, url, segments } = exchange
    const [area, ...rest] = segments
    const method = request.method
    const download = url.searchParams.get("download")
    switch (area) {
      case "object": {
        const { bucket, path } = split(rest)
        if (method === "GET" || method === "HEAD")
          return fileResponse(
            request,
            await storage.open(
              await caller(exchange),
              bucket,
              path,
              rangeOf(request.headers.get("range")),
            ),
            "private, max-age=0",
            download,
          )
        if (method === "POST" || method === "PUT") {
          const who = await caller(exchange)
          const body = await bytesOf(request, storage.bucket(bucket).maxFileSize)
          const metadata = metadataOf(request.headers.get("x-metadata"))
          const object = await storage.upload(who, bucket, path, body, {
            contentType: request.headers.get("content-type") ?? "application/octet-stream",
            upsert: method === "PUT" || request.headers.get("x-upsert") === "true",
            ...(metadata === undefined ? {} : { metadata }),
          })
          return json(object, method === "PUT" ? 200 : 201)
        }
        if (method === "DELETE") {
          await storage.remove(await caller(exchange), bucket, path)
          return new Response(null, { status: 204 })
        }
        break
      }
      case "list": {
        if (method !== "GET" || rest.length !== 1) break
        const limit = url.searchParams.get("limit")
        if (limit !== null && !/^\d{1,4}$/.test(limit))
          throw new InvalidQueryError("limit must be from 1 to 1000")
        const prefix = url.searchParams.get("prefix")
        const after = url.searchParams.get("after")
        return json(
          await storage.list(await caller(exchange), rest[0] ?? "", {
            ...(prefix === null ? {} : { prefix }),
            ...(after === null ? {} : { after }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          }),
        )
      }
      case "sign": {
        if (method !== "POST") break
        const { bucket, path } = split(rest)
        const expiresIn = (await jsonBody(request))["expiresIn"]
        const signed = await storage.sign(
          await caller(exchange),
          bucket,
          path,
          typeof expiresIn === "number" ? expiresIn : Number.NaN,
        )
        const target = new URL(
          `${basePath}/signed/${[bucket, ...path.split("/")].map(encodeURIComponent).join("/")}`,
          url,
        )
        target.searchParams.set("token", signed.token)
        return json({ url: `${target.pathname}${target.search}`, expiresAt: signed.expiresAt })
      }
      case "signed":
      case "public": {
        if (method !== "GET" && method !== "HEAD") break
        anonymous(exchange)
        const { bucket, path } = split(rest)
        const range = rangeOf(request.headers.get("range"))
        if (area === "public")
          return fileResponse(
            request,
            await storage.openPublic(bucket, path, range),
            "public, max-age=3600",
            download,
          )
        return fileResponse(
          request,
          await storage.openSigned(url.searchParams.get("token") ?? "", bucket, path, range),
          "private, max-age=0",
          download,
        )
      }
      case "upload": {
        if (method !== "POST") break
        const { bucket, path } = split(rest)
        const body = await jsonBody(request)
        const { size, contentType, upsert, metadata } = body
        if (metadata !== undefined && !isDocument(metadata))
          throw new InvalidQueryError("metadata must be an object")
        const status = await storage.createUpload(await caller(exchange), bucket, path, {
          size: typeof size === "number" ? size : Number.NaN,
          contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
          upsert: upsert === true,
          ...(metadata === undefined ? {} : { metadata }),
        })
        return json(status, 201)
      }
      case "uploads": {
        const [id = "", second, third] = rest
        if (third !== undefined) break
        const who = await caller(exchange)
        if (second === undefined) {
          if (method === "GET") return json(await storage.uploadStatus(who, id))
          if (method === "DELETE") {
            await storage.abortUpload(who, id)
            return new Response(null, { status: 204 })
          }
          break
        }
        if (second === "complete" && method === "POST")
          return json(await storage.completeUpload(who, id), 201)
        if (/^\d{1,5}$/.test(second) && method === "PUT") {
          const status = await storage.uploadStatus(who, id)
          return json(
            await storage.putPart(who, id, Number(second), await bytesOf(request, status.partSize)),
          )
        }
        break
      }
    }
    throw new CanopyError(ErrorCode.NotFound, "Not found")
  }

  return {
    path: basePath,
    async fetch(request, info = {}) {
      const url = new URL(request.url)
      const requestId = requestIdOf(request.headers)
      const origin = request.headers.get("origin")
      let response: Response
      try {
        const segments = segmentsOf(url.pathname, basePath)
        if (segments === undefined) throw new CanopyError(ErrorCode.NotFound, "Not found")
        if (request.method === "OPTIONS" && options.cors !== undefined)
          return preflight(
            options.cors,
            request,
            "GET, HEAD, POST, PUT, DELETE, OPTIONS",
            ALLOWED_HEADERS,
          )
        response = await route({ request, url, segments, peer: info.ip })
      } catch (error: unknown) {
        const canopy = toCanopyError(error)
        if (canopy.status >= 500) options.onError?.(error, request)
        const size = canopy.details?.["size"]
        if (canopy.details?.["rangeNotSatisfiable"] === true && typeof size === "number") {
          response = new Response(null, {
            status: 416,
            headers: { "content-range": `bytes */${size}` },
          })
        } else {
          const retry = canopy.details?.["retryAfterSeconds"]
          response = problemResponse(
            toProblem(canopy, url.pathname, requestId, DEFAULT_PROBLEM_TYPE_BASE),
            typeof retry === "number" ? retry : undefined,
          )
        }
      }
      response.headers.set("x-request-id", requestId)
      return withCors(response, options.cors, origin, EXPOSED_HEADERS)
    },
  }
}
