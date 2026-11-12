import type { PolicyEngine, RequestContext } from "@canopy/policy"
import type { ClusterTime, SubQuery } from "@canopy/protocol"
import type {
  FindRequest,
  FindResult,
  ReturnedDocument,
  WriteRequest,
  WriteResult,
} from "@canopy/rest"
import {
  type CollectionSchema,
  type Field,
  type ObjectShape,
  restrictShape,
  type Shape,
} from "@canopy/schema"
import {
  type GraphQLArgumentConfig,
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLEnumValueConfigMap,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  type GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
} from "graphql"
import {
  type FieldMap,
  toMongoDocument,
  toMongoFilter,
  toMongoSort,
  toMongoUpdate,
} from "./filters.ts"
import { type CollectionNames, collectionNames, fieldName, pascalCase } from "./names.ts"
import { SCALARS } from "./scalars.ts"

/** A relation between two collections, declared in config. */
export interface RelationConfig {
  /** The target collection. */
  readonly to: string
  /** The field of this collection that holds the key. */
  readonly local: string
  /** The field of the target collection the key is matched against. Defaults to `_id`. */
  readonly foreign?: string
  /** Whether many target documents may match, so the field is a list. Defaults to `false`. */
  readonly many?: boolean
}

/** GraphQL settings of one collection. */
export interface CollectionGraphqlConfig {
  /** Overrides the singular type name, such as `Person` for `people`. */
  readonly typeName?: string
  /** Relations by GraphQL field name. */
  readonly relations?: Readonly<Record<string, RelationConfig>>
}

/** A resolved relation, the key of its batch loader. */
export interface RelationSpec {
  /** A stable key of the relation, used to batch lookups. */
  readonly key: string
  readonly to: string
  readonly foreign: string
  readonly many: boolean
}

/** One change of a live query, as `todoChanges` delivers it. */
export interface LiveChange {
  readonly kind: "ADDED" | "CHANGED" | "REMOVED" | "READY"
  readonly id?: unknown
  readonly doc?: ReturnedDocument
  readonly index?: number
}

/**
 * What resolvers need for one request: the caller's data access, with DLS applied by the read and write
 * paths. The handler builds it; tests can fake it.
 */
export interface RequestServices {
  find(request: FindRequest): Promise<FindResult>
  findById(collection: string, id: unknown): Promise<ReturnedDocument | null>
  count(collection: string, filter: unknown): Promise<number>
  write(request: WriteRequest): Promise<WriteResult>
  /** Loads related documents, batching every key of one relation requested in the same tick. */
  related(relation: RelationSpec, key: unknown, limit: number): Promise<ReturnedDocument[]>
  /** Follows a live query: the full result on every change. Absent when realtime is off. */
  live?(collection: string, query: SubQuery, signal: AbortSignal): AsyncIterable<LiveResult>
}

/** The state of a live query at one point. */
export interface LiveResult {
  readonly docs: readonly ReturnedDocument[]
  readonly ct?: ClusterTime
}

/** The GraphQL context Canopy resolvers read. */
export interface CanopyContext {
  readonly canopy: RequestServices
}

/** What {@link buildSchema} builds from. */
export interface SchemaInput {
  readonly engine: PolicyEngine
  readonly ctx: RequestContext
  /** The collections the caller can reach, in a stable order. */
  readonly collections: readonly string[]
  readonly schemas: ReadonlyMap<string, CollectionSchema>
  readonly config?: Readonly<Record<string, CollectionGraphqlConfig>>
  /** Whether live queries are available (realtime is on). */
  readonly subscriptions: boolean
  /** The default and largest `limit` of list queries. */
  readonly defaultLimit?: number
  readonly maxLimit?: number
}

type Source = Readonly<Record<string, unknown>>
type Resolver = GraphQLFieldConfig<Source, CanopyContext>
type Args = Readonly<Record<string, unknown>>

const OPEN: ObjectShape = { kind: "object", fields: {}, open: true }
const RESERVED_FILTER = new Set(["and", "or", "nor", "raw"])

