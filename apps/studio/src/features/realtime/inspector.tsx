import { useQuery } from "@tanstack/react-query"
import { keys, useApi } from "../../app/context.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatBytes, formatDateTime, formatNumber, formatRelative, t } from "../../i18n/index.ts"
import { formatEjson } from "../../lib/ejson.ts"

/** Every realtime session, refreshed every five seconds. */
export function ConnectionsView() {
  const api = useApi()
  const query = useQuery({
    queryKey: keys.realtimeConnections,
    queryFn: ({ signal }) => api.realtimeConnections(signal),
    refetchInterval: 5000,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("realtime.tabs.connections")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (query.data.length === 0) return <EmptyState>{t("realtime.connections.empty")}</EmptyState>
  return (
    <Table>
      <TableCaption>{t("realtime.connections.caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t("realtime.connections.subject")}</TableHead>
          <TableHead>{t("realtime.connections.roles")}</TableHead>
          <TableHead>{t("realtime.connections.transport")}</TableHead>
          <TableHead>{t("realtime.connections.subscriptions")}</TableHead>
          <TableHead>{t("realtime.connections.queued")}</TableHead>
          <TableHead>{t("realtime.connections.documents")}</TableHead>
          <TableHead>{t("realtime.connections.state")}</TableHead>
          <TableHead>{t("realtime.connections.opened")}</TableHead>
          <TableHead>{t("realtime.connections.tokenExpires")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {query.data.map((connection) => (
          <TableRow key={connection.sid} data-testid="connection">
            <TableCell>
              <span className="font-medium">{connection.subject}</span>
              <span className="block font-mono text-xs text-muted-foreground">
                {connection.sid}
              </span>
            </TableCell>
            <TableCell>{connection.roles.join(", ")}</TableCell>
            <TableCell>{connection.transport ?? t("common.unknown")}</TableCell>
            <TableCell>
              <ul className="text-xs">
                {connection.subscriptions.map((subscription) => (
                  <li key={subscription.id}>
                    {subscription.coll}{" "}
                    <span className="text-muted-foreground">({subscription.id})</span>
                  </li>
                ))}
              </ul>
            </TableCell>
            <TableCell>{formatBytes(connection.queuedBytes)}</TableCell>
            <TableCell>{formatNumber(connection.documents)}</TableCell>
            <TableCell>
              <Badge variant={connection.connected ? "success" : "warning"}>
                {connection.connected
                  ? t("realtime.connections.connected")
                  : t("realtime.connections.resuming")}
              </Badge>
            </TableCell>
            <TableCell title={formatDateTime(connection.openedAt)}>
              {formatRelative(connection.openedAt)}
            </TableCell>
            <TableCell>
              {connection.tokenExpiresAt === undefined || connection.tokenExpiresAt === null
                ? t("common.never")
                : formatRelative(connection.tokenExpiresAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Shared observers with their effective filters, refreshed every five seconds. */
export function ObserversView() {
  const api = useApi()
  const query = useQuery({
    queryKey: keys.realtimeObservers,
    queryFn: ({ signal }) => api.realtimeObservers(signal),
    refetchInterval: 5000,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("realtime.tabs.observers")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (query.data.length === 0) return <EmptyState>{t("realtime.observers.empty")}</EmptyState>
  return (
    <Table>
      <TableCaption>{t("realtime.observers.caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t("realtime.observers.key")}</TableHead>
          <TableHead>{t("realtime.observers.collection")}</TableHead>
          <TableHead>{t("realtime.observers.type")}</TableHead>
          <TableHead>{t("realtime.observers.status")}</TableHead>
          <TableHead>{t("realtime.observers.subscribers")}</TableHead>
          <TableHead>{t("realtime.observers.candidates")}</TableHead>
          <TableHead>{t("realtime.observers.cost")}</TableHead>
          <TableHead>{t("realtime.observers.filter")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {query.data.map((observer) => (
          <TableRow key={observer.key} data-testid="observer">
            <TableCell className="font-mono text-xs">{observer.key}</TableCell>
            <TableCell>{observer.coll}</TableCell>
            <TableCell>{observer.type}</TableCell>
            <TableCell>{observer.status}</TableCell>
            <TableCell>{formatNumber(observer.subscribers)}</TableCell>
            <TableCell>
              {observer.candidatesPerEvent === undefined
                ? t("common.unknown")
                : formatNumber(observer.candidatesPerEvent)}
            </TableCell>
            <TableCell>
              {observer.matchCostMicros === undefined
                ? t("common.unknown")
                : t("realtime.observers.costValue", { value: observer.matchCostMicros })}
            </TableCell>
            <TableCell>
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("realtime.observers.showFilter")}
                </summary>
                <pre className="mt-2 max-w-md overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                  {formatEjson(observer.filter)}
                </pre>
              </details>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
