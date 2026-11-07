import { type QueryClient, useQuery } from "@tanstack/react-query"
import { createContext, type ReactNode, useContext } from "react"
import type { AdminApi } from "../api/client.ts"
import type { Me } from "../api/contract.ts"
import { type Permissions, permissionsOf } from "./permissions.ts"

const ApiContext = createContext<AdminApi | null>(null)

export function ApiProvider({
  api,
  children,
}: {
  readonly api: AdminApi
  readonly children: ReactNode
}) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

/** The admin API client of the running Studio. */
export function useApi(): AdminApi {
  const api = useContext(ApiContext)
  if (api === null) throw new TypeError("useApi needs an ApiProvider")
  return api
}

/** Query keys, so invalidation after a mutation reaches every view of the same data. */
export const keys = {
  me: ["me"] as const,
  setup: ["setup"] as const,
  collections: ["collections"] as const,
  collectionSchema: (name: string) => ["collections", name, "schema"] as const,
  collectionStats: (name: string) => ["collections", name, "stats"] as const,
  documents: (name: string) => ["collections", name, "documents"] as const,
  policies: (name: string) => ["policies", name] as const,
  history: (name: string) => ["policies", name, "history"] as const,
  users: ["users"] as const,
  user: (id: string) => ["users", id] as const,
  providers: ["auth", "providers"] as const,
  templates: ["auth", "templates"] as const,
  signingKeys: ["auth", "keys"] as const,
  apiKeys: ["api-keys"] as const,
  realtimeStats: ["realtime", "stats"] as const,
  realtimeConnections: ["realtime", "connections"] as const,
  realtimeObservers: ["realtime", "observers"] as const,
  trace: (id: string) => ["realtime", "trace", id] as const,
  doctor: ["doctor"] as const,
  logs: ["logs"] as const,
  audit: ["audit"] as const,
  settings: ["settings"] as const,
  openapi: ["openapi"] as const,
}

export function meQuery(api: AdminApi) {
  return {
    queryKey: keys.me,
    queryFn: ({ signal }: { signal: AbortSignal }) => api.me(signal),
    staleTime: 60_000,
  }
}

/** The signed in admin and the environment. Only used below the authenticated layout. */
export function useSession(): Me & { readonly permissions: Permissions } {
  const api = useApi()
  const { data } = useQuery(meQuery(api))
  if (data === undefined) throw new TypeError("useSession is only available after sign in")
  return { ...data, permissions: permissionsOf(data.admin.role, data.environment ?? "development") }
}

/** The router context: the API client and the query cache. */
export interface RouterContext {
  readonly api: AdminApi
  readonly queryClient: QueryClient
}
