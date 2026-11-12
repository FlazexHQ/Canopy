import { randomUUID } from "node:crypto"
import { fieldAccess, projectReadable, Role } from "@canopy/policy"
import { NotFoundError, ValidationError } from "@canopy/protocol"
import {
  buildOpenApi,
  type Caller,
  findParamsFromQuery,
  parseId,
  type WriteRequest,
} from "@canopy/rest"
import { collectionName } from "../../policy-store.ts"
import { boolean, document, integer, object, optional, string, unknownValue } from "../../schema.ts"
import { json } from "../http.ts"
import { can } from "../rbac.ts"
import { type AdminDeps, type Context, mask, type RouteFn } from "./core.ts"

/** Registers the collection and document routes. */
export function registerData(route: RouteFn, deps: AdminDeps): void {
  const {
    options,
    config,
    policies,
    production,
    app,
    schemas,
    idTypes,
    serviceReads,
    service,
    parseJsonParam,
    impersonate,
    require,
    confirmWrite,
  } = deps
  // Collections

  route("GET", "collections", "collections.read", async () => {
    const engine = options.engine()
    const listed = await app.listCollections({}, { nameOnly: false }).toArray()
    const names = new Set<string>(
      listed.filter((c) => !c.name.startsWith("system.")).map((c) => c.name),
    )
    for (const name of engine.set.collections.keys()) names.add(name)
    const stored = (await policies.all()).stored
    const data = [...names].sort().map((name) => {
      const info = listed.find((c) => c.name === name)
      const def = engine.collection(name)
      return {
        name,
        type: info?.type ?? "missing",
        exists: info !== undefined,
        exposed: def?.exposed === true,
        realtime: def?.realtime === true,
        policies: def?.policies.length ?? 0,
        version: stored.get(name)?.version ?? 0,
        hash: engine.set.hashes.get(name),
      }
    })
    return json({ data })
  })

  route(
    "PATCH",
    "collections/:collection",
    "collections.write",
    async (context) => {
      const collection = collectionName(context.params["collection"] ?? "")
      const body = object({
        exposed: optional(boolean()),
        realtime: optional(boolean()),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      const current = (await policies.all()).definitions.get(collection) ?? {
        collection,
        exposed: false,
        realtime: false,
        policies: [],
      }
      const result = await policies.publish(
        {
          definition: {
            ...current,
            ...(body.exposed === undefined ? {} : { exposed: body.exposed }),
            ...(body.realtime === undefined ? {} : { realtime: body.realtime }),
          },
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        },
        "collection.update",
      )
      return json(result)
    },
    "collection.update",
  )

  route("GET", "collections/:collection/schema", "collections.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const found = await schemas.all([collection])
    return json({ collection, schema: found.get(collection) ?? null })
  })

  route("GET", "openapi", "collections.read", async (context) => {
    if (config.rest === false) throw new NotFoundError("The Data API is turned off")
    const role = context.url.searchParams.get("role") ?? Role.Authenticated
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(role)) throw new ValidationError("role is not a role name")
    const roles = new Set<string>(
      role === Role.Anon || role === Role.Service || role === Role.Authenticated
        ? [role]
        : [Role.Authenticated, role],
    )
    const listed = await app.listCollections({}, { nameOnly: true }).toArray()
    const names = listed.map((c) => c.name).filter((name) => !name.startsWith("system."))
    const engine = options.engine()
    return json(
      buildOpenApi({
        engine,
        ctx: { roles, claims: null, now: new Date() },
        schemas: await schemas.all(names),
        collections: names,
      }),
    )
  })

  route("POST", "graphql", "documents.read", async (context) => {
    const graphql = options.graphql
    if (graphql === undefined) throw new NotFoundError("GraphQL is turned off")
    const body = object({
      query: string({ max: 100_000 }),
      variables: optional(document()),
      operationName: optional(string({ max: 200 })),
      as: optional(unknownValue()),
    }).parse(await context.body())
    let caller: Caller = service
    let impersonated: unknown
    if (body.as !== undefined) {
      require(context, "documents.viewAs")
      const as = await impersonate(body.as, undefined, options.engine())
      caller = { context: as.context, subject: as.subject }
      impersonated = as.as
    }
    const writer = can(context.session.user.role, "documents.write", config.environment)
    const result = await graphql.run(
      caller,
      {
        query: body.query,
        ...(body.variables === undefined ? {} : { variables: body.variables }),
        ...(body.operationName === undefined ? {} : { operationName: body.operationName }),
      },
      {
        signal: context.request.signal,
        mutations: impersonated === undefined && writer && !production,
      },
    )
    if (impersonated !== undefined || result.operation === "mutation")
      await context.audit({
        action: impersonated === undefined ? "graphql.mutation" : "graphql.viewAs",
        target: { operationName: body.operationName ?? null },
        details: {
          query: body.query,
          ...(impersonated === undefined ? {} : { as: impersonated }),
        },
      })
    return json({
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.errors === undefined
        ? {}
        : { errors: result.errors.map((error) => error.toJSON()) }),
    })
  })

  route("GET", "collections/:collection/stats", "collections.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const exists =
      (await app.listCollections({ name: collection }, { nameOnly: true }).toArray()).length > 0
    if (!exists) throw new NotFoundError(`The collection ${collection} does not exist`)
    const [stats] = await app
      .collection(collection)
      .aggregate<{ storageStats?: Record<string, unknown> }>([{ $collStats: { storageStats: {} } }])
      .toArray()
    const storage = stats?.storageStats ?? {}
    const indexes = await app.collection(collection).indexes()
    return json({
      collection,
      documents: storage["count"] ?? 0,
      size: storage["size"] ?? 0,
      averageDocumentSize: storage["avgObjSize"] ?? 0,
      storageSize: storage["storageSize"] ?? 0,
      totalIndexSize: storage["totalIndexSize"] ?? 0,
      indexes: indexes.map((index) => ({
        name: index.name,
        key: index.key,
        unique: index.unique === true,
        ...(index.expireAfterSeconds === undefined
          ? {}
          : { expireAfterSeconds: index.expireAfterSeconds }),
      })),
    })
  })

  // Documents

  const findDocuments = async (context: Context, id?: string): Promise<Response> => {
    const collection = collectionName(context.params["collection"] ?? "")
    const asParam = parseJsonParam(context.url, "as")
    const query = new URLSearchParams()
    for (const [name, value] of context.url.searchParams)
      if (name !== "as" && name !== "count") query.append(name, value)
    const role = context.session.user.role
    let caller: Caller = service
    let impersonated: unknown
    if (asParam !== undefined) {
      require(context, "documents.viewAs")
      const engine = options.engine()
      const as = await impersonate(asParam, collection, engine)
      caller = { context: as.context, subject: as.subject }
      impersonated = as.as
    }
    const reads = serviceReads
    let docs: Record<string, unknown>[]
    let extra: Record<string, unknown> = {}
    if (id === undefined) {
      const params = findParamsFromQuery(query, { maxLimit: 1000, maxSkip: 10_000 }, undefined)
      const result = await reads.find(
        caller,
        {
          collection,
          filter: params.filter,
          ...(params.sort === undefined ? {} : { sort: params.sort }),
          ...(params.fields === undefined ? {} : { fields: params.fields }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.skip === undefined ? {} : { skip: params.skip }),
          ...(params.after === undefined ? {} : { after: params.after }),
        },
        { signal: context.request.signal },
      )
      docs = [...result.docs]
      extra = { page: { limit: result.limit, next: result.next }, ct: result.ct }
    } else {
      const result = await reads.findById(
        caller,
        collection,
        parseId(id, idTypes[collection] ?? "auto"),
        undefined,
        { signal: context.request.signal },
      )
      if (result.doc === null) throw new NotFoundError("Document not found")
      docs = [result.doc]
      extra = { ct: result.ct }
    }
    let masked = false
    if (asParam === undefined && role === "viewer") {
      const access = fieldAccess(
        options.engine().collection(collection)?.fields?.read,
        new Set([Role.Authenticated]),
      )
      docs = docs.map((doc) => mask(doc, projectReadable(access, doc)))
      masked = true
    }
    if (impersonated !== undefined)
      await context.audit({
        action: "documents.viewAs",
        target: { collection, ...(id === undefined ? {} : { id }) },
        details: { as: impersonated, query: Object.fromEntries(query) },
      })
    return json({
      data: id === undefined ? docs : docs[0],
      ...extra,
      ...(masked ? { masked: true } : {}),
    })
  }

  route("GET", "collections/:collection/documents", "documents.read", (context) =>
    findDocuments(context),
  )
  route("GET", "collections/:collection/documents/:id", "documents.read", (context) =>
    findDocuments(context, context.params["id"] ?? ""),
  )

  const writeDocument = async (
    context: Context,
    build: (collection: string, body: unknown) => WriteRequest,
    action: string,
  ): Promise<Response> => {
    const collection = collectionName(context.params["collection"] ?? "")
    confirmWrite(context, collection)
    const body = await context.body()
    const asParam = parseJsonParam(context.url, "as")
    let caller: Caller = service
    let impersonated: unknown
    let reason: string | undefined
    if (asParam !== undefined) {
      require(context, "documents.writeAs")
      reason = context.url.searchParams.get("reason")?.trim()
      if (reason === undefined || reason === "")
        throw new ValidationError("Writing as another caller needs a reason")
      const as = await impersonate(asParam, collection, options.engine())
      caller = { context: as.context, subject: as.subject }
      impersonated = as.as
    }
    const request = build(collection, body)
    const before =
      "id" in request
        ? await app.collection(collection).findOne({ _id: request.id as never })
        : undefined
    const result = await options.writes.execute(caller, request, { mutationId: randomUUID() })
    await context.audit({
      action: impersonated === undefined ? action : `${action}As`,
      target: {
        collection,
        ids: result.changedIds.length > 0 ? result.changedIds : result.insertedIds,
      },
      diff: { before: before ?? null, after: result.documents?.[0] ?? null },
      ...(reason === undefined ? {} : { comment: reason }),
      ...(impersonated === undefined ? {} : { details: { as: impersonated } }),
    })
    return json(
      {
        data: result.documents?.[0] ?? null,
        matched: result.matched,
        modified: result.modified,
        deleted: result.deleted,
        insertedIds: result.insertedIds,
        ct: result.ct,
      },
      request.op === "insert" ? 201 : 200,
    )
  }

  const idOf = (context: Context, collection: string): unknown =>
    parseId(context.params["id"] ?? "", idTypes[collection] ?? "auto")

  route(
    "POST",
    "collections/:collection/documents",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection, doc) => ({ op: "insert", collection, doc }),
        "documents.insert",
      ),
    "documents.insert",
  )
  route(
    "PATCH",
    "collections/:collection/documents/:id",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection, update) => ({
          op: "update",
          collection,
          id: idOf(context, collection),
          update,
        }),
        "documents.update",
      ),
    "documents.update",
  )
  route(
    "PUT",
    "collections/:collection/documents/:id",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection, doc) => ({ op: "replace", collection, id: idOf(context, collection), doc }),
        "documents.replace",
      ),
    "documents.replace",
  )
  route(
    "DELETE",
    "collections/:collection/documents/:id",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection) => ({ op: "delete", collection, id: idOf(context, collection) }),
        "documents.delete",
      ),
    "documents.delete",
  )
}
