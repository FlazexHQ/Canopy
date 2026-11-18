import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { keys, useApi } from "../../app/context.tsx"
import { ErrorState, KpiStrip, LoadingState, Section } from "../../components/states.tsx"
import { formatNumber, t } from "../../i18n/index.ts"
import { displayValue } from "../../lib/ejson.ts"
import { LagChart } from "./lag-chart.tsx"

function Detail({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{value}</dd>
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
    <div className="grid gap-10">
      <KpiStrip
        items={[
          { label: t("realtime.stats.connections"), value: formatNumber(data.connections) },
          {
            label: t("realtime.stats.sessions"),
            value: data.sessions === undefined ? "" : formatNumber(data.sessions),
          },
          { label: t("realtime.stats.subscriptions"), value: formatNumber(data.subscriptions) },
          {
            label: t("realtime.stats.observers"),
            value: formatNumber(observers),
            note: t("realtime.stats.observersByType", {
              matcher: data.observers["matcher"] ?? 0,
              polling: data.observers["polling"] ?? 0,
            }),
          },
          {
            label: t("realtime.stats.lag"),
            value: data.lagMs === undefined ? "" : `${formatNumber(data.lagMs)} ms`,
            ...(data.lagMs === undefined ? { note: t("realtime.stats.lagNotReported") } : {}),
          },
          {
            label: t("realtime.stats.eventsPerSecond"),
            value: formatNumber(rate ?? tailRate),
            ...(rate === undefined
              ? { note: t("realtime.stats.derivedRate", { rate: tailRate }) }
              : {}),
          },
        ]}
      />
      <Section id="realtime-engine" title={t("realtime.stats.engine")}>
        <dl className="grid gap-2.5 rounded-lg bg-raised px-4 py-3.5">
          <Detail
            label={t("realtime.stats.collections")}
            value={
              data.collections === undefined || data.collections.length === 0 ? (
                <span className="text-muted-foreground">{t("common.none")}</span>
              ) : (
                data.collections.join(", ")
              )
            }
          />
          <Detail
            label={t("realtime.stats.policyVersion")}
            value={
              <span className="font-mono text-[13px]" title={data.policyVersion}>
                {data.policyVersion ?? "-"}
              </span>
            }
          />
          <Detail
            label={t("realtime.stats.streamPosition")}
            value={
              <span className="font-mono text-[13px]">
                {data.streamPosition === undefined ? "-" : displayValue(data.streamPosition)}
              </span>
            }
          />
        </dl>
      </Section>
      <Section id="realtime-chart" title={t("realtime.chart.title")}>
        {data.history === undefined ? (
          <p className="rounded-lg bg-raised px-4 py-3.5 text-sm text-muted-foreground">
            {t("realtime.stats.lagNotReported")}
          </p>
        ) : (
          <LagChart points={data.history} />
        )}
      </Section>
    </div>
  )
}
