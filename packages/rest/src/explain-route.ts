import {
  type ContextResolver,
  explainAccess,
  explainContext,
  formatAccessReport,
  OPERATIONS,
  type Operation,
  type PolicyEngine,
  Role,
  toFilter,
} from "@canopy/policy"
import { ForbiddenError, InvalidQueryError, isDocument } from "@canopy/protocol"
import { type Exchange, jsonResponse, type Route } from "./http.ts"
import type { ReadPath } from "./read-path.ts"

/** What {@link explainRoute} needs from the handler. */
export interface ExplainRouteOptions {
  readonly engine: () => PolicyEngine
  readonly contexts: ContextResolver
  readonly reads: ReadPath
  readonly body: (exchange: Exchange) => Promise<unknown>
}

const FIELDS = new Set(["op", "claims", "roles", "filter", "ctx", "count"])

function documentField(
  input: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (!isDocument(value)) throw new InvalidQueryError(`${name} must be a document`)
  return value
}

/**
 * `POST /rest/v1/{coll}/_explain`: explains how DLS decides an operation for a stated caller, with the same
 * engine and context lookups as real requests. An explanation describes the policy structure and resolved
 * claim values, so only `service` callers (a secret key) may ask; every other caller gets `403`, in every
 * mode.
 *
 * The body takes `op` (default `read`), `claims` (a document, or `null` or absent for `anon`), `roles` (custom
 * roles), `filter` (the caller's read filter), `ctx` (context lookup values, resolved from the database when
 * absent) and `count` (also count the documents the effective filter matches).
 */
export function explainRoute(options: ExplainRouteOptions): Route {
  return async (exchange) => {
    const { caller, request, segments, encoding } = exchange
    if (!caller.context.roles.has(Role.Service))
      throw new ForbiddenError("Explanations are only available with a secret key")
    const collection = segments[0] ?? ""
    const input = (await options.body(exchange)) ?? {}
    if (!isDocument(input)) throw new InvalidQueryError("The explain body must be a document")
    for (const key of Object.keys(input)) {
      if (!FIELDS.has(key)) throw new InvalidQueryError(`Unknown explain field ${key}`)
    }
    const op = input["op"] ?? "read"
    if (typeof op !== "string" || !OPERATIONS.includes(op as Operation))
      throw new InvalidQueryError(`op must be one of ${OPERATIONS.join(", ")}`)
    const claims = input["claims"] === null ? null : (documentField(input, "claims") ?? null)
    const roles = input["roles"] ?? []
    if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string"))
      throw new InvalidQueryError("roles must be a list of role names")
    const filter = documentField(input, "filter")
    const ctx = documentField(input, "ctx")
    if (input["count"] !== undefined && typeof input["count"] !== "boolean")
      throw new InvalidQueryError("count must be a boolean")
    const engine = options.engine()
    let context = explainContext({ claims, roles, ...(ctx === undefined ? {} : { ctx }) })
    const lookups = engine.contextNames([collection], context.roles)
    if (ctx === undefined && lookups.length > 0)
      context = {
        ...context,
        ctx: (await options.contexts.resolve(engine.set.contexts, lookups, context)).ctx,
      }
    const report = explainAccess(engine, {
      collection,
      op: op as Operation,
      context,
      ...(filter === undefined ? {} : { filter }),
    })
    const count =
      input["count"] === true && op !== "insert"
        ? (
            await options.reads.count(caller, collection, toFilter(report.effective), "exact", {
              signal: request.signal,
            })
          ).count
        : undefined
    return jsonResponse(
      {
        data: {
          ...report,
          effectiveFilter: toFilter(report.effective),
          text: formatAccessReport(report),
          ...(count === undefined ? {} : { count }),
        },
      },
      encoding,
    )
  }
}
