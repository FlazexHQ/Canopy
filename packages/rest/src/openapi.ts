import { type Operation, type PolicyEngine, type RequestContext, Role } from "@canopy/policy"
import { trimTrailingSlashes } from "@canopy/protocol"
import {
  type CollectionSchema,
  EJSON_COMPONENTS,
  type ObjectShape,
  restrictShape,
  toJsonSchema,
} from "@canopy/schema"

/** Options for {@link buildOpenApi}. */
export interface OpenApiOptions {
  readonly engine: PolicyEngine
  /** The caller; the document only describes what its roles may do. */
  readonly ctx: RequestContext
  /** Collection schemas by name. Collections without one get an open object schema. */
  readonly schemas: ReadonlyMap<string, CollectionSchema>
  /** Collections the document may describe, for `service`. Others see the exposed collections. */
  readonly collections?: readonly string[]
  readonly basePath?: string
  readonly title?: string
  readonly version?: string
}

type Json = Record<string, unknown>

const OPEN: ObjectShape = { kind: "object", fields: {}, open: true }

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` }
}

function componentName(collection: string): string {
  return collection.replace(/[^A-Za-z0-9._-]/g, "_")
}

const PROBLEM: Json = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    code: { type: "string", pattern: "^CANOPY_[A-Z_]+$" },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
    details: { type: "object" },
  },
  required: ["type", "title", "status", "code", "detail", "instance", "requestId"],
}

const CT: Json = {
  type: "string",
  pattern: "^\\d+$",
  description: "Cluster time of the read or commit",
}

const PROBLEM_RESPONSE: Json = {
  description: "Problem Details",
  content: { "application/problem+json": { schema: ref("Problem") } },
}

function json(schema: Json, description: string): Json {
  return {
    description,
    content: { "application/json": { schema }, "application/ejson": { schema: {} } },
  }
}

function body(schema: Json, extra: Readonly<Record<string, Json>> = {}): Json {
  return {
    required: true,
    content: { "application/json": { schema }, "application/ejson": { schema: {} }, ...extra },
  }
}

const UPDATE: Json = {
  type: "object",
  description: "Update operators such as $set, $inc and $push",
  propertyNames: { pattern: "^\\$" },
  minProperties: 1,
}

const PARAMETERS: Readonly<Record<string, Json>> = {
  filter: {
    name: "filter",
    in: "query",
    description:
      "A MongoDB filter as Extended JSON. Other parameters such as status=eq.active add conditions.",
    schema: { type: "string" },
  },
  sort: {
    name: "sort",
    in: "query",
    description: "Keys such as -createdAt,title",
    schema: { type: "string" },
  },
  fields: {
    name: "fields",
    in: "query",
    description: "title,done or -notes",
    schema: { type: "string" },
  },
  limit: {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
  },
  after: {
    name: "after",
    in: "query",
    description: "The cursor of the previous page",
    schema: { type: "string" },
  },
  skip: { name: "skip", in: "query", schema: { type: "integer", minimum: 0, maximum: 10000 } },
  count: { name: "count", in: "query", schema: { type: "string", enum: ["exact", "estimated"] } },
  where: {
    name: "where",
    in: "query",
    description: "A compare and set precondition as Extended JSON",
    schema: { type: "string" },
  },
  upsert: { name: "upsert", in: "query", schema: { type: "boolean" } },
  id: {
    name: "id",
    in: "path",
    required: true,
    description: 'The _id, or an Extended JSON value such as {"$oid":"…"}',
    schema: { type: "string" },
  },
  prefer: {
    name: "Prefer",
    in: "header",
    description: "return=minimal|representation, count=exact|estimated, bulk=true",
    schema: { type: "string" },
  },
  idempotency: {
    name: "Idempotency-Key",
    in: "header",
    schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
  },
}

function param(name: string): Json {
  return { $ref: `#/components/parameters/${name}` }
}

/** The names of the policies that apply to an operation for the caller's roles. Never their filters. */
function policyNames(
  engine: PolicyEngine,
  collection: string,
  op: Operation,
  ctx: RequestContext,
): string[] {
  if (ctx.roles.has(Role.Service)) return []
  return (engine.collection(collection)?.policies ?? [])
    .filter(
      (policy) =>
        policy.ops.includes(op) &&
        (policy.roles.includes(Role.Public) || policy.roles.some((role) => ctx.roles.has(role))),
    )
    .map((policy) => policy.name)
}

