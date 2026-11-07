import { CanopyError, ErrorCode } from "@canopy/protocol"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowLeftIcon, GitCompareIcon, UploadIcon } from "lucide-react"
import { useMemo, useState } from "react"
import type { PolicyDraft } from "../../api/client.ts"
import type { StoredCollection } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { t } from "../../i18n/index.ts"
import { DiffView } from "./diff-view.tsx"
import { useDraft } from "./draft-store.ts"
import { PolicyHistory } from "./history.tsx"
import { LintPanel } from "./lint-panel.tsx"
import {
  checkDraft,
  draftFromText,
  draftOf,
  draftText,
  TEMPLATE_IDS,
  type TemplateId,
  templateDraft,
  toDsl,
} from "./model.ts"
import { PolicyForm } from "./policy-form.tsx"
import { Simulator } from "./simulator.tsx"

function EjsonView({
  collection,
  draft,
  onChange,
  readOnly,
}: {
  readonly collection: string
  readonly draft: PolicyDraft
  readonly onChange: (draft: PolicyDraft) => void
  readonly readOnly: boolean
}) {
  const [text, setText] = useState(() => draftText(draft))
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <div className="grid gap-2">
      <CodeEditor
        label={t("policies.editor.ejsonLabel", { name: collection })}
        value={text}
        readOnly={readOnly}
        minHeight="20rem"
        maxHeight="40rem"
        completion={{ variables: true }}
        onChange={(next) => {
          setText(next)
          try {
            onChange(draftFromText(next, collection))
            setError(undefined)
          } catch (failure: unknown) {
            setError(t("policies.editor.ejsonInvalid", { message: errorMessage(failure) }))
          }
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function Editor({
  collection,
  published,
}: {
  readonly collection: string
  readonly published: StoredCollection | null
}) {
  const api = useApi()
  const session = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const { permissions } = session
  const state = useDraft(collection, published)
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState("form")
  const [showDiff, setShowDiff] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [conflict, setConflict] = useState<number | undefined>(undefined)
  const [template, setTemplate] = useState<TemplateId>("owner-only")
  const [templateOpen, setTemplateOpen] = useState(false)
  const readOnly = !permissions.draftPolicies
  const schema = useQuery({
    queryKey: keys.collectionSchema(collection),
    queryFn: ({ signal }) => api.collectionSchema(collection, signal),
  })
  const fields = useMemo(() => (schema.data ?? []).map((field) => field.path), [schema.data])
  const check = useMemo(() => checkDraft(state.draft), [state.draft])
  const dsl = useMemo(() => {
    try {
      return toDsl(state.draft)
    } catch (error: unknown) {
      return `// ${errorMessage(error)}`
    }
  }, [state.draft])
  const publishedText = draftText(draftOf(published, collection))
  const replace = (next: PolicyDraft) => {
    state.setDraft(next)
    setRevision((value) => value + 1)
  }
  const refreshPublished = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.policies(collection) }),
      queryClient.invalidateQueries({ queryKey: keys.history(collection) }),
      queryClient.invalidateQueries({ queryKey: keys.collections }),
    ])
  const publish = useMutation({
    mutationFn: (comment: string) =>
      api.publish(collection, { draft: state.draft, expectedVersion: state.baseVersion, comment }),
    onSuccess: async (result) => {
      setPublishOpen(false)
      setConflict(undefined)
      state.discard()
      setRevision((value) => value + 1)
      toast({
        title: t("policies.publish.published", { version: result.version }),
        variant: "success",
      })
      await refreshPublished()
    },
    onError: async (error) => {
      if (error instanceof CanopyError && error.code === ErrorCode.Conflict) {
        const current = error.details?.["currentVersion"]
        setPublishOpen(false)
        setConflict(typeof current === "number" ? current : state.baseVersion + 1)
        await refreshPublished()
        return
      }
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" })
    },
  })
  const canPublish =
    permissions.publishPolicies && check.errors.length === 0 && (state.dirty || published === null)
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/policies">
            <ArrowLeftIcon aria-hidden="true" />
            {t("policies.editor.back")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="draft-status">
          {state.dirty ? (
            <Badge variant="warning">{t("policies.editor.draft")}</Badge>
          ) : published === null ? (
            <Badge variant="outline">{t("policies.editor.noPublished")}</Badge>
          ) : (
            <Badge variant="secondary">
              {t("policies.editor.upToDate", { version: published.version })}
            </Badge>
          )}
          {state.dirty ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                state.discard()
                setRevision((value) => value + 1)
                toast({ title: t("policies.editor.discarded") })
              }}
            >
              {t("policies.editor.discard")}
            </Button>
          ) : null}
        </div>
      </div>
      <PageHeader title={collection} description={t("policies.description")} />
      {conflict === undefined ? null : (
        <Alert variant="warning" className="mb-4">
          <AlertTitle>{t("policies.publish.conflictTitle")}</AlertTitle>
          <AlertDescription>
            <p>{t("policies.publish.conflictBody", { version: conflict })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  state.discard()
                  setRevision((value) => value + 1)
                  setConflict(undefined)
                }}
              >
                {t("policies.publish.reload")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  state.rebase(conflict)
                  setShowDiff(true)
                  setConflict(undefined)
                }}
              >
                {t("policies.publish.keepDraft")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid content-start gap-6">
          {readOnly ? null : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1">
                <label htmlFor="policy-template" className="text-sm font-medium">
                  {t("policies.editor.template")}
                </label>
                <select
                  id="policy-template"
                  value={template}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  onChange={(event) => setTemplate(event.target.value as TemplateId)}
                >
                  {TEMPLATE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {t(`policies.editor.templates.${id}`)}
                    </option>
                  ))}
                </select>
              </div>
              <Button variant="outline" onClick={() => setTemplateOpen(true)}>
                {t("policies.editor.templateApply")}
              </Button>
            </div>
          )}
          <Tabs value={view} onValueChange={setView}>
            <TabsList aria-label={t("policies.editor.views")}>
              <TabsTrigger value="form">{t("policies.editor.form")}</TabsTrigger>
              <TabsTrigger value="ejson">{t("policies.editor.ejson")}</TabsTrigger>
              <TabsTrigger value="ts">{t("policies.editor.ts")}</TabsTrigger>
            </TabsList>
            <TabsContent value="form" className="mt-4">
              <PolicyForm
                draft={state.draft}
                fields={fields}
                readOnly={readOnly}
                revision={revision}
                onChange={state.setDraft}
              />
            </TabsContent>
            <TabsContent value="ejson" className="mt-4">
              <EjsonView
                key={revision}
                collection={collection}
                draft={state.draft}
                readOnly={readOnly}
                onChange={state.setDraft}
              />
            </TabsContent>
            <TabsContent value="ts" className="mt-4 grid gap-2">
              <p className="text-sm text-muted-foreground">
                {t("policies.editor.tsHint", { name: collection })}
              </p>
              <CodeEditor
                label={t("policies.editor.tsLabel", { name: collection })}
                value={dsl}
                language="text"
                readOnly
                minHeight="20rem"
                maxHeight="40rem"
              />
              <pre className="sr-only" data-testid="policy-dsl">
                {dsl}
              </pre>
            </TabsContent>
          </Tabs>
          <LintPanel collection={collection} draft={state.draft} />
        </div>
        <div className="grid content-start gap-6">
          <Simulator
            collection={collection}
            draft={state.draft}
            fields={fields}
            canRun={permissions.draftPolicies}
          />
        </div>
      </div>
      <div className="sticky bottom-0 mt-6 flex flex-wrap items-center justify-between gap-2 border-t bg-background py-3">
        <span className="text-sm text-muted-foreground">
          {state.dirty ? t("policies.editor.draft") : null}
          {permissions.publishPolicies ? null : t("policies.publish.noPermission")}
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-expanded={showDiff}
            onClick={() => setShowDiff((value) => !value)}
          >
            <GitCompareIcon aria-hidden="true" />
            {t("policies.diff.show")}
          </Button>
          {permissions.publishPolicies ? (
            <Button disabled={!canPublish} onClick={() => setPublishOpen(true)}>
              <UploadIcon aria-hidden="true" />
              {t("policies.publish.button")}
            </Button>
          ) : null}
        </div>
      </div>
      {check.errors.length > 0 && permissions.publishPolicies ? (
        <p className="text-sm text-destructive">{t("policies.publish.blocked")}</p>
      ) : null}
      {showDiff ? (
        <section aria-labelledby="diff-title" className="mt-4 grid gap-2">
          <h2 id="diff-title" className="font-semibold">
            {t("policies.diff.title")}
          </h2>
          <DiffView
            label={t("policies.diff.title")}
            before={publishedText}
            after={draftText(state.draft)}
          />
        </section>
      ) : null}
      <section aria-labelledby="history-title" className="mt-8 grid gap-3">
        <h2 id="history-title" className="font-semibold">
          {t("policies.history.title")}
        </h2>
        <PolicyHistory
          collection={collection}
          currentVersion={published?.version ?? 0}
          canRollback={permissions.publishPolicies}
        />
      </section>
      <ConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title={t("policies.publish.title", { name: collection })}
        description={t("policies.publish.description", { version: state.baseVersion + 1 })}
        confirmLabel={t("policies.publish.button")}
        reason={{
          label: t("policies.publish.comment"),
          required: permissions.publishNeedsComment,
          hint: permissions.publishNeedsComment
            ? t("policies.publish.commentRequired")
            : t("policies.publish.commentHint"),
        }}
        pending={publish.isPending}
        onConfirm={({ reason }) => publish.mutate(reason)}
      >
        <DiffView
          label={t("policies.diff.title")}
          before={publishedText}
          after={draftText(state.draft)}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        title={t("policies.editor.templateApply")}
        description={t("policies.editor.templateConfirm", {
          template: t(`policies.editor.templates.${template}`),
        })}
        confirmLabel={t("policies.editor.templateApply")}
        onConfirm={() => {
          replace(templateDraft(collection, template))
          setTemplateOpen(false)
        }}
      />
    </>
  )
}

/** The policy editor of one collection: form, EJSON and TS views, lint, simulator, diff, publish, history. */
export function PolicyEditorPage({ collection }: { readonly collection: string }) {
  const api = useApi()
  const policies = useQuery({
    queryKey: keys.policies(collection),
    queryFn: ({ signal }) => api.policies(collection, signal),
  })
  if (policies.isPending) return <LoadingState rows={6} />
  if (policies.isError)
    return <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />
  return <Editor key={collection} collection={collection} published={policies.data} />
}
