import { type CanopyClient, createClient, type Document } from "@canopy/client"
import { toCanonical } from "@canopy/protocol"
import { CanopyProvider, useCanopy, useQuery } from "@canopy/react"
import { useEffect, useMemo, useState } from "react"

/** Props of {@link LiveDocuments}. */
export interface LiveDocumentsProps {
  readonly collection: string
  readonly filter: Readonly<Record<string, unknown>>
  readonly sort: Readonly<Record<string, 1 | -1>> | undefined
  readonly limit: number
  readonly token: string
  readonly publishableKey: string
  /** Receives the live documents in canonical EJSON on every change. */
  readonly onDocuments: (documents: Record<string, unknown>[]) => void
  readonly onError: (error: Error) => void
}

function Subscription({
  collection,
  filter,
  sort,
  limit,
  onDocuments,
  onError,
}: Omit<LiveDocumentsProps, "token" | "publishableKey">) {
  const client = useCanopy()
  const key = JSON.stringify({ filter, sort, limit })
  const query = useMemo(() => {
    let builder = client.from(collection).find(filter as Document)
    if (sort !== undefined) builder = builder.sort(sort as never)
    return builder.limit(limit)
  }, [client, collection, key])
  const state = useQuery(query)
  useEffect(() => {
    if (state.error !== undefined) onError(state.error)
    else if (state.status !== "loading") {
      onDocuments(state.data.map((document) => toCanonical(document) as Record<string, unknown>))
    }
  }, [state, onDocuments, onError])
  return null
}

/**
 * Follows a document listing live through `@canopy/react`, with a short lived admin scoped token. Loaded
 * lazily so the realtime client stays out of the main chunk.
 */
export default function LiveDocuments({ token, publishableKey, ...rest }: LiveDocumentsProps) {
  const [client, setClient] = useState<CanopyClient | undefined>(undefined)
  useEffect(() => {
    const next = createClient({
      url: window.location.origin,
      publishableKey,
      auth: { getToken: () => token },
    })
    setClient(next)
    return () => next.close()
  }, [token, publishableKey])
  if (client === undefined) return null
  return (
    <CanopyProvider client={client}>
      <Subscription {...rest} />
    </CanopyProvider>
  )
}
