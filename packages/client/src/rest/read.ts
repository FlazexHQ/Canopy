import {
  type ClusterTime,
  type Document,
  isClusterTime,
  isDocument,
  ProtocolError,
} from "@canopy/protocol"
import type {
  ConsistentProjection,
  Filter,
  IdOf,
  ProjectedResult,
  Projection,
  Sort,
} from "../types.ts"
import { idSegment, type RestTransport, send } from "./request.ts"

/** How a count is computed: `exact` counts matching documents, `estimated` may use collection metadata. */
export type CountMode = "exact" | "estimated"

/** One page of a REST query. */
export interface RestPage<T> {
  readonly data: readonly T[]
  readonly page: {
    readonly limit: number
    /** The cursor of the next page, for `page({ after })`, or `null` on the last page. Opaque. */
    readonly next: string | null
    /** The number of matching documents, when the page asked for a count. */
    readonly total?: number
  }
  /** The cluster time the page was read at. */
  readonly ct: ClusterTime
}

/** A single document read by ID. */
export interface RestDocument<T> {
  readonly data: T
  readonly ct: ClusterTime
}

/** The result of a count. */
export interface RestCount {
  readonly data: { readonly count: number; readonly exact: boolean }
  readonly ct: ClusterTime
}

/** Options of {@link RestQuery.page}. */
export interface PageOptions {
  /** The cursor from the previous page's `page.next`. */
  readonly after?: string
  /** Also count the matching documents into `page.total`. */
  readonly count?: CountMode
  readonly signal?: AbortSignal
}

/** Options of {@link RestCollection.findById}. */
export interface FindByIdOptions<F> {
  readonly fields?: F & ConsistentProjection<F>
  readonly signal?: AbortSignal
}

/** Options of {@link RestCollection.count}. */
export interface CountOptions {
  /** Defaults to `exact`. */
  readonly mode?: CountMode
  readonly signal?: AbortSignal
}

/**
 * An immutable description of a REST read: building it sends nothing; `page()` runs it. Each method returns
 * a new query, and a second `find` replaces the filter.
 */
export interface RestQuery<Doc = Document, Out = Doc> {
  find(filter: Filter<Doc>): RestQuery<Doc, Out>
  sort(sort: Sort<Doc>): RestQuery<Doc, Out>
  limit(limit: number): RestQuery<Doc, Out>
  /** Narrows the returned fields. The result type follows a literal projection. */
  fields<const F extends Projection<Doc>>(
    fields: F & ConsistentProjection<F>,
  ): RestQuery<Doc, ProjectedResult<Doc, F>>
  /** Reads one page, or the page after the cursor `after`. */
  page(options?: PageOptions): Promise<RestPage<Out>>
}

/** One collection over REST: its queries, reads by ID and counts. */
export interface RestCollection<Doc = Document> extends RestQuery<Doc, Doc> {
  readonly name: string
  /**
   * Reads one document by `_id`. Rejects with `NotFoundError` when it does not exist or the caller may not
   * read it.
   */
  findById<const F extends Projection<Doc> = never>(
    id: IdOf<Doc>,
    options?: FindByIdOptions<F>,
  ): Promise<RestDocument<ProjectedResult<Doc, F>>>
  /** Counts the documents matching `filter` that the caller may read. */
  count(filter?: Filter<Doc>, options?: CountOptions): Promise<RestCount>
}

interface QuerySpec {
  readonly filter: Document
  readonly sort?: Readonly<Record<string, 1 | -1>>
  readonly limit?: number
  readonly fields?: Readonly<Record<string, 0 | 1>>
}

function protocol(message: string): ProtocolError {
  return new ProtocolError(`Unexpected response: ${message}`)
}

function clusterTime(body: Record<string, unknown>): ClusterTime {
  const ct = body["ct"]
  if (!isClusterTime(ct)) throw protocol("ct is not a cluster time")
  return ct
}

function documents(value: unknown): Document[] {
  if (!Array.isArray(value) || !value.every(isDocument))
    throw protocol("data is not a list of documents")
  return value
}

