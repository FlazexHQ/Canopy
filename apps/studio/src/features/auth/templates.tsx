import { CanopyError, ErrorCode } from "@canopy/protocol"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import {
  EMAIL_KINDS,
  type EmailKind,
  type EmailPlaceholder,
  type EmailTemplate,
  type EmailTemplateBody,
} from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Alert, AlertDescription } from "../../components/ui/alert.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx"
import { Input, Textarea } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
import { cn } from "../../lib/utils.ts"

/** The draft of one template as the form holds it; an empty HTML body means none. */
export interface TemplateDraft {
  readonly subject: string
  readonly text: string
  readonly html: string
}

function draftOf(template: EmailTemplateBody): TemplateDraft {
  return { subject: template.subject, text: template.text, html: template.html ?? "" }
}

/** The body sent to the server: the HTML body only when it has content. */
export function bodyOf(draft: TemplateDraft): EmailTemplateBody {
  return {
    subject: draft.subject,
    text: draft.text,
    ...(draft.html.trim() === "" ? {} : { html: draft.html }),
  }
}

/** The required placeholders a draft no longer contains in its bodies, checked before saving. */
export function missingPlaceholders(
  draft: TemplateDraft,
  required: readonly EmailPlaceholder[],
): EmailPlaceholder[] {
  const bodies = `${draft.text}\n${draft.html}`
  return required.filter((name) => !new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(bodies))
}

/** Inserts `{{name}}` at the caret of a text field, returning the new value and caret position. */
export function insertPlaceholder(
  value: string,
  name: EmailPlaceholder,
  start: number,
  end: number = start,
): { readonly value: string; readonly caret: number } {
  const marker = `{{${name}}}`
  return {
    value: `${value.slice(0, start)}${marker}${value.slice(end)}`,
    caret: start + marker.length,
  }
}

function usePreview(kind: EmailKind, draft: TemplateDraft) {
  const api = useApi()
  const [body, setBody] = useState(() => bodyOf(draft))
  const serialized = JSON.stringify(bodyOf(draft))
  useEffect(() => {
    const timer = setTimeout(() => setBody(JSON.parse(serialized) as EmailTemplateBody), 400)
    return () => clearTimeout(timer)
  }, [serialized])
  return useQuery({
    queryKey: [...keys.templates, "preview", kind, body],
    queryFn: ({ signal }) => api.previewTemplate(kind, body, signal),
    retry: false,
  })
}

function TemplateEditor({
  template,
  version,
  onConflict,
}: {
  readonly template: EmailTemplate
  readonly version: number
  readonly onConflict: (version: number) => void
}) {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const id = useId()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState<TemplateDraft>(() => draftOf(template))
  const [comment, setComment] = useState("")
  const [confirmReset, setConfirmReset] = useState(false)
  const preview = usePreview(template.kind, draft)
  const kindLabel = t(`auth.templates.kinds.${template.kind}`)
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(template))
  const missing = missingPlaceholders(draft, template.required)
  const editable = permissions.manageSettings

  const settle = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.templates })
  }
  const conflictOr = (error: unknown) => {
    if (error instanceof CanopyError && error.code === ErrorCode.Conflict) {
      const current = error.details?.["currentVersion"]
      onConflict(typeof current === "number" ? current : version)
      return
    }
    toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" })
  }
  const save = useMutation({
    mutationFn: () =>
      api.saveTemplate(template.kind, {
        ...bodyOf(draft),
        expectedVersion: version,
        ...(comment.trim() === "" ? {} : { comment: comment.trim() }),
      }),
    onSuccess: async (result) => {
      setComment("")
      toast({
        title: t("auth.templates.saved", { kind: kindLabel, version: result.version }),
        variant: "success",
      })
      await settle()
    },
    onError: conflictOr,
  })
  const reset = useMutation({
    mutationFn: (reason: string) =>
      api.resetTemplate(template.kind, {
        expectedVersion: version,
        ...(reason === "" ? {} : { comment: reason }),
      }),
    onSuccess: async () => {
      setConfirmReset(false)
      toast({ title: t("auth.templates.resetDone", { kind: kindLabel }), variant: "success" })
      await settle()
    },
    onError: (error) => {
      setConfirmReset(false)
      conflictOr(error)
    },
  })

  const insert = (name: EmailPlaceholder) => {
    const field = textRef.current
    const start = field?.selectionStart ?? draft.text.length
    const end = field?.selectionEnd ?? start
    const next = insertPlaceholder(draft.text, name, start, end)
    setDraft({ ...draft, text: next.value })
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(next.caret, next.caret)
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        className="grid content-start gap-4"
        aria-label={kindLabel}
        onSubmit={(event) => {
          event.preventDefault()
          if (editable && dirty && missing.length === 0 && !save.isPending) save.mutate()
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold">{kindLabel}</h3>
          <Badge variant={template.source === "studio" ? "default" : "secondary"}>
            {t(`auth.templates.source.${template.source}`)}
          </Badge>
          {dirty ? <Badge variant="warning">{t("auth.templates.unsaved")}</Badge> : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-subject`}>{t("auth.templates.subject")}</Label>
          <Input
            id={`${id}-subject`}
            value={draft.subject}
            readOnly={!editable}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
          />
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t("auth.templates.placeholders")}</legend>
          <p id={`${id}-placeholders`} className="text-xs text-muted-foreground">
            {t("auth.templates.placeholdersHint", {
              required: template.required.map((name) => `{{${name}}}`).join(", "),
            })}
          </p>
          <div className="flex flex-wrap gap-1">
            {template.placeholders.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="outline"
                className="font-mono"
                disabled={!editable}
                aria-label={t("auth.templates.insert", { placeholder: `{{${name}}}` })}
                onClick={() => insert(name)}
              >
                {`{{${name}}}`}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-text`}>{t("auth.templates.text")}</Label>
          <Textarea
            id={`${id}-text`}
            ref={textRef}
            rows={8}
            className="font-mono"
            value={draft.text}
            readOnly={!editable}
            aria-describedby={`${id}-placeholders`}
            aria-invalid={missing.length > 0}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-html`}>{t("auth.templates.html")}</Label>
          <Textarea
            id={`${id}-html`}
            rows={6}
            className="font-mono"
            value={draft.html}
            readOnly={!editable}
            aria-describedby={`${id}-html-hint`}
            onChange={(event) => setDraft({ ...draft, html: event.target.value })}
          />
          <p id={`${id}-html-hint`} className="text-xs text-muted-foreground">
            {t("auth.templates.htmlHint")}
          </p>
        </div>
        {editable ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-comment`}>{t("auth.templates.comment")}</Label>
              <Input
                id={`${id}-comment`}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!dirty || missing.length > 0 || save.isPending}>
                {t("auth.templates.save")}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty}
                onClick={() => setDraft(draftOf(template))}
              >
                {t("auth.templates.discard")}
              </Button>
              {template.source === "studio" ? (
                <Button variant="outline" onClick={() => setConfirmReset(true)}>
                  {t("auth.templates.reset")}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("auth.templates.readOnly")}</p>
        )}
      </form>
      <Card aria-live="polite">
        <CardHeader>
          <CardTitle>{t("auth.templates.preview")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {preview.isError ? (
            <p role="alert" className="text-destructive">
              {t("auth.templates.previewError", { message: errorMessage(preview.error) })}
            </p>
          ) : preview.data === undefined ? (
            <LoadingState rows={2} />
          ) : (
            <>
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("auth.templates.previewSubject")}
                </p>
                <p data-testid="template-preview-subject" className="font-medium">
                  {preview.data.subject}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("auth.templates.previewText")}</p>
                <pre
                  data-testid="template-preview-text"
                  className="whitespace-pre-wrap rounded-md border bg-muted p-3 font-sans"
                >
                  {preview.data.text}
                </pre>
              </div>
              {preview.data.html === undefined ? null : (
                <div>
                  <p className="text-xs text-muted-foreground">{t("auth.templates.previewHtml")}</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs">
                    {preview.data.html}
                  </pre>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t("auth.templates.resetTitle", { kind: kindLabel })}
        description={t("auth.templates.resetBody")}
        confirmLabel={t("auth.templates.reset")}
        reason={{ label: t("auth.templates.comment"), required: false }}
        pending={reset.isPending}
        onConfirm={({ reason }) => reset.mutate(reason)}
      />
    </div>
  )
}

