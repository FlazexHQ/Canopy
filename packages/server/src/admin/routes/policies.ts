import { selectEngine } from "@canopy/native"
import {
  type ContextDefinitions,
  explainAccess,
  formatAccessReport,
  OPERATIONS,
  type Operation,
  toFilter,
} from "@canopy/policy"
import { isDocument, ValidationError } from "@canopy/protocol"
import { ReadPath } from "@canopy/rest"
import {
  collectionName,
  contextsInput,
  definitionFromInput,
  hashContexts,
} from "../../policy-store.ts"
import { document, integer, object, oneOf, optional, string, unknownValue } from "../../schema.ts"
import { json } from "../http.ts"
import type { AdminDeps, RouteFn } from "./core.ts"

/** Registers the policy and context lookup routes. */
export function registerPolicies(route: RouteFn, deps: AdminDeps): void {
  const { options, config, policies, production, app, impersonate } = deps
  // Policies

  route("GET", "policies", "policies.read", async () => {
    const { stored } = await policies.all()
    return json({
      data: [...stored.values()].map((doc) => ({
        collection: doc._id,
        version: doc.version,
        hash: doc.hash,
        exposed: doc.exposed,
        realtime: doc.realtime,
        policies: doc.policies.length,
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy,
      })),
      writable: policies.isWritable,
      bundle: options.engine().version,
    })
  })

  route("GET", "policies/:collection", "policies.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const stored = await policies.get(collection)
    const active = options.engine().collection(collection)
    const findings = active === undefined ? [] : (await policies.check(active)).findings
    return json({
      collection,
      stored: stored ?? null,
      version: stored?.version ?? 0,
      active: options.engine().set.hashes.get(collection) ?? null,
      findings,
      writable: policies.isWritable,
    })
  })

  route("POST", "policies/:collection/validate", "policies.simulate", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const body = object({ definition: unknownValue() }).parse(await context.body())
    const definition = definitionFromInput(collection, body.definition)
    const { findings, set } = await policies.check(definition)
    return json({
      valid: findings.every((finding) => finding.severity !== "error"),
      hash: set.hashes.get(collection),
      findings,
    })
  })

  route("POST", "policies/:collection/simulate", "policies.simulate", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const body = object({
      definition: optional(unknownValue()),
      as: unknownValue(),
      op: oneOf(...OPERATIONS),
      filter: optional(unknownValue()),
      limit: optional(integer({ min: 1, max: 100 })),
    }).parse(await context.body())
    const engine =
      body.definition === undefined
        ? options.engine()
        : selectEngine(config.server.engine).createPolicyEngine(
            (await policies.check(definitionFromInput(collection, body.definition))).set,
          )
    const as = await impersonate(body.as, collection, engine)
    const op: Operation = body.op
    const filterInput = body.filter === undefined ? {} : body.filter
    if (!isDocument(filterInput)) throw new ValidationError("filter must be a document")
    const filter = filterInput
    const explain = engine.explain(collection, op, as.context, "using")
    const check =
      op === "insert" || op === "update"
        ? engine.explain(collection, op, as.context, "check")
        : undefined
    const granted = engine.hasGrant(collection, op, as.context)
    let result: Record<string, unknown> = {}
    if (op === "read" && granted) {
      const reads = new ReadPath({
        client: options.client,
        database: config.mongodb.database,
        policies: engine,
      })
      const page = await reads.find(
        { context: as.context, subject: as.subject },
        { collection, filter, limit: body.limit ?? 20, count: "exact" },
        { signal: context.request.signal },
      )
      result = { count: page.total, sample: page.docs }
    } else if ((op === "update" || op === "delete") && granted) {
      const target = toFilter(engine.target(collection, op, as.context))
      const count = await app
        .collection(collection)
        .countDocuments({ $and: [filter, target] }, { maxTimeMS: 5000 })
      result = { count }
    }
    return json({
      allowed: granted,
      op,
      roles: [...as.context.roles].sort(),
      effectiveFilter: { $and: [filter, toFilter(explain.result)] },
      explain,
      ...(check === undefined ? {} : { check }),
      fields: {
        read: engine.readable(collection, as.context),
        ...(op === "insert" || op === "update"
          ? { write: engine.writable(collection, op, as.context) }
          : {}),
      },
      ...result,
    })
  })

  route("POST", "policies/:collection/explain", "policies.simulate", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const body = object({
      as: unknownValue(),
      op: optional(oneOf(...OPERATIONS)),
      filter: optional(document()),
    }).parse(await context.body())
    const engine = options.engine()
    const as = await impersonate(body.as, collection, engine)
    const report = explainAccess(engine, {
      collection,
      op: body.op ?? "read",
      context: as.context,
      ...(body.filter === undefined ? {} : { filter: body.filter }),
    })
    return json({
      ...report,
      effectiveFilter: toFilter(report.effective),
      text: formatAccessReport(report),
    })
  })

  route(
    "POST",
    "policies/:collection/publish",
    "policies.publish",
    async (context) => {
      const collection = collectionName(context.params["collection"] ?? "")
      const body = object({
        definition: unknownValue(),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
        commitSha: optional(string({ min: 7, max: 64, pattern: /^[0-9a-f]+$/ })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      const result = await policies.publish({
        definition: definitionFromInput(collection, body.definition),
        expectedVersion: body.expectedVersion,
        actor: context.actor,
        origin: context.origin,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        ...(body.commitSha === undefined ? {} : { commitSha: body.commitSha }),
      })
      return json(result)
    },
    "policy.publish",
  )

  route("GET", "policies/:collection/history", "policies.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const limit = Number(context.url.searchParams.get("limit") ?? "50")
    const before = context.url.searchParams.get("before")
    const entries = await policies.versions(collection, {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(before === null ? {} : { before: Number(before) }),
    })
    return json({ data: entries })
  })

  route(
    "POST",
    "policies/:collection/rollback",
    "policies.publish",
    async (context) => {
      const collection = collectionName(context.params["collection"] ?? "")
      const body = object({
        version: integer({ min: 1 }),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      return json(
        await policies.rollback({
          collection,
          version: body.version,
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        }),
      )
    },
    "policy.rollback",
  )

  // Context lookups

  route("GET", "contexts", "policies.read", async () => {
    const stored = await policies.getContexts()
    return json({
      stored: stored ?? null,
      version: stored?.version ?? 0,
      writable: policies.isWritable,
    })
  })

  route("POST", "contexts/validate", "policies.simulate", async (context) => {
    const body = contextsInput.parse(await context.body())
    const { findings } = await policies.checkContexts(body.lookups as ContextDefinitions)
    return json({
      valid: findings.every((finding) => finding.severity !== "error"),
      hash: hashContexts(body.lookups as ContextDefinitions),
      findings,
    })
  })

  route(
    "POST",
    "contexts/publish",
    "policies.publish",
    async (context) => {
      const body = object({
        lookups: document(),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
        commitSha: optional(string({ min: 7, max: 64, pattern: /^[0-9a-f]+$/ })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      return json(
        await policies.publishContexts({
          lookups: body.lookups as ContextDefinitions,
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
          ...(body.commitSha === undefined ? {} : { commitSha: body.commitSha }),
        }),
      )
    },
    "context.publish",
  )

  route("GET", "contexts/history", "policies.read", async (context) => {
    const limit = Number(context.url.searchParams.get("limit") ?? "50")
    return json({
      data: await policies.versions("_context", { limit: Number.isFinite(limit) ? limit : 50 }),
    })
  })

  route(
    "POST",
    "contexts/rollback",
    "policies.publish",
    async (context) => {
      const body = object({
        version: integer({ min: 1 }),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      return json(
        await policies.rollbackContexts({
          version: body.version,
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        }),
      )
    },
    "context.rollback",
  )
}
