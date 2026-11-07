import { CanopyError, ErrorCode } from "@canopy/protocol"
import { AlertTriangleIcon, InboxIcon, LockIcon, PlugZapIcon } from "lucide-react"
import type { ReactNode } from "react"
import { statusOf } from "../api/client.ts"
import { t } from "../i18n/index.ts"
import { cn } from "../lib/utils.ts"
import { Button } from "./ui/button.tsx"
import { Skeleton } from "./ui/misc.tsx"

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly actions?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  )
}

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
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center",
        className,
      )}
    >
      <div className="text-muted-foreground [&_svg]:size-8" aria-hidden="true">
        {icon ?? <InboxIcon />}
      </div>
      <h2 className="font-medium">{title}</h2>
      {children === undefined ? null : (
        <div className="max-w-prose text-sm text-muted-foreground">{children}</div>
      )}
      {action}
    </div>
  )
}

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
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/50 p-4"
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangleIcon className="size-4" aria-hidden="true" />
        {t("common.errorTitle")}
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry === undefined ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  )
}