function History() {
  const api = useApi()
  const query = useQuery({
    queryKey: [...keys.templates, "history"],
    queryFn: ({ signal }) => api.templateHistory(signal),
  })
  if (query.isPending) return <LoadingState rows={2} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (query.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("auth.templates.noHistory")}</p>
  }
  return (
    <ol className="grid gap-2 text-sm" aria-label={t("auth.templates.history")}>
      {query.data.map((entry) => (
        <li key={entry.version} className="rounded-md border p-3">
          <p className="font-medium">
            {t("auth.templates.historyEntry", {
              version: entry.version,
              change: t(`auth.templates.historyChange.${entry.change}`),
              kind: entry.kind === undefined ? "" : t(`auth.templates.kinds.${entry.kind}`),
              by: entry.updatedBy,
            })}
          </p>
          <p className="text-xs text-muted-foreground">{formatDateTime(entry.updatedAt)}</p>
          {entry.comment === undefined ? null : <p className="mt-1">{entry.comment}</p>}
        </li>
      ))}
    </ol>
  )
}

/** Email templates of built in auth: pick a kind, edit it with a live preview, save, reset, history. */
export function TemplatesTab() {
  const api = useApi()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<EmailKind>("verification")
  const [conflict, setConflict] = useState<number | undefined>(undefined)
  const query = useQuery({
    queryKey: keys.templates,
    queryFn: ({ signal }) => api.templates(signal),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("auth.features.templates")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const { version, templates } = query.data
  const template = templates.find((entry) => entry.kind === kind)
  if (templates.length === 0) return <EmptyState>{t("auth.features.templates")}</EmptyState>
  return (
    <div className="grid gap-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t("auth.templates.intro")} {t("auth.templates.version", { version })}
      </p>
      {conflict === undefined ? null : (
        <Alert variant="warning">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{t("auth.templates.conflict", { version: conflict })}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                setConflict(undefined)
                await queryClient.invalidateQueries({ queryKey: keys.templates })
              }}
            >
              {t("auth.templates.reload")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <nav aria-label={t("auth.templates.choose")}>
          <ul className="grid gap-1">
            {EMAIL_KINDS.map((candidate) => {
              const entry = templates.find((item) => item.kind === candidate)
              return (
                <li key={candidate}>
                  <button
                    type="button"
                    aria-current={candidate === kind ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent",
                      candidate === kind && "bg-accent font-medium",
                    )}
                    onClick={() => setKind(candidate)}
                  >
                    {t(`auth.templates.kinds.${candidate}`)}
                    {entry?.source === "studio" ? (
                      <Badge variant="secondary">{t("auth.templates.source.studio")}</Badge>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        {template === undefined ? null : (
          <TemplateEditor
            key={`${template.kind}:${version}`}
            template={template}
            version={version}
            onConflict={setConflict}
          />
        )}
      </div>
      <section className="grid gap-2">
        <h3 className="font-medium">{t("auth.templates.history")}</h3>
        <History />
      </section>
    </div>
  )
}
