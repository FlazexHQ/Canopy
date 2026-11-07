import { useId, useMemo, useState } from "react"
import { EVENT_OPERATIONS } from "../../api/contract.ts"
import { EmptyState } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
import { displayValue } from "../../lib/ejson.ts"
import { NativeSelect } from "./native-select.tsx"
import type { Tail } from "./use-tail.ts"

const ALL = "__all"

/** The live event tail with collection and operation filters. */
export function TailView({
  tail,
  onTrace,
}: {
  readonly tail: Tail
  readonly onTrace: (eventId: string) => void
}) {
  const [collection, setCollection] = useState(ALL)
  const [operation, setOperation] = useState(ALL)
  const collectionId = useId()
  const operationId = useId()
  const collections = useMemo(
    () => [...new Set(tail.events.map((event) => event.coll))].sort(),
    [tail.events],
  )
  const shown = tail.events.filter(
    (event) =>
      (collection === ALL || event.coll === collection) &&
      (operation === ALL || event.op === operation),
  )
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={collectionId}>{t("realtime.tail.collection")}</Label>
          <NativeSelect
            id={collectionId}
            className="w-44"
            value={collection}
            onChange={(event) => setCollection(event.target.value)}
          >
            <option value={ALL}>{t("realtime.tail.all")}</option>
            {collections.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={operationId}>{t("realtime.tail.operation")}</Label>
          <NativeSelect
            id={operationId}
            className="w-36"
            value={operation}
            onChange={(event) => setOperation(event.target.value)}
          >
            <option value={ALL}>{t("realtime.tail.all")}</option>
            {EVENT_OPERATIONS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={tail.paused ? tail.resume : tail.pause}>
            {tail.paused ? t("realtime.tail.resume") : t("realtime.tail.pause")}
          </Button>
          <Button variant="outline" onClick={tail.clear}>
            {t("realtime.tail.clear")}
          </Button>
        </div>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {tail.status === "connecting" && tail.events.length === 0
          ? t("realtime.tail.connecting")
          : tail.status === "error"
            ? t("realtime.tail.disconnected")
            : tail.paused
              ? t("realtime.tail.paused", { buffered: tail.buffered })
              : t("realtime.tail.status", { shown: shown.length, total: tail.events.length })}
      </p>
      {shown.length === 0 ? (
        <EmptyState>{t("realtime.tail.empty")}</EmptyState>
      ) : (
        <Table>
          <TableCaption>{t("realtime.tail.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("realtime.tail.time")}</TableHead>
              <TableHead>{t("realtime.tail.collection")}</TableHead>
              <TableHead>{t("realtime.tail.operation")}</TableHead>
              <TableHead>{t("realtime.tail.document")}</TableHead>
              <TableHead>{t("realtime.tail.fields")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("realtime.tail.trace")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((event) => (
              <TableRow key={event.id} data-testid="tail-event">
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {event.wallTime === undefined || event.wallTime === null
                    ? ""
                    : formatDateTime(event.wallTime)}
                </TableCell>
                <TableCell>{event.coll}</TableCell>
                <TableCell>
                  <Badge variant={event.op === "delete" ? "destructive" : "secondary"}>
                    {event.op}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{displayValue(event.docId)}</TableCell>
                <TableCell className="text-xs">{(event.fields ?? []).join(", ")}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("realtime.tail.traceEvent", { id: event.id })}
                    onClick={() => onTrace(event.id)}
                  >
                    {t("realtime.tail.trace")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
