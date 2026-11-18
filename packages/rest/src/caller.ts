import {
  type Authenticator,
  credentialsFromHeaders,
  type RateLimits,
  rateLimitError,
} from "@canopy/auth"
import type { ContextResolver, PolicyEngine } from "@canopy/policy"
import { ForbiddenError, RateLimitError } from "@canopy/protocol"
import type { Caller } from "./write-path.ts"

/** What {@link requestCaller} needs. */
export interface CallerOptions {
  /** Verifies the `apikey` and `Authorization` headers. */
  readonly authenticator: Authenticator
  /** The policies in force, for the context lookups a request needs. */
  readonly policies: () => PolicyEngine
  readonly contexts: ContextResolver
  /** Refuses callers over their budget, before any policy or database work. */
  readonly rateLimits?: RateLimits
  /** Called whenever the rate limits refuse a request. */
  readonly onRateLimited?: () => void
}

/**
 * The caller of a request: authenticates its credentials (counting failures per client address when rate
 * limits are on), refuses view tokens and callers over their request budget, and resolves the context lookups
 * (`$ctx`) the policies of `collections` need for the caller's roles (every collection when `undefined`).
 * `peer` is the socket address; forwarded headers count only from trusted proxies.
 */
export async function requestCaller(
  options: CallerOptions,
  request: Request,
  peer: string | undefined,
  collections: readonly string[] | undefined,
): Promise<Caller> {
  const credentials = credentialsFromHeaders(request.headers)
  const limits = options.rateLimits
  const address = limits?.addressOf(request.headers, peer)
  const authenticate = () => options.authenticator.authenticate(credentials.key, credentials.token)
  const principal =
    limits === undefined || address === undefined
      ? await authenticate()
      : await limits.guardAuthentication(address, authenticate).catch((error: unknown) => {
          if (error instanceof RateLimitError) options.onRateLimited?.()
          throw error
        })
  if (principal.readOnly === true)
    throw new ForbiddenError("A view token only follows data over realtime")
  if (limits !== undefined && address !== undefined) {
    const wait = limits.request({
      key: principal.keyId ?? credentials.key,
      subject: principal.subject,
      roles: principal.context.roles,
      address,
    })
    if (wait > 0) {
      options.onRateLimited?.()
      throw rateLimitError(wait)
    }
  }
  const current = options.policies()
  const names = current.contextNames(collections, principal.context.roles)
  const context =
    names.length === 0
      ? principal.context
      : {
          ...principal.context,
          ctx: (await options.contexts.resolve(current.set.contexts, names, principal.context)).ctx,
        }
  return { context, subject: principal.subject }
}
