import { type CanopyError, ErrorCode } from "@canopy/protocol"

/** An RFC 9457 Problem Details body, extended with the stable Canopy error code. */
export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: ErrorCode
  readonly detail: string
  readonly instance: string
  readonly requestId: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** The media type of Problem Details responses. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json"

/** The default prefix of problem `type` URIs. */
export const DEFAULT_PROBLEM_TYPE_BASE = "urn:canopy:error:"

const TITLES: Readonly<Record<ErrorCode, string>> = {
  CANOPY_UNAUTHORIZED: "Unauthorized",
  CANOPY_TOKEN_EXPIRED: "Token expired",
  CANOPY_FORBIDDEN: "Forbidden",
  CANOPY_NOT_FOUND: "Not found",
  CANOPY_POLICY_VIOLATION: "Policy violation",
  CANOPY_INVALID_QUERY: "Invalid query",
  CANOPY_CONFLICT: "Conflict",
  CANOPY_DUPLICATE_KEY: "Duplicate key",
  CANOPY_PAYLOAD_TOO_LARGE: "Payload too large",
  CANOPY_VALIDATION_FAILED: "Validation failed",
  CANOPY_RATE_LIMITED: "Rate limited",
  CANOPY_LIMIT_SUBSCRIPTIONS: "Too many subscriptions",
  CANOPY_SUBSCRIPTION_TOO_LARGE: "Subscription too large",
  CANOPY_BULK_LIMIT: "Bulk limit exceeded",
  CANOPY_COLLECTION_DROPPED: "Collection dropped",
  CANOPY_SESSION_MOVED: "Session moved",
  CANOPY_PROTOCOL_ERROR: "Protocol error",
  CANOPY_TIMEOUT: "Timeout",
  CANOPY_UNAVAILABLE: "Unavailable",
  CANOPY_INTERNAL: "Internal error",
  CANOPY_CONFIG_INVALID: "Invalid configuration",
}

/** Returns the slug of a code, for example `policy-violation` for `CANOPY_POLICY_VIOLATION`. */
export function problemSlug(code: ErrorCode): string {
  return code.slice("CANOPY_".length).toLowerCase().replaceAll("_", "-")
}

/**
 * Builds the Problem Details of an error. Internal errors never expose their message, because it may come
 * from the driver or a bug; every other Canopy error message is written for callers.
 */
export function toProblem(
  error: CanopyError,
  instance: string,
  requestId: string,
  typeBase: string = DEFAULT_PROBLEM_TYPE_BASE,
): Problem {
  const internal = error.code === ErrorCode.Internal
  return {
    type: `${typeBase}${problemSlug(error.code)}`,
    title: TITLES[error.code],
    status: error.status,
    code: error.code,
    detail: internal ? "Internal error" : error.message,
    instance,
    requestId,
    ...(!internal && error.details !== undefined ? { details: error.details } : {}),
  }
}
