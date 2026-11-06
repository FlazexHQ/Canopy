import type {
  CanopyClient,
  ConnectionStatus,
  Document,
  LiveQuery,
  LiveQueryOptions,
  MutationHandle,
  QueryState,
  WriteOptions,
} from "@canopy/client"
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react"

const ClientContext = createContext<CanopyClient | undefined>(undefined)

/** Props of {@link CanopyProvider}. */
export interface CanopyProviderProps {
  readonly client: CanopyClient
  readonly children?: ReactNode
}

/** Makes a client available to the hooks below it. */
export function CanopyProvider({ client, children }: CanopyProviderProps): ReactNode {
  return createElement(ClientContext.Provider, { value: client }, children)
}

/** Returns the client from the nearest {@link CanopyProvider}. */
export function useCanopy(): CanopyClient {
  const client = useContext(ClientContext)
  if (client === undefined) throw new Error("useCanopy must be used inside <CanopyProvider>")
  return client
}

/** Subscribes a component to a live query. Identical queries share one subscription. */
export function useQuery<T extends Document = Document>(query: LiveQuery<T>): QueryState<T> {
  const subscribe = useCallback((notify: () => void) => query.subscribe(() => notify()), [query])
  const read = useCallback(() => query.getState(), [query])
  return useSyncExternalStore(subscribe, read, read)
}

/** The connection status: `connecting`, `live`, `reconnecting`, `offline` or `closed`. */
export function useCanopyStatus(): ConnectionStatus {
  const client = useCanopy()
  const subscribe = useCallback((notify: () => void) => client.onStatus(() => notify()), [client])
  const read = useCallback(() => client.connectionStatus, [client])
  return useSyncExternalStore(subscribe, read, read)
}

function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? ""
}

/** Hooks and optimistic mutations for one collection. */
export interface CollectionHooks<T extends Document> {
  useQuery(filter?: Document, options?: LiveQueryOptions): QueryState<T>
  insert(doc: Document): MutationHandle
  insertMany(docs: readonly Document[]): MutationHandle
  update(id: unknown, update: Document, options?: WriteOptions): MutationHandle
  replace(
    id: unknown,
    doc: Document,
    options?: WriteOptions & { readonly upsert?: boolean },
  ): MutationHandle
  delete(id: unknown, options?: WriteOptions): MutationHandle
  updateMany(filter: Document, update: Document): MutationHandle
  deleteMany(filter: Document): MutationHandle
}

/** Collection hooks keyed by collection name. */
export type ReactDb<DB extends Record<string, Document>> = {
  readonly [K in keyof DB & string]: CollectionHooks<DB[K]>
}

/**
 * Builds typed hooks per collection: `db.todos.useQuery({ status: 'active' }, { sort: { createdAt: -1 } })`.
 * The filter and options are compared by value, so inline objects do not resubscribe on every render.
 */
export function createReactDb<DB extends Record<string, Document> = Record<string, Document>>(
  client: CanopyClient,
): ReactDb<DB> {
  const cache = new Map<string, CollectionHooks<Document>>()
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
              query = client.live(name, filter, options)
              queries.set(key, query)
            }
            return useQuery(query)
          },
          insert: (doc) => client.insert(name, doc),
          insertMany: (docs) => client.insertMany(name, docs),
          update: (id, update, options) => client.update(name, id, update, options),
          replace: (id, doc, options) => client.replace(name, id, doc, options),
          delete: (id, options) => client.delete(name, id, options),
          updateMany: (filter, update) => client.updateMany(name, filter, update),
          deleteMany: (filter) => client.deleteMany(name, filter),
        }
        cache.set(name, hooks)
      }
      return hooks
    },
  })
}
