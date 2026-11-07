import type {
  CanopyClient,
  CollectionName,
  ConnectionStatus,
  Document,
  Filter,
  IdOf,
  InsertOf,
  LiveQuery,
  LiveQueryOptions,
  MutationHandle,
  QueryState,
  ReplaceOptions,
  RowOf,
  Schema,
  StaleMutation,
  UntypedSchema,
  UpdateFilter,
  WriteOptions,
} from "@canopy/client"
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react"

const ClientContext = createContext<CanopyClient | undefined>(undefined)

/** Props of {@link CanopyProvider}. */
export interface CanopyProviderProps<DB extends Schema<DB> = UntypedSchema> {
  readonly client: CanopyClient<DB>
  readonly children?: ReactNode
}

/** Makes a client, typed or not, available to the hooks below it. */
export function CanopyProvider<DB extends Schema<DB> = UntypedSchema>({
  client,
  children,
}: CanopyProviderProps<DB>): ReactNode {
  return createElement(
    ClientContext.Provider,
    { value: client as unknown as CanopyClient },
    children,
  )
}

/**
 * Returns the client from the nearest {@link CanopyProvider}. Pass the schema the client was created with
 * to get it back typed: `useCanopy<Database>()`.
 */
export function useCanopy<DB extends Schema<DB> = UntypedSchema>(): CanopyClient<DB> {
  const client = useContext(ClientContext)
  if (client === undefined) throw new Error("useCanopy must be used inside <CanopyProvider>")
  return client as unknown as CanopyClient<DB>
}

/** Subscribes a component to a live query. Identical queries share one subscription. */
export function useQuery<T>(query: LiveQuery<T>): QueryState<T> {
  const subscribe = useCallback((notify: () => void) => query.subscribe(() => notify()), [query])
  const read = useCallback(() => query.getState(), [query])
  return useSyncExternalStore(subscribe, read, read)
}

/** The connection status: `connecting`, `live`, `fallback`, `reconnecting`, `offline` or `closed`. */
export function useCanopyStatus(): ConnectionStatus {
  const client = useCanopy()
  const subscribe = useCallback((notify: () => void) => client.onStatus(() => notify()), [client])
  const read = useCallback(() => client.connectionStatus, [client])
  return useSyncExternalStore(subscribe, read, read)
}

/** The latest rolled back mutation, from {@link useMutationError}. */
export interface MutationFailure {
  /** The error of the latest mutation that was rolled back, or `undefined`. */
  readonly error: Error | undefined
  readonly mutationId: string | undefined
  /** Forgets the error, for example once a toast was dismissed. */
  clear(): void
}

/**
 * The latest mutation the server rejected, so a component can explain the rollback. Mutations that are
 * not awaited never raise unhandled rejections; their failures arrive here.
 */
export function useMutationError(): MutationFailure {
  const client = useCanopy()
  const [failure, setFailure] = useState<{ error: Error; mutationId: string }>()
  useEffect(
    () => client.onMutationError((error, mutationId) => setFailure({ error, mutationId })),
    [client],
  )
  const clear = useCallback(() => setFailure(undefined), [])
  return { error: failure?.error, mutationId: failure?.mutationId, clear }
}

/**
 * Persisted mutations too old to replay safely. Each has `retry()` and `discard()`; the list updates
 * as they are handled.
 */
export function useStaleMutations(): readonly StaleMutation[] {
  const client = useCanopy()
  const subscribe = useCallback(
    (notify: () => void) => client.onStaleMutations(() => notify()),
    [client],
  )
  const read = useCallback(() => client.staleMutations, [client])
  return useSyncExternalStore(subscribe, read, read)
}

function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? ""
}

/** Hooks and optimistic mutations for one collection. */
export interface CollectionHooks<Row = Document, Insert = Row> {
  useQuery(filter?: Filter<Row>, options?: LiveQueryOptions<Row>): QueryState<Row>
  insert(doc: Insert): MutationHandle
  insertMany(docs: readonly Insert[]): MutationHandle
  update(id: IdOf<Row>, update: UpdateFilter<Row>, options?: WriteOptions<Row>): MutationHandle
  replace(id: IdOf<Row>, doc: Insert, options?: ReplaceOptions<Row>): MutationHandle
  delete(id: IdOf<Row>, options?: WriteOptions<Row>): MutationHandle
  updateMany(filter: Filter<Row>, update: UpdateFilter<Row>): MutationHandle
  deleteMany(filter: Filter<Row>): MutationHandle
}

/** Collection hooks keyed by collection name. */
export type ReactDb<DB extends Schema<DB>> = {
  readonly [C in CollectionName<DB>]: CollectionHooks<RowOf<DB, C>, InsertOf<DB, C>>
}

/**
 * Builds typed hooks per collection from a client: `db.todos.useQuery({ done: false }, { sort: { createdAt: -1 } })`.
 * The types come from the client (`createClient<Database>(...)`); an untyped client can be typed here
 * instead, with `createReactDb<Database>(client)`. The filter and options are compared by value, so inline
 * objects do not resubscribe on every render.
 */
export function createReactDb<DB extends Schema<DB> = UntypedSchema>(
  client: CanopyClient<DB> | CanopyClient<UntypedSchema>,
): ReactDb<DB> {
  const untyped = client as unknown as CanopyClient<UntypedSchema>
  const cache = new Map<string, CollectionHooks>()
  const queries = new Map<string, LiveQuery<Document>>()
  return new Proxy({} as ReactDb<DB>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined
      let hooks = cache.get(name)
      if (hooks === undefined) {
        hooks = {
          useQuery(filter = {}, options = {}) {
            const key = stableKey([name, filter, options])
            let query = queries.get(key)
            if (query === undefined) {
              query = untyped.live(name, filter, options)
              queries.set(key, query)
            }
            return useQuery(query)
          },
          insert: (doc) => untyped.insert(name, doc),
          insertMany: (docs) => untyped.insertMany(name, docs),
          update: (id, update, options) => untyped.update(name, id, update, options),
          replace: (id, doc, options) => untyped.replace(name, id, doc, options),
          delete: (id, options) => untyped.delete(name, id, options),
          updateMany: (filter, update) => untyped.updateMany(name, filter, update),
          deleteMany: (filter) => untyped.deleteMany(name, filter),
        }
        cache.set(name, hooks)
      }
      return hooks
    },
  })
}
