import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import type { DocumentQuery } from "../../api/client.ts"
import { keys, useApi } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { t } from "../../i18n/index.ts"
import {
  exportDocuments,
  importDocuments,
  TRANSFER_FORMATS,
  type TransferFormat,
} from "../../lib/transfer.ts"
import { useWriteMode, writeContext } from "./write-dialogs.tsx"

/** The most documents one export downloads. */
export const EXPORT_MAX = 10_000
const PAGE = 500

const EXTENSIONS: Record<TransferFormat, string> = { ejson: "json", json: "json", csv: "csv" }
const TYPES: Record<TransferFormat, string> = {
  ejson: "application/json",
  json: "application/json",
  csv: "text/csv",
}

function FormatPicker({
  value,
  onChange,
}: {
  readonly value: TransferFormat
  readonly onChange: (format: TransferFormat) => void
}) {
  const id = useId()
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t("data.transfer.format")}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as TransferFormat)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        {TRANSFER_FORMATS.map((format) => (
          <option key={format} value={format}>
            {t(`data.transfer.formats.${format}`)}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Reads an EJSON, JSON or CSV file and inserts its documents in one request. */
export function ImportDialog({
  collection,
  open,
  onOpenChange,
}: {
  readonly collection: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const mode = useWriteMode()
  const fileId = useId()
  const [format, setFormat] = useState<TransferFormat>("ejson")
  const [text, setText] = useState<string | undefined>(undefined)
  let parsed: { documents: Record<string, unknown>[] } | { error: string } | undefined
  if (text !== undefined) {
    try {
      parsed = { documents: importDocuments(text, format) }
    } catch (error: unknown) {
      parsed = { error: errorMessage(error) }
    }
  }
  const run = useMutation({
    mutationFn: (input: { readonly reason: string; readonly typed: string }) => {
      if (parsed === undefined || "error" in parsed) throw new TypeError("Nothing to import")
      return api.importDocuments(collection, parsed.documents, writeContext(mode, input))
    },
    onSuccess: async (count) => {
      toast({ title: t("data.transfer.imported", { count }), variant: "success" })
      setText(undefined)
      onOpenChange(false)
      await queryClient.invalidateQueries({ queryKey: keys.documents(collection) })
      await queryClient.invalidateQueries({ queryKey: keys.collections })
    },
    onError: (error) =>
      toast({ title: t("data.write.failed"), description: errorMessage(error), variant: "error" }),
  })
  const ready = parsed !== undefined && "documents" in parsed && parsed.documents.length > 0
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setText(undefined)
        onOpenChange(next)
      }}
      title={t("data.transfer.importTitle", { name: collection })}
      confirmLabel={t("data.transfer.import")}
      pending={run.isPending || !ready}
      {...(mode.confirm ? { typedConfirmation: collection } : {})}
      {...(mode.viewAs === undefined
        ? { reason: { label: t("data.write.reasonLabel"), required: false } }
        : {})}
      onConfirm={(input) => run.mutate(input)}
    >
      <FormatPicker value={format} onChange={setFormat} />
      <div className="grid gap-2">
        <Label htmlFor={fileId}>{t("data.transfer.file")}</Label>
        <Input
          id={fileId}
          type="file"
          accept=".json,.ejson,.jsonl,.ndjson,.csv,application/json,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file === undefined) return
            if (file.name.endsWith(".csv")) setFormat("csv")
            void file.text().then(setText)
          }}
        />
      </div>
      {parsed === undefined ? null : "error" in parsed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("data.transfer.parseError", { message: parsed.error })}
        </p>
      ) : (
        <p role="status" className="text-sm">
          {t("data.transfer.preview", { count: parsed.documents.length })}
        </p>
      )}
    </ConfirmDialog>
  )
}

/** Fetches every document matching the query, page by page, up to {@link EXPORT_MAX}. */
export async function collectDocuments(
  load: (
    query: DocumentQuery,
  ) => Promise<{ readonly documents: readonly Record<string, unknown>[] }>,
  query: DocumentQuery,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let skip = 0; out.length < EXPORT_MAX; skip += PAGE) {
    const page = await load({ ...query, skip, limit: Math.min(PAGE, EXPORT_MAX - out.length) })
    out.push(...page.documents)
    if (page.documents.length < PAGE) break
  }
  return out
}

/** Downloads the documents of the current filter as EJSON, JSON or CSV. */
export function ExportDialog({
  collection,
  query,
  open,
  onOpenChange,
}: {
  readonly collection: string
  readonly query: DocumentQuery
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const api = useApi()
  const toast = useToast()
  const [format, setFormat] = useState<TransferFormat>("ejson")
  const run = useMutation({
    mutationFn: () => collectDocuments((page) => api.documents(collection, page), query),
    onSuccess: (documents) => {
      const blob = new Blob([exportDocuments(documents, format)], { type: TYPES[format] })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${collection}.${format === "ejson" ? "ejson." : ""}${EXTENSIONS[format]}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast({ title: t("data.transfer.exported", { count: documents.length }), variant: "success" })
      onOpenChange(false)
    },
    onError: (error) =>
      toast({ title: t("data.write.failed"), description: errorMessage(error), variant: "error" }),
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("data.transfer.exportTitle", { name: collection })}
      description={t("data.transfer.exportScope", { max: EXPORT_MAX })}
      confirmLabel={t("data.transfer.download")}
      pending={run.isPending}
      onConfirm={() => run.mutate()}
    >
      <FormatPicker value={format} onChange={setFormat} />
    </ConfirmDialog>
  )
}
