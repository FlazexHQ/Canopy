import { t } from "../../i18n/index.ts"
import { cn } from "../../lib/utils.ts"
import { diffLines } from "./model.ts"

/** A line diff of two texts, with added and removed lines marked for screen readers too. */
export function DiffView({
  before,
  after,
  label,
}: {
  readonly before: string
  readonly after: string
  readonly label: string
}) {
  const lines = diffLines(before, after)
  if (lines.every((line) => line.kind === "same")) {
    return <p className="text-sm text-muted-foreground">{t("policies.diff.noChanges")}</p>
  }
  return (
    <section aria-label={label}>
      <pre
        className="max-h-96 overflow-auto rounded-md border bg-muted/40 py-2 font-mono text-xs leading-relaxed"
        data-testid="policy-diff"
      >
        {lines.map((line, index) => (
          <div
            key={index}
            data-kind={line.kind}
            className={cn(
              "px-3 whitespace-pre-wrap",
              line.kind === "added" && "bg-success/15",
              line.kind === "removed" && "bg-destructive/15",
            )}
          >
            <span
              aria-hidden="true"
              className="mr-2 inline-block w-3 select-none text-muted-foreground"
            >
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            </span>
            {line.kind === "same" ? null : (
              <span className="sr-only">
                {line.kind === "added" ? t("policies.diff.added") : t("policies.diff.removed")}:{" "}
              </span>
            )}
            {line.text}
          </div>
        ))}
      </pre>
    </section>
  )
}
