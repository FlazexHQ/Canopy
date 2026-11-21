import {
  type Authenticator,
  credentialsFromHeaders,
  type RateLimits,
  retryAfterSeconds,
} from "@canopy/auth"
import { type ContextResolver, type PolicyEngine, Role } from "@canopy/policy"
import {
  CanopyError,
  decode,
  ErrorCode,
  ForbiddenError,
  sha256Hex,
  toCanonical,
  trimTrailingSlashes,
} from "@canopy/protocol"
import type {
  Caller,
  CorsOptions,
  FindResult,
  ReadPath,
  ReturnedDocument,
  SchemaCache,
  WritePath,
} from "@canopy/rest"
import {
  BREAK,
  type DocumentNode,
  type ExecutionResult,
  GraphQLError,
  type GraphQLSchema,
  Kind,
  type OperationDefinitionNode,
  visit,
} from "graphql"
import { createYoga, type Plugin, type YogaServerInstance } from "graphql-yoga"
import { checkOperation, DEFAULT_OPERATION_LIMITS, type OperationLimits } from "./limits.ts"
import {
  type LiveCredentials,
  LiveQueries,
  type RealtimeConnector,
  type RemoteRealtime,
} from "./live.ts"
import {
  buildSchema,
  type CanopyContext,
  type CollectionGraphqlConfig,
  type RelationSpec,
  type RequestServices,
} from "./schema.ts"

/** Who may run introspection queries. */
export type IntrospectionMode = "always" | "authenticated" | "never"

/** Persisted operations: an allowlist of documents by the hex SHA-256 of their text. */
export interface PersistedOperations {
  /** Documents by hash, as clients send them in `extensions.persistedQuery.sha256Hash`. */
  readonly operations: Readonly<Record<string, string>>
  /** Refuses every document that is not in `operations`. Defaults to `false`. */
  readonly only?: boolean
}

/** Options for {@link createGraphqlHandler}. */
export interface GraphqlHandlerOptions {
  /** The read path of the Data API (`rest.reads`), so GraphQL reads apply the same DLS. */
  readonly reads: ReadPath
  /** The write path of the Data API (`rest.writes`). */
  readonly writes: WritePath
  /** The policy engine, or a function returning the current one when policies are hot reloaded. */
  readonly policies: PolicyEngine | (() => PolicyEngine)
  readonly authenticator: Authenticator
  /** Resolves context lookups (`$ctx`); share the realtime engine's resolver. */
  readonly contexts: ContextResolver
  /** Collection schemas, shared with the OpenAPI document. */
  readonly schemas: SchemaCache
  /**
   * The realtime engine in this process, or a realtime server in another one. Without either the schema has no
   * subscriptions.
   */
  readonly realtime?: RealtimeConnector | RemoteRealtime
  /** Type names and relations per collection. */
  readonly collections?: Readonly<Record<string, CollectionGraphqlConfig>>
  /** The endpoint. Defaults to `/graphql/v1`. */
  readonly path?: string
  readonly limits?: Partial<OperationLimits>
  /** The most operations in one batched request. Defaults to 10. */
  readonly maxBatch?: number
  /** The largest request body in bytes. Defaults to 1 MiB, like the Data API. */
  readonly maxBodyBytes?: number
  /** Defaults to `always`; the server uses `authenticated` in production, so `anon` cannot introspect. */
  readonly introspection?: IntrospectionMode
  readonly persisted?: PersistedOperations
  readonly cors?: CorsOptions
  /**
   * Limits requests per caller. A caller over its budget gets `429` with `Retry-After` and
   * `CANOPY_RATE_LIMITED`; over graphql-ws the operation fails with the same code. A batched request
   * costs one token. Counted in memory, so each instance limits on its own.
   */
  readonly rateLimits?: RateLimits
  /** Called for every request or operation the rate limits refused, for metrics. */
  readonly onRateLimited?: () => void
  /** Called with every unexpected error, for logging. */
  readonly onError?: (error: unknown) => void
}

