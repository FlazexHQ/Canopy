import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useId, useState } from "react"
import { type LogsPage as LogsPageData, REQUEST_SURFACES } from "../../api/contract.ts"
import { keys, useApi } from "../../app/context.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { formatDateTime, formatNumber, formatPercent, formatRelative, t } from "../../i18n/index.ts"
import { NativeSelect } from "../realtime/native-select.tsx"
import { groupDenials, STATUS_FILTERS, type StatusFilter, summarize } from "./denials.ts"

const TABS = ["requests", "audit", "denials"] as const

function statusVariant(status: number): "success" | "warning" | "destructive" {
  return status >= 500 ? "destructive" : status >= 400 ? "warning" : "success"
}

function Summary({ data }: { readonly data: LogsPageData }) {
  const summary = summarize(data)
  return (
    <dl className="grid gap-3 sm:grid-cols-4">
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.requestsPerSecond")}</dt>
        <dd className="mt-1 text-2xl font-semibold">
          {summary.estimatedPerSecond === undefined
            ? t("common.unknown")
            : formatNumber(Math.round(summary.estimatedPerSecond * 10) / 10)}
        </dd>
      </div>
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.serverErrors")}</dt>
        <dd className="mt-1 text-2xl font-semibold">{formatPercent(summary.serverErrorShare)}</dd>
      </div>
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.sampleRate")}</dt>
        <dd className="mt-1 text-2xl font-semibold">{formatPercent(data.sampleRate)}</dd>
      </div>
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.retention")}</dt>
        <dd className="mt-1 text-2xl font-semibold">
          {t("logs.summary.retentionDays", { days: data.retentionDays })}
        </dd>
      </div>
    </dl>
  )
}

const SURFACE_FILTERS = ["", ...REQUEST_SURFACES] as const