function scalarOf(shape: Shape): GraphQLScalarType | undefined {
  if (shape.kind === "scalar") {
    switch (shape.type) {
      case "string":
        return GraphQLString
      case "int":
        return GraphQLInt
      case "double":
        return GraphQLFloat
      case "bool":
        return GraphQLBoolean
      case "long":
        return SCALARS.Long
      case "decimal":
        return SCALARS.Decimal
      case "date":
        return SCALARS.DateTime
      case "objectId":
        return SCALARS.ObjectId
      case "binData":
        return SCALARS.Binary
      default:
        return undefined
    }
  }
  if (shape.kind === "union") {
    const present = shape.of.filter(
      (member) => !(member.kind === "scalar" && member.type === "null"),
    )
    if (present.length === 1 && present[0] !== undefined) return scalarOf(present[0])
    if (
      present.length > 0 &&
      present.every(
        (member) => member.kind === "scalar" && (member.type === "int" || member.type === "double"),
      )
    )
      return GraphQLFloat
  }
  return undefined
}

function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap)
  if (value !== null && typeof value === "object") {
    const tag = (value as { _bsontype?: unknown })._bsontype
    if (tag === "Int32" || tag === "Double") return (value as { value: unknown }).value
  }
  return value
}

function selects(info: GraphQLResolveInfo, name: string): boolean {
  return info.fieldNodes.some(
    (node) =>
      node.selectionSet?.selections.some(
        (selection) => selection.kind === "Field" && selection.name.value === name,
      ) === true,
  )
}

interface CollectionModel {
  readonly name: string
  readonly names: CollectionNames
  readonly type: GraphQLObjectType
  readonly idType: GraphQLInputType
  readonly map: FieldMap
  filter: GraphQLInputObjectType
  readonly sort: GraphQLInputObjectType | undefined
}

/**
 * Builds the GraphQL schema one role set sees: a type per collection the caller can read, with only the
 * fields its roles may read, queries and mutations for the operations its policies grant, relations to
 * readable collections, and live queries when realtime is on. Every resolver goes through
 * {@link RequestServices}, so DLS is applied by the same read and write paths as REST.
 */