/** A GraphQL handler built on the Web `Request` and `Response` types. */
export interface GraphqlHandler {
  /**
   * Serves one request on the endpoint (queries, mutations, and subscriptions over SSE). `info.ip` is the
   * socket peer, which the rate limits turn into the client address.
   */
  fetch(request: Request, info?: { readonly ip?: string }): Promise<Response>
  /** The endpoint path. */
  readonly path: string
  /**
   * Prepares an operation for another transport, such as graphql-ws: authenticates the request, picks
   * the caller's schema, parses, validates and checks limits. Returns errors instead of throwing.
   */
  prepare(
    request: Request,
    params: OperationParams,
    info?: { readonly ip?: string },
  ): Promise<PreparedOperation>
  /** The schema a request sees. */
  schemaFor(request: Request): Promise<GraphQLSchema>
  /**
   * Runs a query or mutation for a caller that is already authenticated, such as an admin acting as
   * `service` or impersonating a role. Subscriptions are refused (they need a transport), and so are
   * mutations when `mutations` is `false`. Never throws: failures are in `errors`.
   */
  run(caller: Caller, params: OperationParams, options?: RunOptions): Promise<RunResult>
  /** Ends every live query. */
  close(): void
}

/** Options of {@link GraphqlHandler.run}. */
export interface RunOptions {
  readonly signal?: AbortSignal
  /** Whether mutations may run. Defaults to `true`. */
  readonly mutations?: boolean
}

/** The outcome of {@link GraphqlHandler.run}. */
export interface RunResult {
  readonly data?: Readonly<Record<string, unknown>> | null
  readonly errors?: readonly GraphQLError[]
  /** The kind of operation that ran, when the document could be parsed. */
  readonly operation?: "query" | "mutation" | "subscription"
}

/** The parameters of one GraphQL operation. */
export interface OperationParams {
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>> | null
  readonly operationName?: string | null
  readonly extensions?: Readonly<Record<string, unknown>> | null
}

/** An operation ready to execute, or the errors that stop it. */
export type PreparedOperation =
  | {
      readonly ok: true
      readonly schema: GraphQLSchema
      readonly document: DocumentNode
      readonly contextValue: CanopyContext
      readonly variableValues: Readonly<Record<string, unknown>> | undefined
      readonly operationName: string | undefined
    }
  | { readonly ok: false; readonly errors: readonly GraphQLError[] }

interface Session {
  readonly caller: Caller
  readonly credentials: LiveCredentials
  /** The stored API key the request used, when it used one. */
  readonly keyId?: string | undefined
}

/** The context of one request: the session and how many root fields the operation writes. */
interface RequestContext extends CanopyContext {
  readonly session: Session
  /** The `Idempotency-Key`, honored when the operation is a single mutation. */
  readonly idempotencyKey: string | undefined
  /** Shared by reference, because Yoga copies the context's properties into its own object. */
  readonly operation: { rootMutations: number }
}

const schedule: (callback: () => void) => void =
  typeof setImmediate === "function"
    ? (callback) => {
        setImmediate(callback)
      }
    : (callback) => {
        setTimeout(callback, 0)
      }

interface PendingKey {
  readonly key: unknown
  readonly limit: number
  readonly resolve: (docs: ReturnedDocument[]) => void
  readonly reject: (error: unknown) => void
}

function canonical(value: unknown): string {
  return JSON.stringify(toCanonical(value))
}

/**
 * Loads related documents. Every key of one relation requested while a tick of resolvers runs becomes one
 * `$in` find under the target collection's DLS (several finds only past 1,000 keys or a full page). Nothing
 * is cached across ticks, so a live query's next result reads fresh documents.
 */
class RelationLoader {
  private readonly queue = new Map<string, { spec: RelationSpec; keys: PendingKey[] }>()
  private scheduled = false
  private readonly find: (request: Parameters<ReadPath["find"]>[1]) => Promise<FindResult>
  private readonly pageSize: number

  constructor(
    find: (request: Parameters<ReadPath["find"]>[1]) => Promise<FindResult>,
    pageSize: number,
  ) {
    this.find = find
    this.pageSize = pageSize
  }

  load(spec: RelationSpec, key: unknown, limit: number): Promise<ReturnedDocument[]> {
    return new Promise((resolve, reject) => {
      let entry = this.queue.get(spec.key)
      if (entry === undefined) {
        entry = { spec, keys: [] }
        this.queue.set(spec.key, entry)
      }
      entry.keys.push({ key, limit, resolve, reject })
      if (!this.scheduled) {
        this.scheduled = true
        schedule(() => this.flush())
      }
    })
  }