function RequestsView() {
  const api = useApi()
  const [surface, setSurface] = useState<(typeof SURFACE_FILTERS)[number]>("")
  const [status, setStatus] = useState<StatusFilter>("")
  const surfaceId = useId()
  const statusId = useId()
  const query = useInfiniteQuery({
    queryKey: [...keys.logs, surface, status],
    queryFn: ({ signal, pageParam }) =>
      api.logs(
        {
          ...(surface === "" ? {} : { surface }),
          ...(status === "" ? {} : { status }),
          ...(pageParam === undefined ? {} : { before: pageParam }),
          limit: 100,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.entries.length < 100 ? undefined : last.next),
    refetchInterval: 15_000,
  })
  const pages = query.data?.pages ?? []
  const entries = pages.flatMap((page) => page.entries)
  const first = pages[0]
  return (
    <div className="grid gap-4">
      {query.isError ? (
        <ErrorState
          error={query.error}
          feature={t("logs.tabs.requests")}
          onRetry={() => void query.refetch()}
        />
      ) : first === undefined ? (
        <LoadingState />
      ) : (
        <>
          <Summary data={{ ...first, entries }} />
          <div className="flex flex-wrap gap-4">
            <div className="grid w-fit gap-1.5">
              <Label htmlFor={surfaceId}>{t("logs.requests.surface")}</Label>
              <NativeSelect
                id={surfaceId}
                value={surface}
                onChange={(event) => setSurface(event.target.value as typeof surface)}
              >
                {SURFACE_FILTERS.map((option) => (
                  <option key={option} value={option}>
                    {t(`logs.surfaces.${option === "" ? "all" : option}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid w-fit gap-1.5">
              <Label htmlFor={statusId}>{t("logs.requests.filter")}</Label>
              <NativeSelect
                id={statusId}
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option} value={option}>
                    {t(`logs.statuses.${option === "" ? "all" : option}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          {entries.length === 0 ? (
            <EmptyState>
              {first.sampleRate === 0 ? t("logs.requests.off") : t("logs.requests.empty")}
            </EmptyState>
          ) : (
            <Table>
              <TableCaption>{t("logs.requests.caption")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("logs.requests.time")}</TableHead>
                  <TableHead>{t("logs.requests.surface")}</TableHead>
                  <TableHead>{t("logs.requests.method")}</TableHead>
                  <TableHead>{t("logs.requests.path")}</TableHead>
                  <TableHead>{t("logs.requests.status")}</TableHead>
                  <TableHead>{t("logs.requests.duration")}</TableHead>
                  <TableHead>{t("logs.requests.address")}</TableHead>
                  <TableHead>{t("logs.requests.requestId")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id} data-testid="log-entry">
                    <TableCell className="whitespace-nowrap" title={formatDateTime(entry.at)}>
                      {formatRelative(entry.at)}
                    </TableCell>
                    <TableCell>{t(`logs.surfaces.${entry.surface}`)}</TableCell>
                    <TableCell className="font-mono text-xs">{entry.method}</TableCell>
                    <TableCell className="font-mono text-xs">{entry.path}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(entry.status)}>{entry.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {t("logs.requests.durationValue", { value: entry.durationMs })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.ip ?? ""}</TableCell>
                    <TableCell className="font-mono text-xs">{entry.requestId ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {query.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("logs.requests.older")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function AuditView() {
  const api = useApi()
  const [action, setAction] = useState("")
  const id = useId()
  const query = useQuery({
    queryKey: [...keys.audit, action],
    queryFn: ({ signal }) => api.audit(action === "" ? {} : { action }, signal),
  })
  return (
    <div className="grid gap-4">
      <div className="grid w-fit gap-1.5">
        <Label htmlFor={id}>{t("logs.audit.filter")}</Label>
        <Input
          id={id}
          value={action}
          placeholder={t("logs.audit.filterPlaceholder")}
          className="w-64 font-mono"
          onChange={(event) => setAction(event.target.value.trim())}
        />
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          feature={t("logs.tabs.audit")}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.entries.length === 0 ? (
        <EmptyState>{t("logs.audit.empty")}</EmptyState>
      ) : (
        <Table>
          <TableCaption>{t("logs.audit.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("logs.audit.time")}</TableHead>
              <TableHead>{t("logs.audit.actor")}</TableHead>
              <TableHead>{t("logs.audit.action")}</TableHead>
              <TableHead>{t("logs.audit.target")}</TableHead>
              <TableHead>{t("logs.audit.comment")}</TableHead>
              <TableHead>{t("logs.audit.diff")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.entries.map((entry) => (
              <TableRow key={entry.id} data-testid="audit-entry">
                <TableCell className="whitespace-nowrap" title={formatDateTime(entry.at)}>
                  {formatRelative(entry.at)}
                </TableCell>
                <TableCell>
                  {entry.actor}
                  {entry.impersonating === undefined ? null : (
                    <span className="block text-xs text-warning">
                      {t("logs.audit.impersonating", { who: entry.impersonating })}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                <TableCell className="font-mono text-xs">{entry.target ?? ""}</TableCell>
                <TableCell>{entry.comment ?? ""}</TableCell>
                <TableCell>
                  {entry.diff === undefined ? null : (
                    <details>
                      <summary className="cursor-pointer text-sm">
                        {t("logs.audit.showDiff")}
                      </summary>
                      <pre className="mt-2 max-w-md overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                        {JSON.stringify(entry.diff, null, 2)}
                      </pre>
                    </details>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

function DenialsView() {
  const api = useApi()
  const query = useQuery({
    queryKey: [...keys.logs, "denials"],
    queryFn: async ({ signal }) => {
      const [unauthorized, forbidden] = await Promise.all([
        api.logs({ status: "401", limit: 1000 }, signal),
        api.logs({ status: "403", limit: 1000 }, signal),
      ])
      return groupDenials([...unauthorized.entries, ...forbidden.entries])
    },
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("logs.tabs.requests")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const groups = query.data
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t("logs.denials.intro")}</p>
      {groups.length === 0 ? (
        <EmptyState>{t("logs.denials.empty")}</EmptyState>
      ) : (
        <Table>
          <TableCaption>{t("logs.denials.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("logs.denials.count")}</TableHead>
              <TableHead>{t("logs.denials.surface")}</TableHead>
              <TableHead>{t("logs.denials.collection")}</TableHead>
              <TableHead>{t("logs.denials.operation")}</TableHead>
              <TableHead>{t("logs.denials.status")}</TableHead>
              <TableHead>{t("logs.denials.last")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow
                key={JSON.stringify([
                  group.surface,
                  group.collection,
                  group.operation,
                  group.status,
                ])}
                data-testid="denial-group"
              >
                <TableCell className="font-semibold">{formatNumber(group.count)}</TableCell>
                <TableCell>{t(`logs.surfaces.${group.surface}`)}</TableCell>
                <TableCell>{group.collection ?? ""}</TableCell>
                <TableCell>{group.operation ?? ""}</TableCell>
                <TableCell>
                  {group.status === 401
                    ? t("logs.denials.unauthorized")
                    : t("logs.denials.forbidden")}
                </TableCell>
                <TableCell title={formatDateTime(group.last)}>
                  {formatRelative(group.last)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

/** Sampled request logs, the audit log of admin and policy changes, and the denials explorer. */
export function LogsPage() {
  return (
    <>
      <PageHeader title={t("logs.title")} description={t("logs.description")} />
      <Tabs defaultValue="requests" className="grid gap-4">
        <TabsList aria-label={t("logs.tabs.label")}>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`logs.tabs.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="requests" className="grid gap-4">
          <RequestsView />
        </TabsContent>
        <TabsContent value="audit">
          <AuditView />
        </TabsContent>
        <TabsContent value="denials">
          <DenialsView />
        </TabsContent>
      </Tabs>
    </>
  )
}
