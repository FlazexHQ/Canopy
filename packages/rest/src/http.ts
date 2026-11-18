import {
  CanopyError,
  ErrorCode,
  encode,
  InvalidQueryError,
  parse,
  toCanonical,
  uuidv7,
} from "@canopy/protocol"
import type { CountMode } from "./params.ts"
import { PROBLEM_MEDIA_TYPE, type Problem } from "./problem.ts"
import type { Caller } from "./write-path.ts"

/** One request on its way through the router. */
export interface Exchange {
  readonly request: Request
  readonly url: URL
  readonly segments: readonly string[]
  readonly encoding: Encoding
  readonly prefer: Preferences
  readonly caller: Caller
  readonly requestId: string
}

/** Serves one routed request. */
export type Route = (exchange: Exchange) => Promise<Response>

/** How response values are encoded: relaxed EJSON (`application/json`) or canonical (`application/ejson`). */
export type Encoding = "relaxed" | "canonical"

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** Picks the response encoding from `Accept`. Canonical EJSON must be asked for explicitly. */
export function negotiate(accept: string | null): Encoding {
  if (accept === null) return "relaxed"
  return accept
    .split(",")
    .some((part) => part.split(";")[0]?.trim().toLowerCase() === "application/ejson")
    ? "canonical"
    : "relaxed"
}

/** Uses the caller's `X-Request-Id` when it is a safe token, or mints a UUIDv7. */
export function requestIdOf(headers: Headers): string {
  const given = headers.get("x-request-id")
  return given !== null && REQUEST_ID.test(given) ? given : uuidv7()
}

/** The `Prefer` header preferences that change a response. */
export interface Preferences {
  readonly return?: "minimal" | "representation"
  readonly count?: CountMode
  readonly bulk?: boolean
}

/** Reads `Prefer: return=minimal, count=exact, bulk=true`. Unknown preferences are ignored (RFC 7240). */
export function preferencesOf(headers: Headers): Preferences {
  const header = headers.get("prefer")
  if (header === null) return {}
  const out: { return?: "minimal" | "representation"; count?: CountMode; bulk?: boolean } = {}
  for (const token of header.split(/[,;]/)) {
    const [rawKey, rawValue] = token.split("=")
    const key = rawKey?.trim().toLowerCase()
    const value = rawValue?.trim().replace(/^"|"$/g, "").toLowerCase()
    if (key === "return" && (value === "minimal" || value === "representation")) out.return = value
    else if (key === "count" && (value === "exact" || value === "estimated")) out.count = value
    else if (key === "bulk" && value === "true") out.bulk = true
  }
  return out
}

const JSON_TYPES = new Set(["application/json", "application/ejson"])

/**
 * Reads and decodes an EJSON request body of at most `maxBytes`. An empty body reads as `undefined`.
 * Throws `CANOPY_PAYLOAD_TOO_LARGE` beyond the limit and {@link InvalidQueryError} for other media types
 * or malformed JSON.
 */
export async function readBody(
  request: Request,
  maxBytes: number,
  accepted: ReadonlySet<string> = JSON_TYPES,
): Promise<{ readonly value: unknown; readonly mediaType: string } | undefined> {
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > maxBytes) throw tooLarge(maxBytes)
  if (request.body === null) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw tooLarge(maxBytes)
    }
    chunks.push(value)
  }
  if (size === 0) return undefined
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase()
  if (mediaType === undefined || !accepted.has(mediaType))
    throw new InvalidQueryError(`The request body must be one of: ${[...accepted].join(", ")}`)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new InvalidQueryError("The request body is not valid UTF-8", { cause: error })
  }
  return { value: parse(text), mediaType }
}

function tooLarge(maxBytes: number): CanopyError {
  return new CanopyError(
    ErrorCode.PayloadTooLarge,
    `The request body may not exceed ${maxBytes} bytes`,
  )
}

/** The JSON text of a value in the negotiated encoding. */
export function encodeBody(body: unknown, encoding: Encoding): string {
  return JSON.stringify(encoding === "canonical" ? toCanonical(body) : encode(body))
}

/** A response whose body is JSON text already in the negotiated encoding. */
export function textResponse(
  text: string,
  encoding: Encoding,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type":
        encoding === "canonical" ? "application/ejson" : "application/json; charset=utf-8",
      ...headers,
    },
  })
}

/** Serializes a response body in the negotiated encoding. */
export function jsonResponse(
  body: unknown,
  encoding: Encoding,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return textResponse(encodeBody(body, encoding), encoding, status, headers)
}

/** Serializes Problem Details, with `WWW-Authenticate` on `401` and `Retry-After` on `429`. */
export function problemResponse(problem: Problem, retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { "content-type": PROBLEM_MEDIA_TYPE }
  if (problem.status === 401)
    headers["www-authenticate"] =
      problem.code === ErrorCode.TokenExpired
        ? 'Bearer error="invalid_token", error_description="The token has expired"'
        : "Bearer"
  if (retryAfterSeconds !== undefined) headers["retry-after"] = String(retryAfterSeconds)
  return new Response(JSON.stringify(encode(problem)), { status: problem.status, headers })
}

/** Cross origin settings for browser callers. */
export interface CorsOptions {
  /** Allowed origins, or `*` for any. */
  readonly origins: readonly string[] | "*"
  /** How long browsers may cache a preflight. Defaults to 600 seconds. */
  readonly maxAgeSeconds?: number
}

const ALLOWED_HEADERS =
  "apikey, authorization, content-type, accept, prefer, idempotency-key, x-request-id, if-none-match"
const EXPOSED_HEADERS = "x-request-id, x-canopy-ct, retry-after, location, etag"

/** Returns the origin to echo, or `undefined` when the origin is not allowed. */
function allowedOrigin(cors: CorsOptions, origin: string | null): string | undefined {
  if (origin === null) return undefined
  if (cors.origins === "*") return "*"
  return cors.origins.includes(origin) ? origin : undefined
}

/** Answers a CORS preflight. */
export function preflight(
  cors: CorsOptions,
  request: Request,
  methods: string,
  allowHeaders: string = ALLOWED_HEADERS,
): Response {
  const origin = allowedOrigin(cors, request.headers.get("origin"))
  if (origin === undefined) return new Response(null, { status: 204, headers: { vary: "Origin" } })
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": methods,
      "access-control-allow-headers": allowHeaders,
      "access-control-max-age": String(cors.maxAgeSeconds ?? 600),
      vary: "Origin",
    },
  })
}

/** Adds the CORS response headers for an allowed origin. */
export function withCors(
  response: Response,
  cors: CorsOptions | undefined,
  origin: string | null,
  exposeHeaders: string = EXPOSED_HEADERS,
): Response {
  if (cors === undefined) return response
  const allowed = allowedOrigin(cors, origin)
  response.headers.append("vary", "Origin")
  if (allowed === undefined) return response
  response.headers.set("access-control-allow-origin", allowed)
  response.headers.set("access-control-expose-headers", exposeHeaders)
  return response
}
