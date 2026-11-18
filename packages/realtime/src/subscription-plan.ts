import {
  type CompiledProjection,
  compileFilter,
  compileProjection,
  UnsupportedQueryError,
} from "@canopy/matcher"
import {
  type Compiled,
  type ContextResolver,
  deniedPaths,
  deniesTextSearch,
  explainAccess,
  explainContext,
  type FieldAccess,
  formatAccessReport,
  type PolicyEngine,
  projectReadable,
  type RequestContext,
  TEXT_SEARCH_DENIED,
  toFilter,
} from "@canopy/policy"
import { CanopyError, ErrorCode, type ExplainAs, type SubMessage } from "@canopy/protocol"
import { DEFAULT_LIMITS, parseQuery, queryHash } from "@canopy/query"
import type { Doc } from "./event.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import type { ObservedQuery } from "./observers.ts"
import type { SessionState } from "./realtime-types.ts"
import { type Coverage, FULL_COVERAGE } from "./session.ts"

/** How a subscription is served: the shared observer's key and query, and what its listener projects. */
export interface SubscriptionPlan {
  readonly key: string
  readonly query: ObservedQuery
  readonly type: "filter" | "window" | "polling"
  readonly projection: CompiledProjection | undefined
  /** The subscription's own filter, before the read policies. */
  readonly userFilter: Record<string, unknown>
}

/** The request context a session's subscriptions and mutations are evaluated with. */
export function contextOf(state: SessionState): RequestContext {
  return { ...state.principal.context, ctx: state.ctx }
}

/** Which top level fields a projected subscription receives, so diffs skip the others. */
export function coverageOf(projection: CompiledProjection | undefined): Coverage {
  if (projection === undefined) return FULL_COVERAGE
  if (projection.mode === "include") {
    const fields = new Set(projection.paths.map((path) => path.split(".")[0] ?? path))
    fields.add("_id")
    return { covers: (field) => fields.has(field) }
  }
  const hidden = new Set(projection.paths.filter((path) => !path.includes(".")))
  return { covers: (field) => !hidden.has(field) }
}

function accessDescriptor(access: FieldAccess): unknown {
  return access.kind === "all" ? "all" : { [access.kind]: [...access.paths].sort() }
}

/**
 * Plans a subscription for `ctx`: refuses unknown collections, text search a field rule forbids and
 * unreadable fields, applies the read policies, and picks the observer type the effective filter allows.
 * Subscriptions with the same plan key share one observer.
 */
export function planSubscription(
  engine: PolicyEngine,
  ctx: RequestContext,
  message: SubMessage,
  maxWindow: number,
  metrics: RealtimeMetrics,
): SubscriptionPlan {
  const coll = message.c
  if (!engine.isRealtime(coll))
    throw new CanopyError(ErrorCode.NotFound, `No realtime collection ${coll}`)
  const parsed = parseQuery(message.q, { ...DEFAULT_LIMITS, maxLimit: maxWindow })
  const readable = engine.readable(coll, ctx)
  if (deniesTextSearch(readable, parsed.filter.filter))
    throw new CanopyError(ErrorCode.InvalidQuery, TEXT_SEARCH_DENIED)
  const denied = deniedPaths(readable, parsed.paths)
  if (denied.length > 0) {
    throw new CanopyError(
      ErrorCode.InvalidQuery,
      `The query references fields that are not readable: ${denied.join(", ")}`,
    )
  }
  const effective: Compiled = engine.effectiveRead(coll, parsed.filter.filter, ctx)
  if (effective.kind === "deny") metrics.denials.inc({ surface: "realtime", coll, op: "read" })
  const filter = toFilter(effective)
  let type: "filter" | "window" | "polling" = parsed.filter.matcherSafe
    ? parsed.limit === undefined
      ? "filter"
      : "window"
    : "polling"
  if (type !== "polling") {
    try {
      compileFilter(filter)
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedQueryError)) throw error
      type = "polling"
    }
  }
  const projection =
    parsed.fields === undefined ? undefined : compileProjection(parsed.fields.projection)
  const sort = parsed.sort?.sort
  const key = queryHash({
    collection: coll,
    filter,
    sort,
    limit: parsed.limit,
    projection: { readable: accessDescriptor(readable), type } as Record<string, unknown>,
  })
  return {
    key,
    type,
    projection,
    userFilter: parsed.filter.filter,
    query: {
      coll,
      filter,
      sort,
      limit: parsed.limit,
      readable: (doc: Doc) => projectReadable(readable, doc),
    },
  }
}

/**
 * The access report a `sub` asked for with `o.explain`: for the connection itself (`true`, evaluated with
 * `own`) or for a stated caller, whose context lookups are resolved unless `ctx` is given. It names the
 * policies, their outcomes and the effective filter; a policy that dropped out is described by its
 * variable's name and kind, never by the value that made it fail.
 */
export async function explainSubscription(
  engine: PolicyEngine,
  contexts: ContextResolver,
  maxWindow: number,
  own: RequestContext,
  message: SubMessage,
  explain: true | ExplainAs,
): Promise<Record<string, unknown>> {
  const coll = message.c
  if (!engine.isRealtime(coll))
    throw new CanopyError(ErrorCode.NotFound, `No realtime collection ${coll}`)
  const parsed = parseQuery(message.q, { ...DEFAULT_LIMITS, maxLimit: maxWindow })
  let context: RequestContext
  if (explain === true) context = own
  else {
    context = explainContext({
      claims: explain.claims ?? null,
      roles: explain.roles ?? [],
      ...(explain.ctx === undefined ? {} : { ctx: explain.ctx }),
    })
    const names = engine.contextNames([coll], context.roles)
    if (explain.ctx === undefined && names.length > 0)
      context = {
        ...context,
        ctx: (await contexts.resolve(engine.set.contexts, names, context)).ctx,
      }
  }
  const report = explainAccess(engine, {
    collection: coll,
    op: "read",
    context,
    filter: parsed.filter.filter,
  })
  return {
    ...report,
    effectiveFilter: toFilter(report.effective),
    text: formatAccessReport(report),
  }
}