export function buildSchema(input: SchemaInput): GraphQLSchema {
  const { engine, ctx } = input
  const defaultLimit = input.defaultLimit ?? 100
  const maxLimit = input.maxLimit ?? 1000
  const used = new Set<string>([
    "Query",
    "Mutation",
    "Subscription",
    "SortDirection",
    "BulkResult",
    "ChangeKind",
    ...Object.keys(SCALARS),
  ])
  const unique = (name: string): string => {
    let candidate = name
    for (let n = 2; used.has(candidate); n += 1) candidate = `${name}${n}`
    used.add(candidate)
    return candidate
  }

  const sortDirection = new GraphQLEnumType({
    name: "SortDirection",
    values: { ASC: { value: "ASC" }, DESC: { value: "DESC" } },
  })
  const bulkResult = new GraphQLObjectType({
    name: "BulkResult",
    description: "The outcome of a bulk write.",
    fields: {
      matched: { type: new GraphQLNonNull(GraphQLInt) },
      modified: { type: new GraphQLNonNull(GraphQLInt) },
      deleted: { type: new GraphQLNonNull(GraphQLInt) },
      ct: { type: new GraphQLNonNull(GraphQLString), description: "Cluster time of the commit" },
    },
  })
  const changeKind = new GraphQLEnumType({
    name: "ChangeKind",
    values: { ADDED: {}, CHANGED: {}, REMOVED: {}, READY: {} },
  })

  const scalarFilters = new Map<string, GraphQLInputObjectType>()
  const scalarFilter = (scalar: GraphQLScalarType): GraphQLInputObjectType => {
    const existing = scalarFilters.get(scalar.name)
    if (existing !== undefined) return existing
    const fields: GraphQLInputFieldConfigMap = {
      eq: { type: scalar },
      ne: { type: scalar },
      in: { type: new GraphQLList(new GraphQLNonNull(scalar)) },
      nin: { type: new GraphQLList(new GraphQLNonNull(scalar)) },
      exists: { type: GraphQLBoolean },
    }
    if (scalar !== GraphQLBoolean) {
      fields["gt"] = { type: scalar }
      fields["gte"] = { type: scalar }
      fields["lt"] = { type: scalar }
      fields["lte"] = { type: scalar }
    }
    if (scalar === GraphQLString) {
      fields["regex"] = { type: GraphQLString }
      fields["options"] = {
        type: GraphQLString,
        description: "Regular expression options such as i",
      }
    }
    const type = new GraphQLInputObjectType({ name: unique(`${scalar.name}Filter`), fields })
    scalarFilters.set(scalar.name, type)
    return type
  }

  const outputType = (shape: Shape, owner: string, field: string): GraphQLOutputType => {
    const scalar = scalarOf(shape)
    if (scalar !== undefined) return scalar
    if (shape.kind === "array") {
      const item = outputType(shape.items, owner, field)
      return new GraphQLList(item)
    }
    if (shape.kind === "object" && Object.keys(shape.fields).length > 0)
      return objectType(shape, unique(`${owner}${pascalCase(field)}`))
    return SCALARS.JSON
  }

  const objectFields = (
    shape: ObjectShape,
    owner: string,
    extra: () => GraphQLFieldConfigMap<Source, CanopyContext> = () => ({}),
  ): (() => GraphQLFieldConfigMap<Source, CanopyContext>) => {
    const entries: [string, string, Field][] = []
    const taken = new Set<string>()
    for (const [name, field] of Object.entries(shape.fields)) {
      let gql = fieldName(name)
      while (taken.has(gql)) gql = `${gql}_`
      taken.add(gql)
      entries.push([gql, name, field])
    }
    const resolved = entries.map(([gql, name, field]) => {
      const type = outputType(field.shape, owner, gql)
      const config: Resolver = {
        type: name === "_id" ? new GraphQLNonNull(type) : type,
        resolve: (source) => unwrap(source[name]),
      }
      return [gql, config] as const
    })
    return () => ({ ...Object.fromEntries(resolved), ...extra() })
  }

  const objectType = (shape: ObjectShape, name: string): GraphQLObjectType =>
    new GraphQLObjectType<Source, CanopyContext>({ name, fields: objectFields(shape, name) })

  const inputType = (shape: Shape): GraphQLInputType => {
    const scalar = scalarOf(shape)
    if (scalar !== undefined) return scalar
    if (shape.kind === "array") {
      const item = scalarOf(shape.items)
      if (item !== undefined) return new GraphQLList(item)
    }
    return SCALARS.JSON
  }

  const models = new Map<string, CollectionModel>()
  const query: GraphQLFieldConfigMap<Source, CanopyContext> = {}
  const mutation: GraphQLFieldConfigMap<Source, CanopyContext> = {}
  const subscription: GraphQLFieldConfigMap<Source, CanopyContext> = {}
  const relationFields = new Map<string, () => GraphQLFieldConfigMap<Source, CanopyContext>>()

  const readableNames = input.collections.filter((name) => engine.hasGrant(name, "read", ctx))
  for (const name of readableNames) {
    const config = input.config?.[name]
    const base = collectionNames(name, config?.typeName)
    const typeName = unique(base.type)
    const names: CollectionNames = { ...base, type: typeName }
    const shape = restrictShape(input.schemas.get(name)?.shape ?? OPEN, engine.readable(name, ctx))
    const withId: ObjectShape =
      shape.fields["_id"] === undefined
        ? { ...shape, fields: { _id: { shape: { kind: "any" }, required: true }, ...shape.fields } }
        : shape
    const fields = new Map<string, string>()
    const taken = new Set<string>(RESERVED_FILTER)
    for (const field of Object.keys(withId.fields)) {
      let gql = fieldName(field)
      while (taken.has(gql)) gql = `${gql}_`
      taken.add(gql)
      fields.set(gql, field)
    }
    const map: FieldMap = { fields }
    const type = new GraphQLObjectType<Source, CanopyContext>({
      name: typeName,
      description: `A document of the ${name} collection.`,
      fields: objectFields(withId, typeName, () => relationFields.get(name)?.() ?? {}),
    })
    const idShape = withId.fields["_id"]?.shape ?? { kind: "any" }
    const idType = inputType(idShape)
    const filterFields: GraphQLInputFieldConfigMap = {}
    const sortValues: GraphQLEnumValueConfigMap = {}
    for (const [gql, field] of fields) {
      const fieldShape = withId.fields[field]?.shape ?? { kind: "any" }
      const element = fieldShape.kind === "array" ? fieldShape.items : fieldShape
      const scalar = scalarOf(element)
      filterFields[gql] = { type: scalarFilter(scalar ?? SCALARS.JSON) }
      if (scalar !== undefined && fieldShape.kind !== "array") sortValues[gql] = { value: field }
    }
    const model: CollectionModel = {
      name,
      names,
      type,
      idType,
      map,
      filter: new GraphQLInputObjectType({ name: "Placeholder", fields: {} }),
      sort:
        Object.keys(sortValues).length === 0
          ? undefined
          : new GraphQLInputObjectType({
              name: unique(`${typeName}Sort`),
              fields: {
                field: {
                  type: new GraphQLNonNull(
                    new GraphQLEnumType({
                      name: unique(`${typeName}SortField`),
                      values: sortValues,
                    }),
                  ),
                },
                direction: { type: sortDirection, defaultValue: "ASC" },
              },
            }),
    }
    const filterName = unique(`${typeName}Filter`)
    model.filter = new GraphQLInputObjectType({
      name: filterName,
      fields: () => ({
        and: { type: new GraphQLList(new GraphQLNonNull(model.filter)) },
        or: { type: new GraphQLList(new GraphQLNonNull(model.filter)) },
        nor: { type: new GraphQLList(new GraphQLNonNull(model.filter)) },
        ...filterFields,
        raw: {
          type: SCALARS.JSON,
          description: "An Extended JSON filter, validated like REST filters",
        },
      }),
    })
    models.set(name, model)
  }

  const listArgs = (model: CollectionModel): Record<string, GraphQLArgumentConfig> => ({
    filter: { type: model.filter },
    ...(model.sort === undefined
      ? {}
      : { sort: { type: new GraphQLList(new GraphQLNonNull(model.sort)) } }),
    limit: { type: GraphQLInt, defaultValue: defaultLimit },
  })

  const findRequest = (model: CollectionModel, args: Args): FindRequest => {
    const sort = toMongoSort(args["sort"] as Parameters<typeof toMongoSort>[0])
    const limit = args["limit"]
    return {
      collection: model.name,
      filter: toMongoFilter(args["filter"] as Args | undefined, model.map),
      ...(sort === undefined ? {} : { sort }),
      ...(typeof limit === "number" ? { limit: Math.min(limit, maxLimit) } : {}),
      ...(typeof args["after"] === "string" ? { after: args["after"] } : {}),
      ...(typeof args["skip"] === "number" ? { skip: args["skip"] } : {}),
    }
  }

  for (const model of models.values()) {
    const { name, names, type } = model
    const config = input.config?.[name]
    const relations: Resolved[] = []
    for (const [field, relation] of Object.entries(config?.relations ?? {})) {
      const target = models.get(relation.to)
      if (target === undefined) continue
      relations.push({
        gql: fieldName(field),
        local: relation.local,
        target,
        spec: {
          key: `${name}.${field}`,
          to: relation.to,
          foreign: relation.foreign ?? "_id",
          many: relation.many === true,
        },
      })
    }
    if (relations.length > 0)
      relationFields.set(name, () => relationConfigs(relations, defaultLimit, maxLimit))

    const connection = new GraphQLObjectType<Source, CanopyContext>({
      name: unique(`${names.type}Connection`),
      description: `One page of ${name}.`,
      fields: {
        nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type))) },
        next: {
          type: GraphQLString,
          description: "The cursor of the next page, or null on the last",
        },
        total: { type: GraphQLInt, description: "Every matching document, counted when selected" },
        ct: { type: new GraphQLNonNull(GraphQLString), description: "The snapshot's cluster time" },
      },
    })
    query[names.list] = {
      type: new GraphQLNonNull(connection),
      args: { ...listArgs(model), after: { type: GraphQLString }, skip: { type: GraphQLInt } },
      resolve: async (_source, args, context, info) => {
        const wantsTotal = selects(info, "total")
        const result = await context.canopy.find({
          ...findRequest(model, args),
          ...(wantsTotal ? { count: "exact" as const } : {}),
        })
        return { nodes: result.docs, next: result.next, total: result.total ?? null, ct: result.ct }
      },
    }
    query[names.one] = {
      type,
      args: { id: { type: new GraphQLNonNull(model.idType) } },
      resolve: (_source, args, context) => context.canopy.findById(name, args["id"]),
    }
    query[names.count] = {
      type: new GraphQLNonNull(GraphQLInt),
      args: { filter: { type: model.filter } },
      resolve: (_source, args, context) =>
        context.canopy.count(name, toMongoFilter(args["filter"] as Args | undefined, model.map)),
    }

    addMutations(model)

    if (input.subscriptions && engine.isRealtime(name)) {
      subscription[`live${names.plural}`] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type))),
        description: `The full result of a ${name} query, sent again on every change.`,
        args: listArgs(model),
        subscribe: (_source, args, context) =>
          liveDocuments(context, name, findRequest(model, args)),
        resolve: (payload: unknown) => (payload as LiveResult).docs,
      }
      const change = new GraphQLObjectType<LiveChange, CanopyContext>({
        name: unique(`${names.type}Change`),
        fields: {
          kind: { type: new GraphQLNonNull(changeKind) },
          id: { type: SCALARS.JSON },
          doc: { type: type as GraphQLObjectType },
          index: { type: GraphQLInt },
        },
      })
      subscription[`${names.one}Changes`] = {
        type: new GraphQLNonNull(change),
        description: `Changes of a ${name} query: added, changed and removed documents, then ready.`,
        args: listArgs(model),
        subscribe: (_source, args, context) =>
          liveChanges(liveDocuments(context, name, findRequest(model, args))),
        resolve: (payload: unknown) => payload,
      }
    }
  }

  function addMutations(model: CollectionModel): void {
    const { name, names, type, map } = model
    const grants = {
      insert: engine.hasGrant(name, "insert", ctx),
      update: engine.hasGrant(name, "update", ctx),
      delete: engine.hasGrant(name, "delete", ctx),
    }
    if (!grants.insert && !grants.update && !grants.delete) return
    const id = { type: new GraphQLNonNull(model.idType) }
    const where = { type: model.filter }
    const single = (result: WriteResult): ReturnedDocument | null => result.documents?.[0] ?? null
    const bulk = (result: WriteResult): Source => ({
      matched: result.matched,
      modified: result.modified,
      deleted: result.deleted,
      ct: result.ct,
    })
    const source = input.schemas.get(name)
    const strict = source?.source === "validator"
    const writableInput = (op: "insert" | "update", typeSuffix: string, requireFields: boolean) => {
      const shape = restrictShape(source?.shape ?? OPEN, engine.writable(name, op, ctx))
      const fields: GraphQLInputFieldConfigMap = {}
      const writeMap = new Map<string, string>()
      for (const [field, spec] of Object.entries(shape.fields)) {
        if (op === "update" && field === "_id") continue
        const gql = fieldName(field)
        if (fields[gql] !== undefined || gql === "_extra") continue
        writeMap.set(gql, field)
        const typeOf = inputType(spec.shape)
        fields[gql] = {
          type:
            requireFields && strict && spec.required && field !== "_id"
              ? new GraphQLNonNull(typeOf)
              : typeOf,
        }
      }
      if (op === "insert" && fields["_id"] === undefined) {
        fields["_id"] = { type: model.idType }
        writeMap.set("_id", "_id")
      }
      if (shape.open)
        fields["_extra"] = { type: SCALARS.JSON, description: "More fields, as Extended JSON" }
      return {
        type:
          Object.keys(fields).length === 0
            ? undefined
            : new GraphQLInputObjectType({ name: unique(`${names.type}${typeSuffix}`), fields }),
        map: { fields: writeMap } satisfies FieldMap,
        shape,
      }
    }

    if (grants.insert || grants.update) {
      const insert = writableInput("insert", "Insert", true)
      const doc = insert.type ?? SCALARS.JSON
      const toDoc = (value: unknown): Record<string, unknown> =>
        insert.type === undefined
          ? (value as Record<string, unknown>)
          : toMongoDocument(value as Args, insert.map)
      if (grants.insert) {
        mutation[`insert${names.singular}`] = {
          type,
          args: { doc: { type: new GraphQLNonNull(doc) } },
          resolve: async (_source, args, context) =>
            single(
              await context.canopy.write({
                op: "insert",
                collection: name,
                doc: toDoc(args["doc"]),
              }),
            ),
        }
        mutation[`insert${names.plural}`] = {
          type: new GraphQLNonNull(new GraphQLList(type)),
          args: { docs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(doc))) } },
          resolve: async (_source, args, context) => {
            const docs = (args["docs"] as readonly unknown[]).map(toDoc)
            const result = await context.canopy.write({ op: "insertMany", collection: name, docs })
            return result.documents ?? []
          },
        }
      }
      if (grants.update) {
        mutation[`replace${names.singular}`] = {
          type,
          args: {
            id,
            doc: { type: new GraphQLNonNull(doc) },
            where,
            upsert: { type: GraphQLBoolean },
          },
          resolve: async (_source, args, context) =>
            single(
              await context.canopy.write({
                op: "replace",
                collection: name,
                id: args["id"],
                doc: toDoc(args["doc"]),
                ...(args["where"] === undefined || args["where"] === null
                  ? {}
                  : { where: toMongoFilter(args["where"] as Args, map) }),
                ...(args["upsert"] === true ? { upsert: true } : {}),
              }),
            ),
        }
      }
    }

    if (grants.update) {
      const set = writableInput("update", "Set", false)
      const numeric: GraphQLInputFieldConfigMap = {}
      const unsetValues: GraphQLEnumValueConfigMap = {}
      for (const [gql, field] of set.map.fields) {
        unsetValues[gql] = { value: field }
        const scalar = scalarOf(set.shape.fields[field]?.shape ?? { kind: "any" })
        if (
          scalar === GraphQLInt ||
          scalar === GraphQLFloat ||
          scalar === SCALARS.Long ||
          scalar === SCALARS.Decimal
        )
          numeric[gql] = { type: scalar }
      }
      const updateFields: GraphQLInputFieldConfigMap = {
        raw: { type: SCALARS.JSON, description: "Extended JSON update operators" },
      }
      if (set.type !== undefined) updateFields["set"] = { type: set.type }
      if (Object.keys(numeric).length > 0)
        updateFields["inc"] = {
          type: new GraphQLInputObjectType({ name: unique(`${names.type}Inc`), fields: numeric }),
        }
      if (Object.keys(unsetValues).length > 0)
        updateFields["unset"] = {
          type: new GraphQLList(
            new GraphQLNonNull(
              new GraphQLEnumType({ name: unique(`${names.type}Field`), values: unsetValues }),
            ),
          ),
        }
      const update = new GraphQLInputObjectType({
        name: unique(`${names.type}Update`),
        fields: updateFields,
      })
      const toUpdate = (value: unknown): Record<string, unknown> =>
        toMongoUpdate(value as Args, set.map)
      mutation[`update${names.singular}`] = {
        type,
        args: { id, update: { type: new GraphQLNonNull(update) }, where },
        resolve: async (_source, args, context) =>
          single(
            await context.canopy.write({
              op: "update",
              collection: name,
              id: args["id"],
              update: toUpdate(args["update"]),
              ...(args["where"] === undefined || args["where"] === null
                ? {}
                : { where: toMongoFilter(args["where"] as Args, map) }),
            }),
          ),
      }
      mutation[`update${names.plural}`] = {
        type: new GraphQLNonNull(bulkResult),
        args: {
          filter: { type: new GraphQLNonNull(model.filter) },
          update: { type: new GraphQLNonNull(update) },
        },
        resolve: async (_source, args, context) =>
          bulk(
            await context.canopy.write({
              op: "updateMany",
              collection: name,
              filter: toMongoFilter(args["filter"] as Args, map),
              update: toUpdate(args["update"]),
              bulk: true,
            }),
          ),
      }
    }

    if (grants.delete) {
      mutation[`delete${names.singular}`] = {
        type,
        args: { id, where },
        resolve: async (_source, args, context) =>
          single(
            await context.canopy.write({
              op: "delete",
              collection: name,
              id: args["id"],
              ...(args["where"] === undefined || args["where"] === null
                ? {}
                : { where: toMongoFilter(args["where"] as Args, map) }),
            }),
          ),
      }
      mutation[`delete${names.plural}`] = {
        type: new GraphQLNonNull(bulkResult),
        args: { filter: { type: new GraphQLNonNull(model.filter) } },
        resolve: async (_source, args, context) =>
          bulk(
            await context.canopy.write({
              op: "deleteMany",
              collection: name,
              filter: toMongoFilter(args["filter"] as Args, map),
              bulk: true,
            }),
          ),
      }
    }
  }

  if (Object.keys(query).length === 0)
    query["_empty"] = {
      type: GraphQLBoolean,
      description: "Present because the caller can read no collection",
      resolve: () => null,
    }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: query }),
    ...(Object.keys(mutation).length === 0
      ? {}
      : { mutation: new GraphQLObjectType({ name: "Mutation", fields: mutation }) }),
    ...(Object.keys(subscription).length === 0
      ? {}
      : { subscription: new GraphQLObjectType({ name: "Subscription", fields: subscription }) }),
    types: Object.values(SCALARS),
  })
}

