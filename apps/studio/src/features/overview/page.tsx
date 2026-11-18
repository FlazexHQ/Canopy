import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowUpRightIcon, CheckIcon } from "lucide-react"
import type { ApiKey, CollectionSummary, DoctorReport } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { EXPOSURE_BADGE, exposureOf } from "../../app/exposure.ts"
import {
  EmptyState,
  ErrorState,
  KpiStrip,
  LoadingState,
  PageHeader,
  Section,
} from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { buttonVariants } from "../../components/ui/button.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatNumber, formatPercent, type MessageKey, t } from "../../i18n/index.ts"
import { CheckItem, checkTitle, SEVERITY } from "../doctor/checks.tsx"
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

function Checklist({ items }: { readonly items: readonly ChecklistItem[] }) {
  const done = items.filter((item) => item.done).length
  return (
    <Section
      id="overview-checklist"
      title={t("overview.checklist")}
      action={
        <p className="text-sm text-muted-foreground tabular-nums">
          {t("overview.checklistProgress", { done, total: items.length })}
        </p>
      }
    >
      <ul
        aria-label={t("overview.checklist")}
        className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-5"
      >
        {items.map((item) => {
          const label = t(`overview.items.${item.id}` as MessageKey)
          return (
            <li key={item.id} data-done={item.done} className="relative bg-card">
              <span className="sr-only">
                {item.done ? t("overview.done") : t("overview.todo")}:{" "}
              </span>
              {item.done ? (
                <div className="flex h-full min-h-20 flex-col justify-between gap-3 px-4 py-3.5 text-muted-foreground">
                  <CheckIcon className="size-4 text-success" aria-hidden="true" />
                  <span className="text-sm">{label}</span>
                </div>
              ) : (
                <Link
                  to={item.to}
                  className="group flex h-full min-h-20 flex-col justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-raised"
                >
                  <ArrowUpRightIcon
                    className="size-4 self-end text-muted-foreground transition-colors group-hover:text-foreground"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium">{label}</span>
                </Link>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function CollectionsBlock({
  collections,
}: {
  readonly collections: ReturnType<typeof useQuery<readonly CollectionSummary[]>>
}) {
  const list = [...(collections.data ?? [])].sort(
    (a, b) => Number(b.exposed) - Number(a.exposed) || a.name.localeCompare(b.name),
  )
  const exposed = list.filter((collection) => collection.exposed).length
  return (
    <Section
      id="overview-collections"
      title={t("overview.collections.title")}
      description={
        collections.data === undefined
          ? undefined
          : t("overview.collections.summary", { exposed, total: list.length })
      }
      action={
        <Link to="/data" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          {t("overview.viewAll")}
        </Link>
      }
    >
      {collections.isPending ? (
        <LoadingState rows={4} />
      ) : collections.isError ? (
        <ErrorState error={collections.error} onRetry={() => void collections.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState title={t("overview.collections.emptyTitle")}>
          {t("overview.collections.empty")}
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-1/3">{t("overview.collections.name")}</TableHead>
              <TableHead className="text-right">{t("overview.collections.documents")}</TableHead>
              <TableHead>{t("overview.collections.access")}</TableHead>
              <TableHead>{t("overview.collections.realtime")}</TableHead>
              <TableHead className="text-right">{t("overview.collections.policies")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.slice(0, 6).map((collection) => {
              const access = exposureOf(collection)
              return (
                <TableRow key={collection.name}>
                  <TableCell className="font-medium">
                    <Link
                      to="/data/$collection"
                      params={{ collection: collection.name }}
                      className="hover:underline"
                    >
                      {collection.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {collection.estimatedCount === undefined ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      formatNumber(collection.estimatedCount)
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={EXPOSURE_BADGE[access]}>
                      {t(`overview.collections.accessKinds.${access}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {collection.realtime ? t("common.on") : t("common.off")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      to="/policies/$collection"
                      params={{ collection: collection.name }}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {collection.policyVersion === null || collection.policyVersion === undefined
                        ? t("overview.collections.noVersion")
                        : t("overview.collections.version", { version: collection.policyVersion })}
                    </Link>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </Section>
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
  const errors = findings.filter((check) => check.status === "error").length
  const checklist = checklistOf(collections.data, apiKeys.data, doctor.data)
  const errorShare =
    summary === undefined || summary.sampled === 0 ? undefined : summary.serverErrorShare

  return (
    <>
      <PageHeader
        title={t("overview.title")}
        description={
          <dl className="flex flex-wrap gap-x-5 gap-y-1">
            {[
              [t("overview.topology"), doctor.data?.topology ?? notReported],
              [t("overview.mongoVersion"), doctor.data?.serverVersion ?? notReported],
              [t("overview.canopyVersion"), session.version ?? notReported],
            ].map(([label, value]) => (
              <div key={label} className="flex gap-1.5">
                <dt>{label}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        }
        actions={
          <Link to="/doctor" className={buttonVariants({ variant: "outline" })}>
            {t("overview.openDoctor")}
          </Link>
        }
      />
      <div className="flex flex-col gap-10">
        {checklist.every((item) => item.done) ? null : <Checklist items={checklist} />}
        <Section id="overview-traffic" title={t("overview.traffic")}>
          <KpiStrip
            items={[
              {
                label: t("overview.lag"),
                value:
                  stats.data?.lagMs === undefined
                    ? notReported
                    : t("overview.ms", { value: stats.data.lagMs }),
                missing: stats.data?.lagMs === undefined,
              },
              {
                label: t("overview.connections"),
                value:
                  stats.data === undefined ? notReported : formatNumber(stats.data.connections),
                missing: stats.data === undefined,
              },
              {
                label: t("overview.requests"),
                value:
                  summary?.estimatedPerSecond === undefined
                    ? notReported
                    : formatNumber(Math.round(summary.estimatedPerSecond * 10) / 10),
                missing: summary?.estimatedPerSecond === undefined,
              },
              {
                label: t("overview.errorRate"),
                value: errorShare === undefined ? notReported : formatPercent(errorShare),
                missing: errorShare === undefined,
                ...(errorShare !== undefined && errorShare > 0.01
                  ? { tone: "negative" as const }
                  : {}),
                ...(summary === undefined || summary.sampled === 0
                  ? {}
                  : { note: t("overview.sampled", { count: summary.sampled }) }),
              },
            ]}
          />
        </Section>
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <CollectionsBlock collections={collections} />
          <Section
            id="overview-findings"
            title={t("overview.problems")}
            description={
              doctor.data === undefined
                ? undefined
                : findings.length === 0
                  ? t("overview.noProblems")
                  : t("overview.findingsSummary", {
                      errors,
                      warnings: findings.length - errors,
                    })
            }
          >
            {doctor.isPending ? (
              <LoadingState rows={2} />
            ) : doctor.isError ? (
              <ErrorState error={doctor.error} onRetry={() => void doctor.refetch()} />
            ) : findings.length === 0 ? (
              <ul className="grid gap-2.5 rounded-lg bg-raised px-4 py-3.5">
                {doctor.data.checks.map((check) => (
                  <li key={check.id} className="flex items-center gap-2.5 text-sm">
                    <CheckIcon className="size-4 text-success" aria-hidden="true" />
                    {checkTitle(check)}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="grid">
                {findings.slice(0, 5).map((check) => (
                  <CheckItem key={check.id} check={check} />
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}