  private flush(): void {
    this.scheduled = false
    const batches = [...this.queue.values()]
    this.queue.clear()
    for (const batch of batches) {
      this.run(batch.spec, batch.keys).catch((error: unknown) => {
        for (const pending of batch.keys) pending.reject(error)
      })
    }
  }

  private async run(spec: RelationSpec, pending: readonly PendingKey[]): Promise<void> {
    const values = new Map<string, unknown>()
    for (const { key } of pending) {
      for (const value of Array.isArray(key) ? key : [key]) {
        const id = canonical(value)
        if (!values.has(id)) values.set(id, decode(toCanonical(value)))
      }
    }
    const byKey = new Map<string, ReturnedDocument[]>()
    const all = [...values.values()]
    for (let start = 0; start < all.length; start += 1000) {
      const chunk = all.slice(start, start + 1000)
      let after: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const result = await this.find({
          collection: spec.to,
          filter: { [spec.foreign]: { $in: chunk } },
          limit: this.pageSize,
          ...(after === undefined ? {} : { after }),
        })
        for (const doc of result.docs) {
          const field = doc[spec.foreign]
          for (const value of Array.isArray(field) ? field : [field]) {
            const id = canonical(value)
            if (!values.has(id)) continue
            const list = byKey.get(id) ?? []
            list.push(doc)
            byKey.set(id, list)
          }
        }
        if (result.next === null) break
        after = result.next
      }
    }
    for (const { key, limit, resolve } of pending) {
      const seen = new Set<ReturnedDocument>()
      const docs: ReturnedDocument[] = []
      for (const value of Array.isArray(key) ? key : [key]) {
        for (const doc of byKey.get(canonical(value)) ?? []) {
          if (seen.has(doc)) continue
          seen.add(doc)
          docs.push(doc)
        }
      }
      resolve(docs.slice(0, limit))
    }
  }
}

const DEFAULT_BODY_BYTES = 1024 * 1024

function tooLarge(maxBytes: number): Response {
  return Response.json(
    {
      errors: [
        {
          message: `The request body may not exceed ${maxBytes} bytes`,
          extensions: { code: ErrorCode.PayloadTooLarge },
        },
      ],
    },
    { status: 413 },
  )
}