/**
 * Builds the OpenAPI 3.1 document of the Data API for one caller. It lists only the collections and
 * operations the caller's roles are granted, describes documents with the fields those roles may read
 * (and, for inserts, write), and names the applying policies in `x-canopy-policies`, never their filters.
 */
export function buildOpenApi(options: OpenApiOptions): Json {
  const { engine, ctx } = options
  const base = trimTrailingSlashes(options.basePath ?? "/rest/v1")
  const service = ctx.roles.has(Role.Service)
  const names = new Set<string>()
  for (const def of engine.set.collections.values())
    if (engine.isExposed(def.collection)) names.add(def.collection)
  if (service) for (const name of options.collections ?? []) names.add(name)
  const paths: Record<string, Json> = {}
  const schemas: Record<string, Json> = { ...EJSON_COMPONENTS, Problem: PROBLEM }
  let writes = false
  for (const name of [...names].sort()) {
    const grants = new Set(
      (["read", "insert", "update", "delete"] as const).filter((op) =>
        engine.hasGrant(name, op, ctx),
      ),
    )
    if (grants.size === 0) continue
    const shape = options.schemas.get(name)?.shape ?? OPEN
    const component = componentName(name)
    const tag = [name]
    const op = (operation: Operation, id: string, summary: string, spec: Json): Json => ({
      operationId: `${id}_${component}`,
      summary,
      tags: tag,
      "x-canopy-policies": policyNames(engine, name, operation, ctx),
      ...spec,
      responses: { ...(spec["responses"] as Json), default: PROBLEM_RESPONSE },
    })
    const document = ref(`${component}.Document`)
    const single = (description: string): Json =>
      json(
        {
          type: "object",
          properties: {
            data: { anyOf: [document, { type: "null" }] },
            ct: CT,
            replayed: { type: "boolean" },
          },
          required: ["data", "ct"],
        },
        description,
      )
    const collectionPath = `${base}/${encodeURIComponent(name)}`
    const collectionOps: Json = {}
    const itemOps: Json = {}
    if (grants.has("read")) {
      schemas[`${component}.Document`] = toJsonSchema(
        restrictShape(shape, engine.readable(name, ctx)),
      )
      const page = json(
        {
          type: "object",
          properties: {
            data: { type: "array", items: document },
            page: {
              type: "object",
              properties: {
                limit: { type: "integer" },
                next: { type: ["string", "null"] },
                total: { type: "integer" },
              },
              required: ["limit", "next"],
            },
            ct: CT,
          },
          required: ["data", "page", "ct"],
        },
        "One page of documents",
      )
      collectionOps["get"] = op("read", "find", `Find ${name}`, {
        parameters: ["filter", "sort", "fields", "limit", "after", "skip", "count", "prefer"].map(
          param,
        ),
        responses: { "200": page },
      })
      itemOps["get"] = op("read", "get", `Get one of ${name} by _id`, {
        parameters: [param("id"), param("fields")],
        responses: { "200": single("The document") },
      })
      const action = (
        suffix: string,
        id: string,
        summary: string,
        request: Json,
        response: Json,
      ): void => {
        paths[`${collectionPath}/${suffix}`] = {
          post: op("read", id, summary, {
            requestBody: body(request),
            responses: { "200": response },
          }),
        }
      }
      action(
        "_query",
        "query",
        `Find ${name} with the query in the body`,
        {
          type: "object",
          properties: {
            filter: { type: "object" },
            sort: { anyOf: [{ type: "string" }, { type: "object" }] },
            fields: { anyOf: [{ type: "string" }, { type: "object" }] },
            limit: { type: "integer", minimum: 1 },
            skip: { type: "integer", minimum: 0 },
            after: { type: "string" },
            count: { type: "string", enum: ["exact", "estimated"] },
          },
          additionalProperties: false,
        },
        page,
      )
      action(
        "_count",
        "count",
        `Count ${name}`,
        { type: "object", properties: { filter: { type: "object" } }, additionalProperties: false },
        json(
          {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: { count: { type: "integer" }, exact: { type: "boolean" } },
                required: ["count", "exact"],
              },
              ct: CT,
            },
            required: ["data", "ct"],
          },
          "The count",
        ),
      )
      action(
        "_distinct",
        "distinct",
        `Distinct values of a field of ${name}`,
        {
          type: "object",
          properties: { field: { type: "string" }, filter: { type: "object" } },
          required: ["field"],
          additionalProperties: false,
        },
        json(
          {
            type: "object",
            properties: { data: { type: "array" }, ct: CT },
            required: ["data", "ct"],
          },
          "The values",
        ),
      )
      action(
        "_aggregate",
        "aggregate",
        `Aggregate ${name}`,
        {
          type: "object",
          properties: { pipeline: { type: "array", items: { type: "object" } } },
          required: ["pipeline"],
          additionalProperties: false,
        },
        json(
          {
            type: "object",
            properties: { data: { type: "array", items: { type: "object" } }, ct: CT },
            required: ["data", "ct"],
          },
          "The results",
        ),
      )
    }
    if (grants.has("insert")) {
      writes = true
      const writable = restrictShape(shape, engine.writable(name, "insert", ctx))
      const { required, ...insert } = toJsonSchema(writable)
      const kept = Array.isArray(required) ? required.filter((key) => key !== "_id") : []
      schemas[`${component}.Insert`] = kept.length === 0 ? insert : { ...insert, required: kept }
      collectionOps["post"] = op("insert", "insert", `Insert into ${name}`, {
        parameters: [param("prefer"), param("idempotency")],
        requestBody: body({
          anyOf: [
            ref(`${component}.Insert`),
            { type: "array", items: ref(`${component}.Insert`), maxItems: 1000 },
          ],
        }),
        responses: {
          "201": single("The inserted document"),
          "204": { description: "Inserted (return=minimal)" },
        },
      })
    }
    if (grants.has("update")) {
      writes = true
      const merge = { "application/merge-patch+json": { schema: { type: "object" } } }
      itemOps["patch"] = op("update", "update", `Update one of ${name}`, {
        parameters: [param("id"), param("where"), param("prefer"), param("idempotency")],
        requestBody: body(UPDATE, merge),
        responses: {
          "200": single("The updated document"),
          "204": { description: "Updated (return=minimal)" },
        },
      })
      itemOps["put"] = op("update", "replace", `Replace one of ${name}`, {
        parameters: [
          param("id"),
          param("where"),
          param("upsert"),
          param("prefer"),
          param("idempotency"),
        ],
        requestBody: body({ type: "object" }),
        responses: {
          "200": single("The replaced document"),
          "201": single("The upserted document"),
        },
      })
      collectionOps["patch"] = op("update", "updateMany", `Update many of ${name}`, {
        parameters: [param("filter"), param("prefer"), param("idempotency")],
        requestBody: body(UPDATE, merge),
        responses: { "200": json({ type: "object" }, "Matched and modified counts") },
      })
    }
    if (grants.has("delete")) {
      writes = true
      itemOps["delete"] = op("delete", "delete", `Delete one of ${name}`, {
        parameters: [param("id"), param("where"), param("prefer"), param("idempotency")],
        responses: { "200": single("The deleted document") },
      })
      collectionOps["delete"] = op("delete", "deleteMany", `Delete many of ${name}`, {
        parameters: [param("filter"), param("prefer"), param("idempotency")],
        responses: { "200": json({ type: "object" }, "The deleted count") },
      })
    }
    if (Object.keys(collectionOps).length > 0) paths[collectionPath] = collectionOps
    if (Object.keys(itemOps).length > 0) paths[`${collectionPath}/{id}`] = itemOps
  }
  paths[`${base}/`] = {
    get: {
      operationId: "listCollections",
      summary: "Collections the caller can reach",
      responses: { "200": json({ type: "object" }, "The collections"), default: PROBLEM_RESPONSE },
    },
  }
  paths[`${base}/openapi.json`] = {
    get: {
      operationId: "openapi",
      summary: "This document",
      responses: {
        "200": { description: "OpenAPI 3.1", content: { "application/json": { schema: {} } } },
        default: PROBLEM_RESPONSE,
      },
    },
  }
  if (writes)
    paths[`${base}/_batch`] = {
      post: {
        operationId: "batch",
        summary: "Several writes, optionally in one transaction",
        parameters: [param("prefer"), param("idempotency")],
        requestBody: body({
          type: "object",
          properties: {
            atomic: { type: "boolean" },
            ops: { type: "array", items: { type: "object" }, maxItems: 100 },
          },
          required: ["ops"],
        }),
        responses: {
          "200": json({ type: "object" }, "One result per operation"),
          default: PROBLEM_RESPONSE,
        },
      },
    }
  return {
    openapi: "3.1.0",
    info: { title: options.title ?? "Canopy Data API", version: options.version ?? "1" },
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    security: [{ apikey: [] }, { apikey: [], bearer: [] }],
    paths: Object.fromEntries(
      Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    components: {
      schemas,
      parameters: PARAMETERS,
      securitySchemes: {
        apikey: { type: "apiKey", in: "header", name: "apikey" },
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  }
}
