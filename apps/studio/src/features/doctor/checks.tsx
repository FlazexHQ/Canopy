import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  InfoIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import type { CheckStatus, DoctorCheck } from "../../api/contract.ts"
import { CodeBlock } from "../../components/copy-button.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { en } from "../../i18n/en/index.ts"
import { t } from "../../i18n/index.ts"

/** Severity order, most severe first. */
export const SEVERITY: readonly CheckStatus[] = ["error", "warn", "info", "ok"]

const COMMAND = /^(canopy|docker|db\.|mongosh|bun|bunx|npx|pnpm|kubectl|rs\.)\b/

/** Splits a fix into its prose and, when it carries one, the command to run. */
export function splitFix(fix: string): { readonly prose?: string; readonly command?: string } {
  const trimmed = fix.trim()
  if (COMMAND.test(trimmed)) return { command: trimmed }
  const index = trimmed.indexOf(": ")
  if (index > 0) {
    const rest = trimmed.slice(index + 2).trim()
    if (COMMAND.test(rest)) return { prose: trimmed.slice(0, index), command: rest }
  }
  return { prose: trimmed }
}

const ICONS: Record<CheckStatus, ReactNode> = {
  error: <AlertCircleIcon className="size-4 text-destructive" aria-hidden="true" />,
  warn: <AlertTriangleIcon className="size-4 text-warning" aria-hidden="true" />,
  info: <InfoIcon className="size-4 text-muted-foreground" aria-hidden="true" />,
  ok: <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />,
}

const VARIANTS = {
  error: "destructive",
  warn: "warning",
  info: "secondary",
  ok: "success",
} as const

/** Counts checks by status. */
export function countChecks(checks: readonly DoctorCheck[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { error: 0, warn: 0, info: 0, ok: 0 }
  for (const check of checks) counts[check.status] += 1
  return counts
}

const NAMES = en.doctor.names

/** The title of a check: a known check name in words, or the server's own title. */
function checkTitle(check: DoctorCheck): string {
  return Object.hasOwn(NAMES, check.id)
    ? t(`doctor.names.${check.id as keyof typeof NAMES}`)
    : check.title
}

/** One doctor check with its explanation, fix and docs link. */
export function CheckItem({ check }: { readonly check: DoctorCheck }) {
  const fix = check.fix === undefined ? undefined : splitFix(check.fix)
  return (
    <li className="flex gap-3 rounded-lg border p-3" data-testid={`check-${check.id}`}>
      <div className="pt-0.5">{ICONS[check.status]}</div>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{checkTitle(check)}</h3>
          <Badge variant={VARIANTS[check.status]}>{t(`common.status.${check.status}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{check.message}</p>
        {fix === undefined ? null : (
          <div className="grid gap-1.5 text-sm">
            <p>
              <span className="font-medium">{t("doctor.fix")}: </span>
              {fix.prose}
            </p>
            {fix.command === undefined ? null : (
              <CodeBlock code={fix.command} what={t("doctor.fixLabel")} />
            )}
          </div>
        )}
        {check.docs === undefined ? null : (
          <a
            href={check.docs}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            {t("doctor.docs", { title: checkTitle(check) })}
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  )
}

/** Doctor checks grouped by severity, most severe first. */
export function CheckGroups({
  checks,
  headingLevel = 2,
}: {
  readonly checks: readonly DoctorCheck[]
  readonly headingLevel?: 2 | 3
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3"
  return (
    <div className="grid gap-6">
      {SEVERITY.map((status) => {
        const group = checks.filter((check) => check.status === status)
        if (group.length === 0) return null
        return (
          <section key={status} aria-labelledby={`doctor-group-${status}`} className="grid gap-2">
            <Heading id={`doctor-group-${status}`} className="text-sm font-semibold">
              {t(`doctor.groups.${status}`)} ({group.length})
            </Heading>
            <ul className="grid gap-2">
              {group.map((check) => (
                <CheckItem key={check.id} check={check} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
