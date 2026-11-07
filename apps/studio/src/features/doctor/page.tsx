import { useQuery } from "@tanstack/react-query"
import { RefreshCwIcon } from "lucide-react"
import { keys, useApi } from "../../app/context.tsx"
import { ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { Button } from "../../components/ui/button.tsx"
import { t } from "../../i18n/index.ts"
import { CheckGroups, countChecks } from "./checks.tsx"

export function DoctorPage() {
  const api = useApi()
  const report = useQuery({ queryKey: keys.doctor, queryFn: ({ signal }) => api.doctor(signal) })
  const counts = report.data === undefined ? undefined : countChecks(report.data.checks)
  return (
    <>
      <PageHeader
        title={t("doctor.title")}
        description={t("doctor.description")}
        actions={
          <Button
            variant="outline"
            onClick={() => void report.refetch()}
            disabled={report.isFetching}
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={report.isFetching ? "animate-spin" : undefined}
            />
            {report.isFetching ? t("doctor.running") : t("doctor.rerun")}
          </Button>
        }
      />
      {report.isPending ? (
        <LoadingState rows={6} />
      ) : report.isError ? (
        <ErrorState
          error={report.error}
          feature={t("doctor.title")}
          onRetry={() => void report.refetch()}
        />
      ) : (
        <div className="grid gap-6">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" role="status">
            <strong>
              {t("doctor.summary", {
                errors: counts?.error ?? 0,
                warnings: counts?.warn ?? 0,
                passed: counts?.ok ?? 0,
              })}
            </strong>
            {report.data.topology === undefined ? null : (
              <span className="text-muted-foreground">
                {t("doctor.topology", { value: report.data.topology })}
              </span>
            )}
            {report.data.serverVersion === undefined ? null : (
              <span className="text-muted-foreground">
                {t("doctor.serverVersion", { value: report.data.serverVersion })}
              </span>
            )}
          </div>
          <CheckGroups checks={report.data.checks} />
        </div>
      )}
    </>
  )
}
