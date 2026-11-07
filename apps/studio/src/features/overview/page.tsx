import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CheckCircle2Icon, CircleIcon } from "lucide-react"
import type { ReactNode } from "react"
import type { ApiKey, CollectionSummary, DoctorReport } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx"
import { formatNumber, formatPercent, type MessageKey, t } from "../../i18n/index.ts"
import { CheckItem, SEVERITY } from "../doctor/checks.tsx"
import { summarize } from "../logs-and-audit/denials.ts"

/** One item of the getting started checklist. */
export interface ChecklistItem {
  readonly id: "exposed" | "policy" | "key" | "doctor" | "realtime"
  readonly done: boolean
  readonly to: string
}

/** Derives the getting started checklist from what the server reports. */
export function checklistOf(
  collections: readonly CollectionSummary[] | undefined,
  apiKeys: readonly ApiKey[] | undefined,
  doctor: DoctorReport | undefined,
): ChecklistItem[] {
  const list = collections ?? []
  return [
    { id: "exposed", done: list.some((c) => c.exposed), to: "/data" },
    {
      id: "policy",
      done: list.some((c) => (c.policyVersion ?? 0) > 0),
      to: "/policies",
    },
    {
      id: "key",
      done: (apiKeys ?? []).some(
        (key) =>
          key.kind === "publishable" && (key.revokedAt === undefined || key.revokedAt === null),
      ),
      to: "/api",
    },
    {
      id: "doctor",
      done: doctor?.checks.every((check) => check.status !== "error") === true,
      to: "/doctor",
    },
    { id: "realtime", done: list.some((c) => c.realtime), to: "/data" },
  ]
}

function Metric({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

export function OverviewPage() {
  const api = useApi()
  const session = useSession()
  const doctor = useQuery({ queryKey: keys.doctor, queryFn: ({ signal }) => api.doctor(signal) })
  const stats = useQuery({
    queryKey: keys.realtimeStats,
    queryFn: ({ signal }) => api.realtimeStats(signal),
    refetchInterval: 10_000,
  })
  const logs = useQuery({ queryKey: keys.logs, queryFn: ({ signal }) => api.logs({}, signal) })
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
  })
  const apiKeys = useQuery({ queryKey: keys.apiKeys, queryFn: ({ signal }) => api.apiKeys(signal) })

  const notReported = t("overview.notReported")
  const summary = logs.data === undefined ? undefined : summarize(logs.data)
  const findings = (doctor.data?.checks ?? [])
    .filter((check) => check.status === "error" || check.status === "warn")
    .sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status))
  const checklist = checklistOf(collections.data, apiKeys.data, doctor.data)
  const done = checklist.filter((item) => item.done).length

  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("overview.health")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Metric label={t("overview.topology")} value={doctor.data?.topology ?? notReported} />
              <Metric
                label={t("overview.mongoVersion")}
                value={doctor.data?.serverVersion ?? notReported}
              />
              <Metric label={t("overview.canopyVersion")} value={session.version ?? notReported} />
              <Metric
                label={t("overview.lag")}
                value={
                  stats.data?.lagMs === undefined
                    ? notReported
                    : t("overview.ms", { value: stats.data.lagMs })
                }
              />
              <Metric
                label={t("overview.connections")}
                value={
                  stats.data === undefined ? notReported : formatNumber(stats.data.connections)
                }
              />
              <Metric
                label={t("overview.requests")}
                value={
                  summary?.estimatedPerSecond === undefined
                    ? notReported
                    : formatNumber(Math.round(summary.estimatedPerSecond * 10) / 10)
                }
              />
              <Metric
                label={t("overview.errorRate")}
                value={
                  summary === undefined || summary.sampled === 0
                    ? notReported
                    : formatPercent(summary.serverErrorShare)
                }
              />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("overview.checklist")}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t("overview.checklistProgress", { done, total: checklist.length })}
            </p>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2" aria-label={t("overview.checklist")}>
              {checklist.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm" data-done={item.done}>
                  {item.done ? (
                    <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
                  ) : (
                    <CircleIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="sr-only">
                    {item.done ? t("overview.done") : t("overview.todo")}:{" "}
                  </span>
                  {item.done ? (
                    <span className="text-muted-foreground line-through">
                      {t(`overview.items.${item.id}` as MessageKey)}
                    </span>
                  ) : (
                    <Link to={item.to} className="text-primary underline-offset-4 hover:underline">
                      {t(`overview.items.${item.id}` as MessageKey)}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t("overview.problems")}</CardTitle>
            <Button asChild variant="outline" size="sm">
              <Link to="/doctor">{t("overview.openDoctor")}</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {doctor.isPending ? (
              <LoadingState rows={2} />
            ) : doctor.isError ? (
              <ErrorState error={doctor.error} onRetry={() => void doctor.refetch()} />
            ) : findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("overview.noProblems")}</p>
            ) : (
              <ul className="grid gap-2">
                {findings.map((check) => (
                  <CheckItem key={check.id} check={check} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
