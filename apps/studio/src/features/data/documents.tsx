import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ArrowLeftIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RadioIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { lazy, Suspense, useCallback, useId, useMemo, useState } from "react"
import { type DocumentQuery, isNotFound } from "../../api/client.ts"
import { keys, useApi } from "../../app/context.tsx"
import { useViewAs } from "../../app/view-as.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Switch } from "../../components/ui/switch.tsx"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { t } from "../../i18n/index.ts"
import { columnsOf, displayValue, formatEjson } from "../../lib/ejson.ts"
import { FilterPanel } from "./filter-panel.tsx"
import { hiddenFieldsFor } from "./hidden-fields.ts"
import { ExportDialog, ImportDialog } from "./transfer-dialogs.tsx"
import { ViewAsButton, WriteUnlock } from "./view-as-dialog.tsx"
import { DeleteDocumentDialog, DocumentEditorDialog, useWriteMode } from "./write-dialogs.tsx"

const LiveDocuments = lazy(() => import("./live.tsx"))

const LIMITS = [20, 50, 100, 200] as const
const selectClass = "h-8 rounded-md border border-input bg-background px-2 text-sm"

function cellTitle(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : undefined
}

/** Browses, filters and edits the documents of one collection, optionally through someone's policies. */
export function DocumentsPage({ collection }: { readonly collection: string }) {
  const api = useApi()
  const { viewAs } = useViewAs()
  const mode = useWriteMode()
  const ids = { sort: useId(), direction: useId(), limit: useId(), fields: useId(), live: useId() }
  const [filter, setFilter] = useState<Record<string, unknown>>({})
  const [sortField, setSortField] = useState("")
  const [direction, setDirection] = useState<1 | -1>(1)
  const [shown, setShown] = useState<readonly string[]>([])
  const [limit, setLimit] = useState<number>(20)
  const [skip, setSkip] = useState(0)
  const [view, setView] = useState("grid")
  const [editing, setEditing] = useState<Record<string, unknown> | undefined>(undefined)
  const [inserting, setInserting] = useState(false)
  const [deleting, setDeleting] = useState<Record<string, unknown> | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [live, setLive] = useState(false)
  const [liveDocuments, setLiveDocuments] = useState<Record<string, unknown>[] | undefined>(
    undefined,
  )
  const [liveError, setLiveError] = useState<string | undefined>(undefined)

  const schema = useQuery({
    queryKey: keys.collectionSchema(collection),
    queryFn: ({ signal }) => api.collectionSchema(collection, signal),
  })
  const fields = useMemo(() => (schema.data ?? []).map((field) => field.path), [schema.data])
  const topFields = useMemo(() => fields.filter((field) => !field.includes(".")), [fields])

  const sort = sortField === "" ? undefined : { [sortField]: direction }
  const projection =
    shown.length === 0 ? undefined : Object.fromEntries(shown.map((field) => [field, 1 as const]))
  const query: DocumentQuery = {
    filter,
    ...(sort === undefined ? {} : { sort }),
    ...(projection === undefined ? {} : { projection }),
    ...(viewAs === undefined ? {} : { as: viewAs }),
  }
  const documents = useQuery({
    queryKey: [...keys.documents(collection), { ...query, limit, skip }],
    queryFn: ({ signal }) => api.documents(collection, { ...query, limit, skip }, signal),
    placeholderData: keepPreviousData,
  })

  const token = useQuery({
    queryKey: ["realtime-token", collection, viewAs ?? null],
    queryFn: () => api.realtimeToken(viewAs),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const liveUnavailable = token.isError && isNotFound(token.error)
  const onLiveDocuments = useCallback((next: Record<string, unknown>[]) => {
    setLiveError(undefined)
    setLiveDocuments(next)
  }, [])
  const onLiveError = useCallback((error: Error) => setLiveError(error.message), [])

  const published = useQuery({
    queryKey: keys.policies(collection),
    queryFn: ({ signal }) => api.policies(collection, signal),
    enabled: viewAs !== undefined,
  })
  const resetPage = () => setSkip(0)
  const page = documents.data
  const rows = live && liveDocuments !== undefined ? liveDocuments : (page?.documents ?? [])
  const hidden =
    page?.hiddenFields ??
    (viewAs === undefined ? [] : hiddenFieldsFor(published.data ?? null, viewAs, topFields))
  const columns = [
    ...columnsOf(rows),
    ...hidden.filter((field) => !columnsOf(rows).includes(field)),
  ]
  const total = page?.total

  return (
    <div className="grid gap-4">
      <div>
        <Link
          to="/data"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t("data.documents.backToCollections")}
        </Link>
      </div>
      <PageHeader
        title={collection}
        {...(total === undefined ? {} : { description: t("data.documents.total", { total }) })}
        actions={
          <>
            <ViewAsButton />
            <WriteUnlock />
            {mode.allowed ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                  <UploadIcon aria-hidden="true" />
                  {t("data.transfer.import")}
                </Button>
                <Button size="sm" onClick={() => setInserting(true)}>
                  <PlusIcon aria-hidden="true" />
                  {t("data.write.insert")}
                </Button>
              </>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setExporting(true)}>
              <DownloadIcon aria-hidden="true" />
              {t("data.transfer.export")}
            </Button>
          </>
        }
      />

      <FilterPanel
        fields={fields}
        onApply={(next) => {
          setFilter(next)
          resetPage()
        }}
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1">
          <label htmlFor={ids.sort} className="text-xs font-medium">
            {t("data.sort.label")}
          </label>
          <select
            id={ids.sort}
            className={selectClass}
            value={sortField}
            onChange={(event) => {
              setSortField(event.target.value)
              resetPage()
            }}
          >
            <option value="">{t("data.sort.none")}</option>
            {["_id", ...topFields.filter((field) => field !== "_id")].map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <label htmlFor={ids.direction} className="text-xs font-medium">
            {t("data.sort.direction")}
          </label>
          <select
            id={ids.direction}
            className={selectClass}
            value={direction}
            disabled={sortField === ""}
            onChange={(event) => setDirection(event.target.value === "-1" ? -1 : 1)}
          >
            <option value="1">{t("data.sort.ascending")}</option>
            <option value="-1">{t("data.sort.descending")}</option>
          </select>
        </div>
        <details className="relative">
          <summary className="flex h-8 cursor-pointer items-center rounded-md border px-3 text-sm">
            {t("data.fields.label")}:{" "}
            {shown.length === 0
              ? t("data.fields.all")
              : t("data.fields.selected", { count: shown.length })}
          </summary>
          <fieldset className="absolute z-20 mt-1 grid max-h-64 min-w-48 gap-1 overflow-auto rounded-md border bg-popover p-2 shadow-md">
            <legend className="sr-only">{t("data.fields.choose")}</legend>
            {topFields.map((field) => (
              <label key={field} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={shown.includes(field)}
                  onChange={(event) =>
                    setShown((all) =>
                      event.target.checked
                        ? [...all, field]
                        : all.filter((entry) => entry !== field),
                    )
                  }
                />
                {field}
              </label>
            ))}
          </fieldset>
        </details>
        <div className="grid gap-1">
          <label htmlFor={ids.limit} className="text-xs font-medium">
            {t("data.documents.limit")}
          </label>
          <select
            id={ids.limit}
            className={selectClass}
            value={limit}
            onChange={(event) => {
              setLimit(Number(event.target.value))
              resetPage()
            }}
          >
            {LIMITS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={ids.live}
            checked={live}
            disabled={!token.isSuccess}
            aria-describedby={`${ids.live}-note`}
            onCheckedChange={(next) => {
              setLive(next)
              setLiveDocuments(undefined)
            }}
          />
          <label htmlFor={ids.live} className="flex items-center gap-1 text-sm">
            <RadioIcon className="size-4" aria-hidden="true" />
            {t("data.live.label")}
          </label>
          <span id={`${ids.live}-note`} className="text-xs text-muted-foreground" role="status">
            {liveUnavailable
              ? t("data.live.unavailable")
              : liveError !== undefined
                ? t("data.live.error", { message: liveError })
                : live
                  ? liveDocuments === undefined
                    ? t("data.live.connecting")
                    : t("data.live.on")
                  : ""}
          </span>
        </div>
      </div>

      {live && token.data !== undefined ? (
        <Suspense fallback={null}>
          <LiveDocuments
            collection={collection}
            filter={filter}
            sort={sort}
            limit={limit}
            token={token.data.token}
            publishableKey={token.data.publishableKey}
            onDocuments={onLiveDocuments}
            onError={onLiveError}
          />
        </Suspense>
      ) : null}

      {hidden.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("data.viewAs.hiddenFields", { fields: hidden.join(", ") })}
        </p>
      ) : null}

      {documents.isPending ? (
        <LoadingState rows={6} />
      ) : documents.isError ? (
        <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
      ) : (
        <Tabs value={view} onValueChange={setView}>
          <TabsList aria-label={t("data.documents.view")}>
            <TabsTrigger value="grid">{t("data.documents.grid")}</TabsTrigger>
            <TabsTrigger value="ejson">{t("data.documents.ejson")}</TabsTrigger>
          </TabsList>
          <TabsContent value="grid" className="mt-3">
            {rows.length === 0 ? (
              <EmptyState>{t("data.documents.empty")}</EmptyState>
            ) : (
              <Table>
                <TableCaption className="sr-only">
                  {t("data.documents.gridCaption", { name: collection })}
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    {columns.map((column) => (
                      <TableHead key={column} scope="col">
                        {column}
                        {hidden.includes(column) ? (
                          <Badge variant="warning" className="ml-1">
                            {t("data.documents.hiddenByPolicy")}
                          </Badge>
                        ) : null}
                      </TableHead>
                    ))}
                    {mode.allowed ? (
                      <TableHead scope="col">
                        <span className="sr-only">{t("data.documents.actions")}</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((document) => {
                    const id = displayValue(document["_id"])
                    return (
                      <TableRow key={JSON.stringify(document["_id"])}>
                        {columns.map((column) => (
                          <TableCell
                            key={column}
                            className="max-w-64 truncate font-mono text-xs"
                            title={cellTitle(document[column])}
                          >
                            {hidden.includes(column) ? (
                              <span className="text-muted-foreground">
                                {t("data.documents.masked")}
                              </span>
                            ) : (
                              displayValue(document[column])
                            )}
                          </TableCell>
                        ))}
                        {mode.allowed ? (
                          <TableCell className="whitespace-nowrap">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("data.documents.editDocument", { id })}
                              onClick={() => setEditing(document)}
                            >
                              <PencilIcon aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("data.documents.deleteDocument", { id })}
                              onClick={() => setDeleting(document)}
                            >
                              <Trash2Icon aria-hidden="true" />
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </TabsContent>
          <TabsContent value="ejson" className="mt-3">
            <CodeEditor
              value={formatEjson(rows)}
              readOnly
              label={t("data.documents.ejsonLabel", { name: collection })}
              maxHeight="40rem"
            />
          </TabsContent>
          {live ? null : (
            <nav
              aria-label={t("data.documents.pageStatus", {
                from: rows.length === 0 ? 0 : skip + 1,
                to: skip + rows.length,
                total: total ?? skip + rows.length,
              })}
              className="mt-3 flex items-center justify-between gap-2 text-sm"
            >
              <span>
                {t("data.documents.pageStatus", {
                  from: rows.length === 0 ? 0 : skip + 1,
                  to: skip + rows.length,
                  total: total ?? skip + rows.length,
                })}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={skip === 0}
                  onClick={() => setSkip(Math.max(0, skip - limit))}
                >
                  {t("data.documents.previousPage")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={total === undefined ? page?.next === undefined : skip + limit >= total}
                  onClick={() => setSkip(skip + limit)}
                >
                  {t("data.documents.nextPage")}
                </Button>
              </span>
            </nav>
          )}
        </Tabs>
      )}

      <DocumentEditorDialog
        key={inserting ? "insert" : JSON.stringify(editing?.["_id"] ?? null)}
        collection={collection}
        document={editing}
        open={inserting || editing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setInserting(false)
            setEditing(undefined)
          }
        }}
        fields={fields}
      />
      <DeleteDocumentDialog
        collection={collection}
        document={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
      />
      <ImportDialog collection={collection} open={importing} onOpenChange={setImporting} />
      <ExportDialog
        collection={collection}
        query={query}
        open={exporting}
        onOpenChange={setExporting}
      />
    </div>
  )
}
