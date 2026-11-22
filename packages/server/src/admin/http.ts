import { timingSafeEqual } from "node:crypto"
import { sha256 } from "@canopy/auth/crypto"
import { CanopyError, ErrorCode, encode, toCanopyError } from "@canopy/protocol"
import { toProblem } from "@canopy/rest"

/** The admin session cookie. `__Host-` binds it to this exact host, path `/` and HTTPS. */
export const SESSION_COOKIE = "__Host-canopy_admin"
/** The CSRF cookie Studio reads and echoes in the `x-canopy-csrf` header (double submit). */
export const CSRF_COOKIE = "__Host-canopy_csrf"
/** The header that must repeat the CSRF cookie on every state changing admin request. */
export const CSRF_HEADER = "x-canopy-csrf"

/** The API answers JSON only: nothing may be framed, loaded or scripted from its responses. */
export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox"

/** Studio pages: same origin assets only, no inline scripts or styles, never framed. */
export { STUDIO_CSP } from "@canopy/studio"

/** Adds the headers every admin response carries. */
export function secure(response: Response, csp = API_CSP): Response {
  const headers = response.headers
  headers.set("content-security-policy", csp)
  headers.set("x-frame-options", "DENY")
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "no-referrer")
  headers.set("cross-origin-opener-policy", "same-origin")
  headers.set("cross-origin-resource-policy", "same-origin")
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()")
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store")
  return response
}

/** A JSON response. Values are written as relaxed EJSON, so dates and ObjectIds survive. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(encode(body)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

/** A Problem Details response for any thrown value. Internal errors never leak their message. */
export function problem(error: unknown, instance: string, requestId: string): Response {
  const canopy: CanopyError = toCanopyError(error)
  const body = toProblem(canopy, instance, requestId)
  const headers: Record<string, string> = { "content-type": "application/problem+json" }
  const retry = canopy.details?.["retryAfterSeconds"]
  if (typeof retry === "number") headers["retry-after"] = String(retry)
  return new Response(JSON.stringify(encode(body)), { status: body.status, headers })
}

/** Reads one cookie from a `Cookie` header. */
export function cookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

/** A `Set-Cookie` value for the admin cookies. */
export function setCookie(
  name: string,
  value: string,
  options: { readonly maxAgeSeconds: number; readonly httpOnly: boolean },
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "Secure",
    "SameSite=Strict",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ].join("; ")
}

/** Compares two secrets in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const left = sha256(a)
  const right = sha256(b)
  return timingSafeEqual(left, right)
}

/** Raised when a mutating request fails the CSRF or Origin checks. */
export function csrfFailure(message: string): CanopyError {
  return new CanopyError(ErrorCode.Forbidden, message, { details: { reason: "csrf" } })
}

/**
 * Checks where a state changing request comes from. `Sec-Fetch-Site` (when a browser sends it) must say
 * `same-origin` or `none`, and `Origin`, when present, must be one of `allowed`. With `required`, a
 * missing `Origin` is refused too, which is what cookie sessions need.
 */
export function checkOrigin(
  request: Request,
  allowed: ReadonlySet<string>,
  required: boolean,
): void {
  const site = request.headers.get("sec-fetch-site")
  if (site !== null && site !== "same-origin" && site !== "none")
    throw csrfFailure("Cross site requests are not allowed")
  const origin = request.headers.get("origin")
  if (origin === null) {
    if (required) throw csrfFailure("The Origin header is required")
    return
  }
  if (!allowed.has(origin)) throw csrfFailure("The request origin is not allowed")
}

/** True for methods that may change state. */
export function isMutating(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
}