interface Resolved {
  readonly gql: string
  readonly local: string
  readonly target: CollectionModel
  readonly spec: RelationSpec
}

function relationConfigs(
  relations: readonly Resolved[],
  defaultLimit: number,
  maxLimit: number,
): GraphQLFieldConfigMap<Source, CanopyContext> {
  const out: GraphQLFieldConfigMap<Source, CanopyContext> = {}
  for (const { gql, local, target, spec } of relations) {
    out[gql] = spec.many
      ? {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(target.type))),
          description: `Documents of ${spec.to} whose ${spec.foreign} matches ${local}.`,
          args: { limit: { type: GraphQLInt, defaultValue: defaultLimit } },
          resolve: (source, args, context) => {
            const key = source[local]
            if (key === undefined || key === null) return []
            const limit = Math.min(Number(args["limit"] ?? defaultLimit), maxLimit)
            return context.canopy.related(spec, key, limit)
          },
        }
      : {
          type: target.type,
          description: `The document of ${spec.to} whose ${spec.foreign} matches ${local}.`,
          resolve: async (source, _args, context) => {
            const key = source[local]
            if (key === undefined || key === null) return null
            const [doc] = await context.canopy.related(spec, key, 1)
            return doc ?? null
          },
        }
  }
  return out
}

function liveDocuments(
  context: CanopyContext,
  collection: string,
  request: FindRequest,
): AsyncIterable<LiveResult> {
  const live = context.canopy.live
  if (live === undefined) throw new TypeError("Live queries need realtime")
  const query: SubQuery = {
    filter: (request.filter ?? {}) as NonNullable<SubQuery["filter"]>,
    ...(request.sort === undefined ? {} : { sort: request.sort as NonNullable<SubQuery["sort"]> }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  }
  const controller = new AbortController()
  const source = live.call(context.canopy, collection, query, controller.signal)
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]()
      return {
        next: () => iterator.next(),
        return: async (value?: unknown) => {
          controller.abort()
          await iterator.return?.(value)
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/** Turns successive full results into added, changed and removed deltas, with a `READY` after the first. */
export async function* liveChanges(results: AsyncIterable<LiveResult>): AsyncGenerator<LiveChange> {
  let previous: Map<string, { doc: ReturnedDocument; index: number }> | undefined
  const keyOf = (doc: ReturnedDocument): string =>
    JSON.stringify(SCALARS.JSON.serialize(doc["_id"]))
  for await (const result of results) {
    const current = new Map<string, { doc: ReturnedDocument; index: number }>()
    for (const [index, doc] of result.docs.entries()) current.set(keyOf(doc), { doc, index })
    const first = previous === undefined
    for (const [key, entry] of previous ?? []) {
      if (!current.has(key)) yield { kind: "REMOVED", id: entry.doc["_id"], index: entry.index }
    }
    for (const [key, entry] of current) {
      const before = previous?.get(key)
      if (before === undefined)
        yield { kind: "ADDED", id: entry.doc["_id"], doc: entry.doc, index: entry.index }
      else if (before.doc !== entry.doc || before.index !== entry.index)
        yield { kind: "CHANGED", id: entry.doc["_id"], doc: entry.doc, index: entry.index }
    }
    if (first) yield { kind: "READY" }
    previous = current
  }
}
