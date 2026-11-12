import type {
  CanopyClient,
  ConnectionStatus,
  LiveQuery,
  QueryState,
  QueryStatus,
  Schema,
  UntypedSchema,
} from "@canopy/client"
import {
  type Accessor,
  createComputed,
  createContext,
  createSignal,
  onCleanup,
  useContext,
} from "solid-js"

/** The context the client is provided through: `<CanopyContext.Provider value={canopy}>`. */
export const CanopyContext = createContext<CanopyClient | undefined>(undefined)

/** Returns the client from {@link CanopyContext}. Pass the schema to get it back typed. */
export function useCanopy<DB extends Schema<DB> = UntypedSchema>(): CanopyClient<DB> {
  const client = useContext(CanopyContext)
  if (client === undefined)
    throw new Error("useCanopy needs <CanopyContext.Provider value={client}>")
  return client as unknown as CanopyClient<DB>
}

/** A live query as signals, from {@link createQuery}. */
export interface QuerySignals<T> {
  readonly data: Accessor<readonly T[]>
  readonly status: Accessor<QueryStatus>
  readonly error: Accessor<Error | undefined>
  /** The whole state. */
  readonly state: Accessor<QueryState<T>>
}

/**
 * Follows a live query with signals, for as long as the owning component or root lives. Pass an
 * accessor to follow a query that depends on other signals; the subscription moves when it changes:
 *
 * ```ts
 * const todos = createQuery(() => canopy.from("todos").find({ status: status() }))
 * ```
 */
export function createQuery<T>(query: LiveQuery<T> | Accessor<LiveQuery<T>>): QuerySignals<T> {
  const read = typeof query === "function" ? query : () => query
  const [state, setState] = createSignal<QueryState<T>>(read().getState(), { equals: false })
  createComputed(() => {
    const current = read()
    const stop = current.subscribe((next) => setState(() => next))
    onCleanup(stop)
  })
  return {
    state,
    data: () => state().data,
    status: () => state().status,
    error: () => state().error,
  }
}

/** The connection status as a signal. */
export function createCanopyStatus(client: CanopyClient = useCanopy()): Accessor<ConnectionStatus> {
  const [status, setStatus] = createSignal(client.connectionStatus)
  onCleanup(client.onStatus((next) => setStatus(() => next)))
  return status
}