function envelope(value: unknown): Record<string, unknown> {
  if (!isDocument(value)) throw protocol("the body is not a document")
  return value
}

/** Validates a `_query` response. */
function readPage(value: unknown): RestPage<Document> {
  const body = envelope(value)
  const page = body["page"]
  if (!isDocument(page)) throw protocol("page is missing")
  const { limit, next, total } = page
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
    throw protocol("page.limit is not a count")
  if (next !== null && typeof next !== "string") throw protocol("page.next is not a cursor")
  if (
    total !== undefined &&
    (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
  )
    throw protocol("page.total is not a count")
  return {
    data: documents(body["data"]),
    page: { limit, next, ...(total === undefined ? {} : { total }) },
    ct: clusterTime(body),
  }
}

/** Validates a `_count` response. */
function readCount(value: unknown): RestCount {
  const body = envelope(value)
  const data = body["data"]
  if (!isDocument(data)) throw protocol("data is missing")
  const { count, exact } = data
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw protocol("data.count is not a count")
  if (typeof exact !== "boolean") throw protocol("data.exact is not a boolean")
  return { data: { count, exact }, ct: clusterTime(body) }
}

/** Validates a read by ID. */
function readDocument(value: unknown): RestDocument<Document> {
  const body = envelope(value)
  const data = body["data"]
  if (!isDocument(data)) throw protocol("data is not a document")
  return { data, ct: clusterTime(body) }
}

function fieldsParam(fields: Readonly<Record<string, 0 | 1>>): string {
  return Object.entries(fields)
    .map(([path, flag]) => (flag === 0 ? `-${path}` : path))
    .join(",")
}

function collectionPath(collection: string): string {
  return `/rest/v1/${encodeURIComponent(collection)}`
}

/** The runtime of {@link RestQuery} and {@link RestCollection}. */
class RestReader {
  readonly name: string
  private readonly transport: RestTransport
  private readonly spec: QuerySpec

  constructor(transport: RestTransport, collection: string, spec: QuerySpec) {
    this.transport = transport
    this.name = collection
    this.spec = spec
  }

  private with(spec: Partial<QuerySpec>): RestReader {
    return new RestReader(this.transport, this.name, { ...this.spec, ...spec })
  }

  find(filter: object): RestReader {
    return this.with({ filter: filter as Document })
  }

  sort(sort: object): RestReader {
    return this.with({ sort: sort as Record<string, 1 | -1> })
  }

  limit(limit: number): RestReader {
    return this.with({ limit })
  }

  fields(fields: object): RestReader {
    return this.with({ fields: fields as Record<string, 0 | 1> })
  }

  async page(options: PageOptions = {}): Promise<RestPage<Document>> {
    const body = {
      ...this.spec,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.count === undefined ? {} : { count: options.count }),
    }
    return readPage(
      await send(this.transport, {
        method: "POST",
        path: `${collectionPath(this.name)}/_query`,
        body,
        signal: options.signal,
      }),
    )
  }

  async findById(
    id: unknown,
    options: { readonly fields?: object; readonly signal?: AbortSignal } = {},
  ): Promise<RestDocument<Document>> {
    const query =
      options.fields === undefined
        ? ""
        : `?fields=${encodeURIComponent(fieldsParam(options.fields as Record<string, 0 | 1>))}`
    return readDocument(
      await send(this.transport, {
        method: "GET",
        path: `${collectionPath(this.name)}/${idSegment(id)}${query}`,
        signal: options.signal,
      }),
    )
  }

  async count(filter: object = {}, options: CountOptions = {}): Promise<RestCount> {
    const mode = options.mode ?? "exact"
    return readCount(
      await send(this.transport, {
        method: "POST",
        path: `${collectionPath(this.name)}/_count`,
        body: { filter },
        headers: { prefer: `count=${mode}` },
        signal: options.signal,
      }),
    )
  }
}

/** A collection reader with no filter yet. */
export function restCollection(transport: RestTransport, collection: string): RestCollection {
  return new RestReader(transport, collection, { filter: {} }) as unknown as RestCollection
}
