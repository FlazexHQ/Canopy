import { useQuery } from "@tanstack/react-query"
import { useId, useState } from "react"
import type { LogsPage as LogsPageData } from "../../api/contract.ts"
import { keys, useApi } from "../../app/context.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
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
import { groupDenials, matchesStatus, STATUS_FILTERS, type StatusFilter } from "./denials.ts"

const TABS = ["requests", "audit", "denials"] as const

function statusVariant(status: number): "success" | "warning" | "destructive" {
  return status >= 500 ? "destructive" : status >= 400 ? "warning" : "success"
}

function useLogs() {
  const api = useApi()
  return useQuery({
    queryKey: keys.logs,
    queryFn: ({ signal }) => api.logs({}, signal),
    refetchInterval: 15_000,
  })
}

function Summary({ data }: { readonly data: LogsPageData }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.requestsPerSecond")}</dt>
        <dd className="mt-1 text-2xl font-semibold">
          {data.summary === undefined
            ? t("common.unknown")
            : formatNumber(data.summary.requestsPerSecond)}
        </dd>
      </div>
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.errorRate")}</dt>
        <dd className="mt-1 text-2xl font-semibold">
          {data.summary === undefined ? t("common.unknown") : formatPercent(data.summary.errorRate)}
        </dd>
      </div>
      <div className="rounded-lg border p-4">
        <dt className="text-sm text-muted-foreground">{t("logs.summary.sampled")}</dt>
        <dd className="mt-1 text-2xl font-semibold">{formatNumber(data.entries.length)}</dd>
      </div>
    </dl>
  )
}

function RequestsView({ data }: { readonly data: LogsPageData }) {
  const [filter, setFilter] = useState<StatusFilter>("all")
  const id = useId()
  const shown = data.entries.filter((entry) => matchesStatus(entry, filter))
  return (
    <div className="grid gap-4">
      <div className="grid w-fit gap-1.5">
        <Label htmlFor={id}>{t("logs.requests.filter")}</Label>
        <NativeSelect
          id={id}
          value={filter}
          onChange={(event) => setFilter(event.target.value as StatusFilter)}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option} value={option}>
              {t(`logs.requests.${option}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {shown.length === 0 ? (
        <EmptyState>{t("logs.requests.empty")}</EmptyState>
      ) : (
        <Table>
          <TableCaption>{t("logs.requests.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("logs.requests.time")}</TableHead>
              <TableHead>{t("logs.requests.method")}</TableHead>
              <TableHead>{t("logs.requests.path")}</TableHead>
              <TableHead>{t("logs.requests.status")}</TableHead>
              <TableHead>{t("logs.requests.duration")}</TableHead>
              <TableHead>{t("logs.requests.role")}</TableHead>
              <TableHead>{t("logs.requests.code")}</TableHead>
              <TableHead>{t("logs.requests.requestId")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((entry, index) => (
              <TableRow key={entry.requestId ?? `${entry.at}:${index}`} data-testid="log-entry">
                <TableCell className="whitespace-nowrap" title={formatDateTime(entry.at)}>
                  {formatRelative(entry.at)}
                </TableCell>
                <TableCell className="font-mono text-xs">{entry.method}</TableCell>
                <TableCell className="font-mono text-xs">{entry.path}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(entry.status)}>{entry.status}</Badge>
                </TableCell>
                <TableCell>
                  {t("logs.requests.durationValue", { value: entry.durationMs })}
                </TableCell>
                <TableCell>{entry.role ?? ""}</TableCell>
                <TableCell className="font-mono text-xs">{entry.code ?? ""}</TableCell>
                <TableCell className="font-mono text-xs">{entry.requestId ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

function DenialsView({ data }: { readonly data: LogsPageData }) {
  const groups = groupDenials(data.entries)
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
              <TableHead>{t("logs.denials.collection")}</TableHead>
              <TableHead>{t("logs.denials.operation")}</TableHead>
              <TableHead>{t("logs.denials.role")}</TableHead>
              <TableHead>{t("logs.denials.policy")}</TableHead>
              <TableHead>{t("logs.denials.code")}</TableHead>
              <TableHead>{t("logs.denials.last")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow
                key={JSON.stringify([
                  group.collection,
                  group.operation,
                  group.role,
                  group.policy,
                  group.code,
                ])}
                data-testid="denial-group"
              >
                <TableCell className="font-semibold">{formatNumber(group.count)}</TableCell>
                <TableCell>{group.collection ?? t("common.unknown")}</TableCell>
                <TableCell>{group.operation ?? ""}</TableCell>
                <TableCell>{group.role ?? ""}</TableCell>
                <TableCell>{group.policy ?? t("logs.denials.noPolicy")}</TableCell>
                <TableCell className="font-mono text-xs">{group.code ?? ""}</TableCell>
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
  const logs = useLogs()
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
        <TabsContent value="audit">
          <AuditView />
        </TabsContent>
        {(["requests", "denials"] as const).map((name) => (
          <TabsContent key={name} value={name} className="grid gap-4">
            {logs.isPending ? (
              <LoadingState />
            ) : logs.isError ? (
              <ErrorState
                error={logs.error}
                feature={t("logs.tabs.requests")}
                onRetry={() => void logs.refetch()}
              />
            ) : (
              <>
                <Summary data={logs.data} />
                {name === "requests" ? (
                  <RequestsView data={logs.data} />
                ) : (
                  <DenialsView data={logs.data} />
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </>
  )
}
