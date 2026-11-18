import { CanopyError, ErrorCode } from "@canopy/protocol"
import { AlertTriangleIcon, LockIcon, PlugZapIcon } from "lucide-react"
import type { ReactNode } from "react"
import { statusOf } from "../api/client.ts"
import { t } from "../i18n/index.ts"
import { cn } from "../lib/utils.ts"
import { Button } from "./ui/button.tsx"
import { Skeleton } from "./ui/misc.tsx"

/** The title row of a page: the h1, one grey sentence about the data, and the page's real actions. */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
  readonly back?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-col gap-3">
      {back === undefined ? null : <div className="-ml-1">{back}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold break-words">{title}</h1>
          {description === undefined ? null : (
            <div className="mt-1 max-w-[72ch] text-sm text-muted-foreground">{description}</div>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  )
}

/** A section of a page: a heading on the left, an optional quiet action on the right. */
export function Section({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly id?: string
}) {
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** One cell of a {@link KpiStrip}: a grey label over a figure at regular weight. */
export interface Kpi {
  readonly label: string
  readonly value: ReactNode
  readonly note?: ReactNode
  readonly tone?: "negative" | "warning"
  /** Set when the server reports no figure: the label then reads as a quiet note, not a value. */
  readonly missing?: boolean
}

const COLUMNS: Readonly<Record<number, string>> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-3 lg:grid-cols-6",
}

/** Headline figures in one container split by 1px dividers into equal columns. */
export function KpiStrip({
  items,
  className,
}: {
  readonly items: readonly Kpi[]
  readonly className?: string
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border",
        COLUMNS[items.length] ?? "sm:grid-cols-4",
        className,
      )}
    >
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3.5 max-sm:last:odd:col-span-2"
        >
          <dt className="truncate text-[13px] text-muted-foreground">{item.label}</dt>
          <dd
            className={cn(
              item.missing === true
                ? "line-clamp-2 pt-1.5 text-sm text-muted-foreground"
                : "truncate text-kpi tabular-nums",
              item.tone === "negative" && "text-destructive",
              item.tone === "warning" && "text-warning",
            )}
          >
            {item.value}
          </dd>
          {item.note === undefined ? null : (
            <dd className="line-clamp-2 text-xs text-muted-foreground">{item.note}</dd>
          )}
        </div>
      ))}
    </dl>
  )
}

/** A quiet message where a block has nothing to show, with what to do next. */
export function EmptyState({
  title = t("common.emptyTitle"),
  children,
  icon,
  action,
  className,
}: {
  readonly title?: ReactNode
  readonly children?: ReactNode
  readonly icon?: ReactNode
  readonly action?: ReactNode
  readonly className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-lg bg-raised px-5 py-5 text-left",
        className,
      )}
    >
      {icon === undefined ? null : (
        <div className="mb-1 text-muted-foreground [&_svg]:size-5" aria-hidden="true">
          {icon}
        </div>
      )}
      <h2 className="text-sm font-medium">{title}</h2>
      {children === undefined ? null : (
        <div className="max-w-prose text-sm text-muted-foreground">{children}</div>
      )}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  )
}

/** Placeholder rows while a block loads. */
export function LoadingState({
  rows = 3,
  label,
}: {
  readonly rows?: number
  readonly label?: string
}) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <span className="sr-only">{label ?? t("common.loading")}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  )
}

/**
 * Shows a failed query. A 404 from the admin API means the server does not offer the feature yet, and a 403
 * that the admin's role cannot see it; both get their own explanation instead of an error.
 */
export function ErrorState({
  error,
  feature,
  onRetry,
}: {
  readonly error: unknown
  readonly feature?: string
  readonly onRetry?: () => void
}) {
  const status = statusOf(error)
  if (status === 404 && feature !== undefined) {
    return (
      <EmptyState icon={<PlugZapIcon />} title={t("common.notAvailableTitle")}>
        {t("common.notAvailableBody", { feature })}
      </EmptyState>
    )
  }
  if (error instanceof CanopyError && error.code === ErrorCode.Forbidden) {
    return (
      <EmptyState icon={<LockIcon />} title={t("common.forbiddenTitle")}>
        {t("common.forbiddenBody")}
      </EmptyState>
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg bg-pill-negative px-4 py-3.5 text-pill-negative-ink"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangleIcon className="size-4" aria-hidden="true" />
        {t("common.errorTitle")}
      </div>
      <p className="text-sm opacity-90">{message}</p>
      {onRetry === undefined ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  )
}
