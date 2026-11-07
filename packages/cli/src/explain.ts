import {
  ContextResolver,
  explainAccess,
  explainContext,
  formatAccessReport,
  OPERATIONS,
  type Operation,
  PolicyEngine,
  type PolicySet,
  toFilter,
} from "@canopy/policy"
import { diagnosticOf, formatDiagnostic, isDocument, mongoTarget, parse } from "@canopy/protocol"
import { directoryPolicies } from "@canopy/realtime"
import { mongoContextReader } from "@canopy/rest"
import { MongoClient } from "mongodb"
import { messageOf, type Output } from "./output.ts"

/** Options of `canopy policies explain`. */
export interface PolicyExplainOptions {
  /** The policy directory. */
  readonly dir: string
  readonly collection: string
  /** The operation, `read` when omitted. */
  readonly op?: string
  /** The caller's claims as (extended) JSON, or `anon` / omitted for an anonymous caller. */
  readonly as?: string
  /** Custom roles, comma separated. `service` explains the bypass. */
  readonly roles?: string
  /** For reads: the caller's filter as (extended) JSON. */
  readonly filter?: string
  /** Values of context lookups as (extended) JSON, instead of resolving them against MongoDB. */
  readonly ctx?: string
  /** With a connection string, context lookups are resolved and matching documents counted. */
  readonly mongodbUri?: string
  readonly database?: string
}

function document(text: string, flag: string): Record<string, unknown> {
  const value = parse(text)
  if (!isDocument(value)) throw new TypeError(`--${flag} needs a JSON document`)
  return value
}

/**
 * `canopy policies explain <collection>`: shows how DLS decides one operation for a stated caller, the
 * same way the server does. Offline it uses the policy files only; with a connection string it also
 * resolves context lookups and counts the documents the effective filter matches. Returns the exit code.
 */
export async function policiesExplain(options: PolicyExplainOptions, out: Output): Promise<number> {
  const op = options.op ?? "read"
  if (!OPERATIONS.includes(op as Operation)) {
    out.error(`--op must be one of ${OPERATIONS.join(", ")}`)
    return 1
  }
  let claims: Record<string, unknown> | null
  let filter: Record<string, unknown> | undefined
  let ctx: Record<string, unknown> | undefined
  try {
    claims = options.as === undefined || options.as === "anon" ? null : document(options.as, "as")
    filter = options.filter === undefined ? undefined : document(options.filter, "filter")
    ctx = options.ctx === undefined ? undefined : document(options.ctx, "ctx")
  } catch (error: unknown) {
    out.error(messageOf(error))
    return 1
  }
  let set: PolicySet
  try {
    set = await directoryPolicies(options.dir).load()
  } catch (error: unknown) {
    out.error(`error  ${messageOf(error)}`)
    return 1
  }
  if (!set.collections.has(options.collection)) {
    const known = [...set.collections.keys()].sort()
    out.error(
      `No policies for ${options.collection} in ${options.dir}. Every request but service is denied.${known.length === 0 ? "" : `\nCollections with policies: ${known.join(", ")}`}`,
    )
    return 1
  }
  const engine = new PolicyEngine(set)
  const roles = (options.roles ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "")
  let context = explainContext({ claims, roles, ...(ctx === undefined ? {} : { ctx }) })
  const lookups = engine.contextNames([options.collection], context.roles)
  const client =
    options.mongodbUri === undefined
      ? undefined
      : new MongoClient(
          options.mongodbUri,
          /serverSelectionTimeoutMS=/i.test(options.mongodbUri)
            ? {}
            : { serverSelectionTimeoutMS: 10_000 },
        )
  try {
    await client?.connect()
    const db = client?.db(options.database)
    if (db !== undefined && ctx === undefined && lookups.length > 0) {
      const resolver = new ContextResolver({ reader: mongoContextReader(db) })
      try {
        context = { ...context, ctx: (await resolver.resolve(set.contexts, lookups, context)).ctx }
      } finally {
        resolver.close()
      }
    }
    const report = explainAccess(engine, {
      collection: options.collection,
      op: op as Operation,
      context,
      ...(filter === undefined ? {} : { filter }),
    })
    out.log(formatAccessReport(report))
    if (db !== undefined) {
      const count =
        report.effective.kind === "deny"
          ? 0
          : await db.collection(options.collection).countDocuments(toFilter(report.effective))
      out.log(`Matching documents: ${count}`)
    } else if (ctx === undefined && lookups.length > 0) {
      out.log(
        `Context lookups ${lookups.join(", ")} were not resolved and count as missing: pass --ctx, or --mongodb-uri to resolve them.`,
      )
    }
    return 0
  } catch (error: unknown) {
    const target =
      options.mongodbUri === undefined ? {} : mongoTarget(options.mongodbUri, options.database)
    out.error(formatDiagnostic(diagnosticOf(error, target)))
    return 1
  } finally {
    await client?.close()
  }
}
