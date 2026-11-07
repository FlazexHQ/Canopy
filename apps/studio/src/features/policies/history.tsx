import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { HistoryEntry } from "../../api/contract.ts"
import { keys, useApi } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
import { DiffView } from "./diff-view.tsx"
import { draftOf, draftText } from "./model.ts"

/** Published versions with their comments; any older version can be published again (rollback). */
export function PolicyHistory({
  collection,
  currentVersion,
  canRollback,
}: {
  readonly collection: string
  readonly currentVersion: number
  readonly canRollback: boolean
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const history = useQuery({
    queryKey: keys.history(collection),
    queryFn: ({ signal }) => api.history(collection, signal),
  })
  const [open, setOpen] = useState<number | undefined>(undefined)
  const [target, setTarget] = useState<HistoryEntry | undefined>(undefined)
  const rollback = useMutation({
    mutationFn: (input: { version: number; comment: string }) =>
      api.rollback(collection, { ...input, expectedVersion: currentVersion }),
    onSuccess: async (result, input) => {
      setTarget(undefined)
      toast({
        title: t("policies.history.rolledBack", { version: input.version }),
        variant: "success",
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.policies(collection) }),
        queryClient.invalidateQueries({ queryKey: keys.collections }),
      ])
      return result
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  if (history.isPending) return <LoadingState rows={2} />
  if (history.isError)
    return <ErrorState error={history.error} onRetry={() => void history.refetch()} />
  if (history.data.length === 0) return <EmptyState>{t("policies.history.empty")}</EmptyState>
  const versions = [...history.data].sort((a, b) => b.version - a.version)
  return (
    <>
      <ol className="grid gap-2" data-testid="policy-history">
        {versions.map((entry, index) => {
          const previous = versions[index + 1]
          const current = entry.version === currentVersion
          return (
            <li key={entry.version} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {t("policies.history.version", { version: entry.version })}
                  </span>
                  {current ? (
                    <Badge variant="success">{t("policies.history.current")}</Badge>
                  ) : null}
                  {entry.updatedBy === undefined ? null : (
                    <span className="text-muted-foreground">
                      {t("policies.history.by", { who: entry.updatedBy })}
                    </span>
                  )}
                  {entry.updatedAt === undefined ? null : (
                    <time className="text-muted-foreground" dateTime={entry.updatedAt}>
                      {formatDateTime(entry.updatedAt)}
                    </time>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={open === entry.version}
                    onClick={() => setOpen(open === entry.version ? undefined : entry.version)}
                  >
                    {open === entry.version
                      ? t("policies.history.hideDiff")
                      : t("policies.history.viewDiff", { version: entry.version })}
                  </Button>
                  {current || !canRollback ? null : (
                    <Button variant="outline" size="sm" onClick={() => setTarget(entry)}>
                      {t("policies.history.rollback")}
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-muted-foreground">
                {entry.comment ?? t("policies.history.noComment")}
              </p>
              {open === entry.version ? (
                <div className="mt-2">
                  <DiffView
                    label={t("policies.history.viewDiff", { version: entry.version })}
                    before={
                      previous === undefined
                        ? ""
                        : draftText(draftOf(previous.policies, collection))
                    }
                    after={draftText(draftOf(entry.policies, collection))}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(next) => {
          if (!next) setTarget(undefined)
        }}
        title={t("policies.history.rollbackTitle", { version: target?.version ?? 0 })}
        description={t("policies.history.rollbackDescription", { version: target?.version ?? 0 })}
        confirmLabel={t("policies.history.rollback")}
        reason={{
          label: t("policies.publish.comment"),
          required: false,
          hint: t("policies.publish.commentHint"),
        }}
        pending={rollback.isPending}
        onConfirm={({ reason }) => {
          if (target !== undefined) rollback.mutate({ version: target.version, comment: reason })
        }}
      />
    </>
  )
}
