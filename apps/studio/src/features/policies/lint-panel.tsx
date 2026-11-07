import { useQuery } from "@tanstack/react-query"
import { CheckCircle2Icon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { PolicyDraft } from "../../api/client.ts"
import { useApi } from "../../app/context.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { t } from "../../i18n/index.ts"
import { checkDraft, draftText } from "./model.ts"

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return current
}

const SEVERITY_VARIANT = { error: "destructive", warn: "warning", info: "secondary" } as const

/**
 * Lints the draft locally with `@canopy/policy` on every change, and asks the server to validate it after
 * a pause, since the server also knows the database (indexes, roles).
 */
export function LintPanel({
  collection,
  draft,
}: {
  readonly collection: string
  readonly draft: PolicyDraft
}) {
  const api = useApi()
  const local = useMemo(() => checkDraft(draft), [draft])
  const text = useMemo(() => draftText(draft), [draft])
  const debounced = useDebounced(text, 500)
  const server = useQuery({
    queryKey: ["policies", collection, "validate", debounced],
    queryFn: ({ signal }) => api.validatePolicies(collection, draft, signal),
    enabled: local.errors.length === 0 && debounced === text,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const serverErrors = server.data?.errors.filter(
    (error) => !local.errors.some((message) => message.includes(error.message)),
  )
  const findings = [
    ...local.lint.map((finding) => ({ ...finding, source: "local" as const })),
    ...(server.data?.lint ?? [])
      .filter(
        (finding) =>
          !local.lint.some((l) => l.rule === finding.rule && l.policy === finding.policy),
      )
      .map((finding) => ({ ...finding, source: "server" as const })),
  ]
  const clean =
    local.errors.length === 0 && (serverErrors?.length ?? 0) === 0 && findings.length === 0
  return (
    <section aria-labelledby="lint-title" className="grid gap-2" data-testid="lint-panel">
      <h3 id="lint-title" className="text-sm font-semibold">
        {t("policies.lint.title")}
      </h3>
      <div role="status" aria-live="polite" className="grid gap-2 text-sm">
        {clean ? (
          <p className="flex items-center gap-2 text-success">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            {server.isFetching ? t("policies.lint.checking") : t("policies.lint.clean")}
          </p>
        ) : null}
        <ul className="grid gap-1.5">
          {local.errors.map((message) => (
            <li key={`local:${message}`} className="flex items-start gap-2">
              <Badge variant="destructive">{t("policies.lint.error")}</Badge>
              <span>{message}</span>
            </li>
          ))}
          {(serverErrors ?? []).map((error) => (
            <li key={`server:${error.message}`} className="flex items-start gap-2">
              <Badge variant="destructive">{t("policies.lint.error")}</Badge>
              <span>
                {error.message}{" "}
                <span className="text-muted-foreground">({t("policies.lint.server")})</span>
              </span>
            </li>
          ))}
          {findings.map((finding) => (
            <li
              key={`${finding.source}:${finding.rule}:${finding.policy ?? ""}`}
              className="flex items-start gap-2"
              data-rule={finding.rule}
            >
              <Badge variant={SEVERITY_VARIANT[finding.severity]}>
                {t(`policies.lint.${finding.severity}`)}
              </Badge>
              <span>
                <code className="font-mono text-xs">{finding.rule}</code>
                {finding.policy === undefined ? null : <> · {finding.policy}</>}: {finding.message}
              </span>
            </li>
          ))}
        </ul>
        {server.isError ? (
          <p className="text-xs text-muted-foreground">
            {t("policies.lint.serverUnavailable", {
              message: server.error instanceof Error ? server.error.message : String(server.error),
            })}
          </p>
        ) : null}
      </div>
    </section>
  )
}
