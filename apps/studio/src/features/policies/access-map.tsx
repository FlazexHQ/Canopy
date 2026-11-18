import { useMemo } from "react"
import type { PolicyDraft } from "../../api/client.ts"
import { Section } from "../../components/states.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { t } from "../../i18n/index.ts"
import { cn } from "../../lib/utils.ts"
import { ACCESS_OPERATIONS, type AccessCell, accessMap, type Reach } from "./access.ts"

/** The mark of a reach, drawn the same in the cells and the legend. */
function ReachMark({ reach }: { readonly reach: Reach }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-2.5 shrink-0 overflow-hidden rounded-[3px]",
        reach === "all" && "bg-brand",
        reach === "matching" && "border border-brand",
        reach === "none" && "border border-input",
      )}
    >
      {reach === "matching" ? <span className="h-full w-1/2 bg-brand" /> : null}
    </span>
  )
}

function Cell({ cell }: { readonly cell: AccessCell }) {
  return (
    <div className="grid gap-0.5">
      <span
        className={cn(
          "flex items-center gap-2",
          cell.reach === "none" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <ReachMark reach={cell.reach} />
        {t(`policies.access.short.${cell.reach}`)}
      </span>
      {cell.grants.length === 0 ? null : (
        <span className="pl-[18px] text-xs break-words text-muted-foreground">
          {t("policies.access.grants", { names: cell.grants.join(", ") })}
        </span>
      )}
      {cell.limits.length === 0 || cell.reach === "none" ? null : (
        <span className="pl-[18px] text-xs break-words text-muted-foreground">
          {t("policies.access.limits", { names: cell.limits.join(", ") })}
        </span>
      )}
    </div>
  )
}

/**
 * What every role can do in the collection under the draft, recomputed as the draft changes: every
 * document, only the documents a clause matches, or nothing.
 */
export function AccessMapView({ draft }: { readonly draft: PolicyDraft }) {
  const map = useMemo(() => accessMap(draft), [draft])
  return (
    <Section
      id="policy-access"
      title={t("policies.access.title")}
      description={t("policies.access.description")}
      action={
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {(["all", "matching", "none"] as const).map((reach) => (
            <li key={reach} className="flex items-center gap-1.5">
              <ReachMark reach={reach} />
              {t(`policies.access.reach.${reach}`)}
            </li>
          ))}
        </ul>
      }
    >
      <Table aria-labelledby="policy-access">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-40">
              {t("policies.access.role")}
            </TableHead>
            {ACCESS_OPERATIONS.map((op) => (
              <TableHead key={op} scope="col">
                {op}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {map.map((row) => (
            <TableRow key={row.role} className="align-top hover:bg-transparent">
              <TableHead scope="row" className="h-auto py-2.5 align-top">
                <span className="font-mono text-[13px] text-foreground">{row.role}</span>
                {row.roles.length > 1 ? (
                  <span className="block text-xs">{t("policies.access.withAuthenticated")}</span>
                ) : null}
              </TableHead>
              {ACCESS_OPERATIONS.map((op) => (
                <TableCell key={op} className="max-w-48 align-top">
                  <Cell cell={row.cells[op]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}