function rateLimitedError(seconds: number): GraphQLError {
  return new GraphQLError(
    `Too many requests. Retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
    {
      extensions: {
        code: ErrorCode.RateLimited,
        details: { retryAfterSeconds: seconds },
        http: { status: 429 },
      },
    },
  )
}

/** A `429` that browsers may read: it carries the CORS headers yoga would have added. */
function rateLimited(
  seconds: number,
  cors: CorsOptions | undefined,
  origin: string | null,
): Response {
  const headers: Record<string, string> = { "retry-after": String(seconds) }
  if (cors !== undefined && origin !== null) {
    if (cors.origins === "*") headers["access-control-allow-origin"] = "*"
    else if (cors.origins.includes(origin)) {
      headers["access-control-allow-origin"] = origin
      headers["access-control-allow-credentials"] = "true"
      headers["vary"] = "Origin"
    }
    headers["access-control-expose-headers"] = "retry-after"
  }
  const { message, extensions } = rateLimitedError(seconds)
  return Response.json({ errors: [{ message, extensions }] }, { status: 429, headers })
}

/**
 * Reads a request body up to `maxBytes`. Returns the request again with the buffered body, or the
 * `413` response when the declared or the streamed size is above the limit.
 */
async function withinLimit(request: Request, maxBytes: number): Promise<Request | Response> {
  if (request.body === null) return request
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > maxBytes) return tooLarge(maxBytes)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return tooLarge(maxBytes)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
    signal: request.signal,
  })
}

function operationOf(
  document: DocumentNode,
  name: string | null | undefined,
): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  )
  if (name === undefined || name === null) return operations[0]
  return operations.find((operation) => operation.name?.value === name)
}

function introspects(document: DocumentNode): boolean {
  let found = false
  visit(document, {
    Field(node) {
      if (node.name.value !== "__schema" && node.name.value !== "__type") return undefined
      found = true
      return BREAK
    },
  })
  return found
}

function codeOf(error: GraphQLError): string | undefined {
  const code = error.extensions["code"]
  return typeof code === "string" ? code : undefined
}

/** Turns any error into a GraphQL error with `extensions.code`, hiding unexpected ones. */
function maskError(error: unknown, onError: ((error: unknown) => void) | undefined): GraphQLError {
  const graphql = error instanceof GraphQLError ? error : undefined
  const original = graphql === undefined ? error : (graphql.originalError ?? graphql)
  const location = {
    ...(graphql?.nodes === undefined ? {} : { nodes: graphql.nodes }),
    ...(graphql?.source === undefined ? {} : { source: graphql.source }),
    ...(graphql?.positions === undefined ? {} : { positions: graphql.positions }),
    ...(graphql?.path === undefined ? {} : { path: graphql.path }),
  }
  if (original instanceof CanopyError) {
    return new GraphQLError(original.message, {
      ...location,
      originalError: original,
      extensions: {
        code: original.code,
        ...(original.details === undefined ? {} : { details: original.details }),
        ...(original.hint === undefined ? {} : { hint: original.hint }),
        ...(original.docs === undefined ? {} : { docs: `errors/${original.docs}` }),
        http: { status: original.status },
      },
    })
  }
  if (original instanceof GraphQLError) {
    if (codeOf(original) !== undefined && original === graphql) return original
    if (original.originalError !== undefined && !(original.originalError instanceof GraphQLError))
      return maskError(original.originalError, onError)
    return new GraphQLError(original.message, {
      ...location,
      extensions: { ...original.extensions, code: codeOf(original) ?? ErrorCode.InvalidQuery },
    })
  }
  if (original instanceof TypeError && graphql !== undefined) {
    return new GraphQLError(original.message, {
      ...location,
      extensions: { code: ErrorCode.InvalidQuery },
    })
  }
  onError?.(original)
  return new GraphQLError("Internal error", {
    ...location,
    extensions: { code: ErrorCode.Internal },
  })
}

/**
 * Creates the GraphQL endpoint (`/graphql/v1`). The schema is generated from the policies and collection
 * schemas for each role set and cached by policy version, schema version and roles, so it changes
 * atomically when either changes. Queries and mutations run through the Data API's read and write paths;
 * subscriptions (`live<Plural>` and `<singular>Changes`) follow the realtime engine's observers, over SSE.
 */
export function createGraphqlHandler(options: GraphqlHandlerOptions): GraphqlHandler {
  const path = trimTrailingSlashes(options.path ?? "/graphql/v1")
  const engine =
    typeof options.policies === "function"
      ? options.policies
      : () => options.policies as PolicyEngine
  const limits: OperationLimits = { ...DEFAULT_OPERATION_LIMITS, ...options.limits }
  const introspection = options.introspection ?? "always"
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES
  const live = options.realtime === undefined ? undefined : new LiveQueries(options.realtime)
  const readLimits = options.reads.readLimits
  const schemaCache = new Map<string, GraphQLSchema>()
  const collectionLists = new Map<string, { at: number; names: Promise<string[]> }>()
  const sessions = new WeakMap<Request, Promise<Session>>()

  const authenticate = async (request: Request): Promise<Session> => {
    const credentials = credentialsFromHeaders(request.headers)
    const principal = await options.authenticator.authenticate(credentials.key, credentials.token)
    if (principal.readOnly === true)
      throw new ForbiddenError("A view token only follows data over realtime")
    const current = engine()
    const names = current.contextNames(undefined, principal.context.roles)
    const context =
      names.length === 0
        ? principal.context
        : {
            ...principal.context,
            ctx: (await options.contexts.resolve(current.set.contexts, names, principal.context))
              .ctx,
          }
    return { caller: { context, subject: principal.subject }, credentials, keyId: principal.keyId }
  }

  /** Spends a token for the session's caller. Returns the seconds to wait when it is over its budget. */
  const overBudget = (
    session: Session,
    headers: Headers,
    peer: string | undefined,
  ): number | undefined => {
    const limits = options.rateLimits
    if (limits === undefined) return undefined
    const wait = limits.request({
      key: session.keyId ?? session.credentials.key,
      subject: session.caller.subject,
      roles: session.caller.context.roles,
      address: limits.addressOf(headers, peer),
    })
    if (wait === 0) return undefined
    options.onRateLimited?.()
    return retryAfterSeconds(wait)
  }

  /** The seconds to wait when the client address has used up its failed authentications. */
  const failuresBlocked = (headers: Headers, peer: string | undefined): number | undefined => {
    const limits = options.rateLimits
    if (limits === undefined) return undefined
    const wait = limits.authenticationBlocked(limits.addressOf(headers, peer))
    if (wait === 0) return undefined
    options.onRateLimited?.()
    return retryAfterSeconds(wait)
  }

  /** The request's session, counting a failed authentication against the client address. */
  const guardedSession = (request: Request, peer: string | undefined): Promise<Session> => {
    const limits = options.rateLimits
    if (limits === undefined) return sessionOf(request)
    return limits.guardAuthentication(limits.addressOf(request.headers, peer), () =>
      sessionOf(request),
    )
  }

  const sessionOf = (request: Request): Promise<Session> => {
    let session = sessions.get(request)
    if (session === undefined) {
      session = authenticate(request)
      sessions.set(request, session)
    }
    return session
  }

  const collectionsOf = (caller: Caller): Promise<string[]> => {
    const current = engine()
    const service = caller.context.roles.has(Role.Service)
    const key = `${current.version}\u0000${[...caller.context.roles].sort().join(",")}`
    const cached = collectionLists.get(key)
    if (cached !== undefined && (!service || Date.now() - cached.at < 10_000)) return cached.names
    const names = options.reads
      .collections(caller)
      .then((list) => list.map((info) => info.name).sort())
    void names.catch(() => collectionLists.delete(key))
    if (collectionLists.size >= 64) collectionLists.clear()
    collectionLists.set(key, { at: Date.now(), names })
    return names
  }

  const schemaOf = async (session: Session): Promise<GraphQLSchema> => {
    const { caller } = session
    const current = engine()
    const names = await collectionsOf(caller)
    const schemas = await options.schemas.all(names)
    const key = [
      current.version,
      options.schemas.version,
      [...caller.context.roles].sort().join(","),
      names.join(","),
    ].join("\u0000")
    let schema = schemaCache.get(key)
    if (schema === undefined) {
      schema = buildSchema({
        engine: current,
        ctx: caller.context,
        collections: names,
        schemas,
        ...(options.collections === undefined ? {} : { config: options.collections }),
        subscriptions: live !== undefined,
        defaultLimit: readLimits.defaultLimit,
        maxLimit: readLimits.maxLimit,
      })
      if (schemaCache.size >= 64) schemaCache.clear()
      schemaCache.set(key, schema)
    }
    return schema
  }

  const contextOf = (
    session: Session,
    signal: AbortSignal | undefined,
    idempotency: string | undefined,
  ): RequestContext => {
    const { caller } = session
    const readOptions = signal === undefined ? {} : { signal }
    const find = (findRequest: Parameters<ReadPath["find"]>[1]) =>
      options.reads.find(caller, findRequest, readOptions)
    const loader = new RelationLoader(find, readLimits.maxLimit)
    let writes = 0
    const context: RequestContext = {
      session,
      idempotencyKey: idempotency,
      operation: { rootMutations: 0 },
      canopy: undefined as unknown as RequestServices,
    }
    const services: RequestServices = {
      find,
      findById: async (collection, id) =>
        (await options.reads.findById(caller, collection, id, undefined, readOptions)).doc,
      count: async (collection, filter) =>
        (await options.reads.count(caller, collection, filter, "exact", readOptions)).count,
      write: (writeRequest) => {
        writes += 1
        const keyed =
          idempotency !== undefined && context.operation.rootMutations === 1 && writes === 1
            ? { mutationId: idempotency }
            : {}
        return options.writes.execute(caller, writeRequest, { ...readOptions, ...keyed })
      },
      related: (spec, key, limit) => loader.load(spec, key, limit),
      ...(live === undefined
        ? {}
        : {
            live: (collection, query, stop) =>
              live.follow(session.credentials, collection, query, stop),
          }),
    }
    ;(context as { canopy: RequestServices }).canopy = services
    return context
  }

  /** Errors that stop an operation before it runs: limits, introspection and idempotency rules. */
  const gate = (
    schema: GraphQLSchema,
    document: DocumentNode,
    variables: Readonly<Record<string, unknown>> | null | undefined,
    operationName: string | null | undefined,
    context: RequestContext,
  ): GraphQLError[] => {
    const roles = context.session.caller.context.roles
    if (
      introspects(document) &&
      (introspection === "never" ||
        (introspection === "authenticated" &&
          !roles.has(Role.Authenticated) &&
          !roles.has(Role.Service)))
    )
      return [
        new GraphQLError("Introspection is not allowed for this caller", {
          extensions: { code: ErrorCode.Forbidden },
        }),
      ]
    const operation = operationOf(document, operationName)
    if (operation?.operation === "mutation") {
      context.operation.rootMutations = operation.selectionSet.selections.length
      if (context.idempotencyKey !== undefined && context.operation.rootMutations !== 1)
        return [
          new GraphQLError("Idempotency-Key applies to an operation with exactly one mutation", {
            extensions: { code: ErrorCode.InvalidQuery },
          }),
        ]
    }
    return checkOperation(schema, document, variables, operationName, limits)
  }

  const persistedLookup = (params: OperationParams): string => {
    const persisted = options.persisted
    const hash = (params.extensions?.["persistedQuery"] as { sha256Hash?: unknown } | undefined)
      ?.sha256Hash
    if (typeof hash === "string") {
      const found =
        persisted !== undefined && Object.hasOwn(persisted.operations, hash)
          ? persisted.operations[hash]
          : undefined
      if (found === undefined)
        throw new GraphQLError("PersistedQueryNotFound", {
          extensions: { code: ErrorCode.NotFound, http: { status: 404 } },
        })
      return found
    }
    if (persisted?.only === true && !Object.hasOwn(persisted.operations, sha256Hex(params.query)))
      throw new GraphQLError("Only persisted operations are allowed", {
        extensions: { code: ErrorCode.Forbidden, http: { status: 403 } },
      })
    return params.query
  }

  const canopyPlugin: Plugin<RequestContext> = {
    onParams({ params, setParams }) {
      const query = persistedLookup({
        query: params.query ?? "",
        ...(params.extensions === undefined ? {} : { extensions: params.extensions }),
      })
      if (query !== params.query) setParams({ ...params, query })
    },
    onExecute({ args, setResultAndStopExecution }) {
      const errors = gate(
        args.schema,
        args.document,
        args.variableValues,
        args.operationName,
        args.contextValue,
      )
      if (errors.length > 0) setResultAndStopExecution({ errors } as ExecutionResult)
    },
    onSubscribe({ args, setResultAndStopExecution }) {
      const errors = gate(
        args.schema,
        args.document,
        args.variableValues,
        args.operationName,
        args.contextValue,
      )
      if (errors.length > 0) setResultAndStopExecution({ errors } as ExecutionResult)
    },
  }

  const cors = options.cors
  const yoga: YogaServerInstance<Record<string, unknown>, RequestContext> = createYoga<
    Record<string, unknown>,
    RequestContext
  >({
    graphqlEndpoint: path,
    landingPage: false,
    graphiql: false,
    logging: false,
    batching: { limit: options.maxBatch ?? 10 },
    cors:
      cors === undefined
        ? false
        : {
            origin: cors.origins === "*" ? "*" : [...cors.origins],
            credentials: cors.origins !== "*",
            allowedHeaders: [
              "apikey",
              "authorization",
              "content-type",
              "accept",
              "idempotency-key",
              "x-request-id",
            ],
            maxAge: cors.maxAgeSeconds ?? 600,
          },
    schema: async ({ request }) => schemaOf(await sessionOf(request)),
    context: async ({ request }) =>
      contextOf(
        await sessionOf(request),
        request.signal,
        request.headers.get("idempotency-key") ?? undefined,
      ),
    maskedErrors: { maskError: (error) => maskError(error, options.onError) },
    plugins: [canopyPlugin],
  })

  return {
    path,
    async fetch(request: Request, info: { readonly ip?: string } = {}): Promise<Response> {
      try {
        const bounded = await withinLimit(request, maxBodyBytes)
        if (bounded instanceof Response) return bounded
        if (options.rateLimits !== undefined) {
          const blocked = failuresBlocked(bounded.headers, info.ip)
          if (blocked !== undefined)
            return rateLimited(blocked, cors, bounded.headers.get("origin"))
          const session = await guardedSession(bounded, info.ip).catch(() => undefined)
          const wait =
            session === undefined ? undefined : overBudget(session, bounded.headers, info.ip)
          if (wait !== undefined) return rateLimited(wait, cors, bounded.headers.get("origin"))
        }
        return await yoga.fetch(bounded)
      } catch (error: unknown) {
        options.onError?.(error)
        return new Response(null, { status: 500 })
      }
    },
    async schemaFor(request: Request): Promise<GraphQLSchema> {
      return schemaOf(await sessionOf(request))
    },
    async run(
      caller: Caller,
      params: OperationParams,
      runOptions: RunOptions = {},
    ): Promise<RunResult> {
      const { execute, parse, validate } = await import("graphql")
      try {
        const session: Session = { caller, credentials: { key: "", token: undefined } }
        const schema = await schemaOf(session)
        const document = parse(persistedLookup(params))
        const operation = operationOf(document, params.operationName)?.operation
        const kind = operation === undefined ? {} : { operation }
        const invalid = validate(schema, document)
        if (invalid.length > 0)
          return { ...kind, errors: invalid.map((error) => maskError(error, options.onError)) }
        if (operation === "subscription")
          return {
            ...kind,
            errors: [
              new GraphQLError("Subscriptions need a transport; use /graphql/v1", {
                extensions: { code: ErrorCode.InvalidQuery },
              }),
            ],
          }
        if (operation === "mutation" && runOptions.mutations === false)
          return {
            ...kind,
            errors: [
              new GraphQLError("Mutations are not allowed here", {
                extensions: { code: ErrorCode.Forbidden },
              }),
            ],
          }
        const contextValue = contextOf(session, runOptions.signal, undefined)
        const gated = gate(schema, document, params.variables, params.operationName, contextValue)
        if (gated.length > 0) return { ...kind, errors: gated }
        const result = await execute({
          schema,
          document,
          contextValue,
          ...(params.variables === undefined || params.variables === null
            ? {}
            : { variableValues: params.variables }),
          ...(params.operationName === undefined || params.operationName === null
            ? {}
            : { operationName: params.operationName }),
        })
        return {
          ...kind,
          data: result.data ?? null,
          ...(result.errors === undefined
            ? {}
            : { errors: result.errors.map((error) => maskError(error, options.onError)) }),
        }
      } catch (error: unknown) {
        return { errors: [maskError(error, options.onError)] }
      }
    },
    async prepare(
      request: Request,
      params: OperationParams,
      info: { readonly ip?: string } = {},
    ): Promise<PreparedOperation> {
      const { parse, validate } = await import("graphql")
      try {
        const blocked = failuresBlocked(request.headers, info.ip)
        if (blocked !== undefined) return { ok: false, errors: [rateLimitedError(blocked)] }
        const session = await guardedSession(request, info.ip)
        const wait = overBudget(session, request.headers, info.ip)
        if (wait !== undefined) return { ok: false, errors: [rateLimitedError(wait)] }
        const schema = await schemaOf(session)
        const query = persistedLookup(params)
        const document = parse(query)
        const invalid = validate(schema, document)
        if (invalid.length > 0)
          return { ok: false, errors: invalid.map((error) => maskError(error, options.onError)) }
        const contextValue = contextOf(
          session,
          request.signal,
          request.headers.get("idempotency-key") ?? undefined,
        )
        const gated = gate(schema, document, params.variables, params.operationName, contextValue)
        if (gated.length > 0) return { ok: false, errors: gated }
        return {
          ok: true,
          schema,
          document,
          contextValue,
          variableValues: params.variables ?? undefined,
          operationName: params.operationName ?? undefined,
        }
      } catch (error: unknown) {
        return { ok: false, errors: [maskError(error, options.onError)] }
      }
    },
    close(): void {
      live?.close()
    },
  }
}

/** Whether a path is the GraphQL endpoint, for routers that mount the handler. */
export function isGraphqlPath(pathname: string, path: string): boolean {
  return pathname === path || pathname === `${path}/`
}
