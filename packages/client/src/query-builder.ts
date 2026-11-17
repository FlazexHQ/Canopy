import type { Document } from "@canopy/protocol"
import { asDocument, type CanopyClient } from "./client.ts"
import type {
  LiveQuery,
  LiveQueryOptions,
  MutationHandle,
  ReplaceOptions,
  WriteOptions,
} from "./client-types.ts"
import type { QueryState } from "./store.ts"
import type {
  Filter,
  IdOf,
  Projected,
  Projection,
  Sort,
  UntypedSchema,
  UpdateFilter,
} from "./types.ts"

export type AnyClient = CanopyClient<UntypedSchema>

/**
 * An immutable query builder: `from('todos').find({ done: false }).sort({ at: -1 }).limit(20)`. `Document` is the
 * collection's document type, `Insert` what inserts accept, and `Out` the documents the query returns
 * (narrowed by `fields`).
 */
export class QueryBuilder<in out Doc = Document, in out Insert = Doc, out Out = Doc>
  implements LiveQuery<Out>
{
  private readonly client: AnyClient
  private readonly collection: string
  private readonly filter: Document
  private readonly options: LiveQueryOptions<Doc>
  private cached: LiveQuery<Out> | undefined

  constructor(
    client: AnyClient,
    collection: string,
    filter: Document,
    options: LiveQueryOptions<Doc>,
  ) {
    this.client = client
    this.collection = collection
    this.filter = filter
    this.options = options
  }

  private with<Next = Out>(
    filter: Document,
    options: LiveQueryOptions<Doc>,
  ): QueryBuilder<Doc, Insert, Next> {
    return new QueryBuilder<Doc, Insert, Next>(this.client, this.collection, filter, options)
  }

  find(filter: Filter<Doc>): QueryBuilder<Doc, Insert, Out> {
    return this.with(asDocument(filter), this.options)
  }

  sort(sort: Sort<Doc>): QueryBuilder<Doc, Insert, Out> {
    return this.with(this.filter, { ...this.options, sort })
  }

  limit(limit: number): QueryBuilder<Doc, Insert, Out> {
    return this.with(this.filter, { ...this.options, limit })
  }

  /** Narrows the returned fields. The result type follows the projection. */
  fields<const F extends Projection<Doc>>(fields: F): QueryBuilder<Doc, Insert, Projected<Doc, F>> {
    return this.with<Projected<Doc, F>>(this.filter, { ...this.options, fields })
  }

  /** Inserts a document into this collection. */
  insert(doc: Insert): MutationHandle<IdOf<Doc>> {
    return this.client.insert(this.collection, asDocument(doc as object)) as MutationHandle<
      IdOf<Doc>
    >
  }

  /** Inserts several documents into this collection. */
  insertMany(docs: readonly Insert[]): MutationHandle {
    return this.client.insertMany(
      this.collection,
      docs.map((doc) => asDocument(doc as object)),
    )
  }

  /** Updates one document of this collection. */
  update(id: IdOf<Doc>, update: UpdateFilter<Doc>, options?: WriteOptions<Doc>): MutationHandle {
    return this.client.update(
      this.collection,
      id,
      asDocument(update),
      options as WriteOptions | undefined,
    )
  }

  /** Replaces one document of this collection. */
  replace(id: IdOf<Doc>, doc: Insert, options?: ReplaceOptions<Doc>): MutationHandle {
    return this.client.replace(
      this.collection,
      id,
      asDocument(doc as object),
      options as ReplaceOptions | undefined,
    )
  }

  /** Deletes one document of this collection. */
  delete(id: IdOf<Doc>, options?: WriteOptions<Doc>): MutationHandle {
    return this.client.delete(this.collection, id, options as WriteOptions | undefined)
  }

  /** Updates every visible document of this collection matching `filter`. */
  updateMany(filter: Filter<Doc>, update: UpdateFilter<Doc>): MutationHandle {
    return this.client.updateMany(this.collection, asDocument(filter), asDocument(update))
  }

  /** Deletes every visible document of this collection matching `filter`. */
  deleteMany(filter: Filter<Doc>): MutationHandle {
    return this.client.deleteMany(this.collection, asDocument(filter))
  }

  private live(): LiveQuery<Out> {
    this.cached ??= this.client.live<string, Out>(
      this.collection,
      this.filter,
      this.options as LiveQueryOptions,
    )
    return this.cached
  }

  getState(): QueryState<Out> {
    return this.live().getState()
  }

  subscribe(listener: (state: QueryState<Out>) => void): () => void {
    return this.live().subscribe(listener)
  }
}
