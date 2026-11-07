import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { keys, useApi } from "../../app/context.tsx"
import { ErrorState, LoadingState } from "../../components/states.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx"
import { formatNumber, t } from "../../i18n/index.ts"
import { displayValue } from "../../lib/ejson.ts"
import { LagChart } from "./lag-chart.tsx"

function Stat({
  label,
  value,
  hint,
}: {
  readonly label: string
  readonly value: ReactNode
  readonly hint?: ReactNode
}) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className="mt-1 truncate text-2xl font-semibold"
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </dd>
      {hint === undefined ? null : <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

/** Engine wide counts and the lag chart, refreshed every five seconds. */
export function RealtimeOverview({ tailRate }: { readonly tailRate: number }) {
  const api = useApi()
  const stats = useQuery({
    queryKey: keys.realtimeStats,
    queryFn: ({ signal }) => api.realtimeStats(signal),
    refetchInterval: 5000,
  })
  if (stats.isPending) return <LoadingState rows={4} />
  if (stats.isError) {
    return (
      <ErrorState
        error={stats.error}
        feature={t("realtime.title")}
        onRetry={() => void stats.refetch()}
      />
    )
  }
  const data = stats.data
  const observers = Object.values(data.observers).reduce((total, count) => total + count, 0)
  const rate = data.eventsPerSecond
  return (
    <div className="grid gap-6">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("realtime.stats.connections")} value={formatNumber(data.connections)} />
        <Stat
          label={t("realtime.stats.sessions")}
          value={data.sessions === undefined ? "" : formatNumber(data.sessions)}
        />
        <Stat label={t("realtime.stats.subscriptions")} value={formatNumber(data.subscriptions)} />
        <Stat
          label={t("realtime.stats.observers")}
          value={formatNumber(observers)}
          hint={t("realtime.stats.observersByType", {
            matcher: data.observers["matcher"] ?? 0,
            polling: data.observers["polling"] ?? 0,
          })}
        />
        <Stat
          label={t("realtime.stats.lag")}
          value={data.lagMs === undefined ? "" : `${formatNumber(data.lagMs)} ms`}
          {...(data.lagMs === undefined ? { hint: t("realtime.stats.lagNotReported") } : {})}
        />
        <Stat
          label={t("realtime.stats.eventsPerSecond")}
          value={formatNumber(rate ?? tailRate)}
          {...(rate === undefined
            ? { hint: t("realtime.stats.derivedRate", { rate: tailRate }) }
            : {})}
        />
        <Stat label={t("realtime.stats.policyVersion")} value={data.policyVersion ?? ""} />
        <Stat
          label={t("realtime.stats.streamPosition")}
          value={data.streamPosition === undefined ? "" : displayValue(data.streamPosition)}
        />
      </dl>
      {data.collections === undefined ? null : (
        <p className="text-sm">
          <span className="text-muted-foreground">{t("realtime.stats.collections")}: </span>
          {data.collections.join(", ")}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("realtime.chart.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.history === undefined ? (
            <p className="text-sm text-muted-foreground">{t("realtime.stats.lagNotReported")}</p>
          ) : (
            <LagChart points={data.history} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
