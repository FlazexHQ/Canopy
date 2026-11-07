import { CanopyError, ErrorCode } from "@canopy/protocol"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { WriteContext } from "../../api/client.ts"
import type { ViewAs } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { describeViewAs, useViewAs } from "../../app/view-as.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Alert, AlertDescription } from "../../components/ui/alert.tsx"
import { t } from "../../i18n/index.ts"
import { displayValue, formatEjson, parseEjsonObject } from "../../lib/ejson.ts"

/** What a write in the Data area runs as, and whether it may run at all. */
export interface WriteMode {
  /** False while viewing as someone with writes still locked, or for roles that cannot edit data. */
  readonly allowed: boolean
  readonly viewAs: ViewAs | undefined
  readonly reason: string | undefined
  /** Production data edits need the collection name typed. */
  readonly confirm: boolean
}

/** The write mode of the current page: as `service`, or as the impersonated identity once unlocked. */
export function useWriteMode(): WriteMode {
  const { permissions } = useSession()
  const { viewAs, writeReason } = useViewAs()
  return {
    allowed: permissions.writeData && (viewAs === undefined || writeReason !== undefined),
    viewAs,
    reason: writeReason,
    confirm: permissions.confirmDataEdits,
  }
}

/** Builds the write context sent with a write: identity, reason and typed confirmation. */
export function writeContext(
  mode: WriteMode,
  input: { readonly reason: string; readonly typed: string },
): WriteContext {
  const reason = mode.viewAs !== undefined ? (mode.reason ?? "") : input.reason
  return {
    ...(mode.viewAs === undefined ? {} : { as: mode.viewAs }),
    ...(reason === "" ? {} : { reason }),
    ...(mode.confirm ? { confirm: input.typed } : {}),
  }
}

function failureTitle(error: unknown): string {
  return error instanceof CanopyError && error.code === ErrorCode.PolicyViolation
    ? t("data.write.denied")
    : t("data.write.failed")
}

function WhoNote({ mode }: { readonly mode: WriteMode }) {
  return (
    <Alert variant={mode.viewAs === undefined ? "default" : "warning"} role="note">
      <AlertDescription>
        {mode.viewAs === undefined
          ? t("data.write.asService")
          : t("data.write.asUser", { who: describeViewAs(mode.viewAs) })}
      </AlertDescription>
    </Alert>
  )
}

/** Inserts or replaces one document, edited as EJSON. */
export function DocumentEditorDialog({
  collection,
  document,
  open,
  onOpenChange,
  fields,
}: {
  readonly collection: string
  /** The document to replace, or undefined to insert. */
  readonly document: Record<string, unknown> | undefined
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly fields: readonly string[]
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const mode = useWriteMode()
  const initial =
    document === undefined
      ? "{\n  \n}"
      : formatEjson(Object.fromEntries(Object.entries(document).filter(([key]) => key !== "_id")))
  const [text, setText] = useState(initial)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const id = document?.["_id"]
  const save = useMutation({
    mutationFn: async (input: { readonly reason: string; readonly typed: string }) => {
      const parsed = parseEjsonObject(text)
      if (!parsed.ok) throw new TypeError(t("data.write.invalid", { message: parsed.message }))
      const context = writeContext(mode, input)
      return document === undefined
        ? api.insertDocument(collection, parsed.value, context)
        : api.updateDocument(collection, id, { replacement: parsed.value }, context)
    },
    onSuccess: async () => {
      toast({
        title: document === undefined ? t("data.write.inserted") : t("data.write.updated"),
        variant: "success",
      })
      setProblem(undefined)
      onOpenChange(false)
      await queryClient.invalidateQueries({ queryKey: keys.documents(collection) })
    },
    onError: (error) => {
      setProblem(errorMessage(error))
      toast({ title: failureTitle(error), description: errorMessage(error), variant: "error" })
    },
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setText(initial)
        setProblem(undefined)
        onOpenChange(next)
      }}
      title={
        document === undefined
          ? t("data.write.insertTitle", { name: collection })
          : t("data.write.editTitle", { id: displayValue(id) })
      }
      description={
        document === undefined ? t("data.write.insertDescription") : t("data.write.editDescription")
      }
      confirmLabel={t("common.save")}
      pending={save.isPending}
      {...(mode.confirm ? { typedConfirmation: collection } : {})}
      {...(mode.viewAs === undefined
        ? { reason: { label: t("data.write.reasonLabel"), required: false } }
        : {})}
      onConfirm={(input) => save.mutate(input)}
    >
      <WhoNote mode={mode} />
      <CodeEditor
        value={text}
        onChange={setText}
        label={t("data.write.documentLabel")}
        completion={{ fields }}
        minHeight="10rem"
      />
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </ConfirmDialog>
  )
}

/** Deletes one document after confirmation. */
export function DeleteDocumentDialog({
  collection,
  document,
  onOpenChange,
}: {
  readonly collection: string
  readonly document: Record<string, unknown> | undefined
  readonly onOpenChange: (open: boolean) => void
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const mode = useWriteMode()
  const id = document?.["_id"]
  const remove = useMutation({
    mutationFn: (input: { readonly reason: string; readonly typed: string }) =>
      api.deleteDocument(collection, id, writeContext(mode, input)),
    onSuccess: async (deleted) => {
      toast(
        deleted > 0
          ? { title: t("data.write.deleted"), variant: "success" }
          : {
              title: t("data.write.notDeleted", {
                who: mode.viewAs === undefined ? "service" : describeViewAs(mode.viewAs),
              }),
              variant: "error",
            },
      )
      onOpenChange(false)
      await queryClient.invalidateQueries({ queryKey: keys.documents(collection) })
    },
    onError: (error) =>
      toast({ title: failureTitle(error), description: errorMessage(error), variant: "error" }),
  })
  return (
    <ConfirmDialog
      open={document !== undefined}
      onOpenChange={onOpenChange}
      title={t("data.write.deleteTitle", { id: displayValue(id) })}
      description={t("data.write.deleteDescription", { name: collection })}
      confirmLabel={t("common.delete")}
      destructive
      pending={remove.isPending}
      {...(mode.confirm ? { typedConfirmation: collection } : {})}
      {...(mode.viewAs === undefined
        ? { reason: { label: t("data.write.reasonLabel"), required: false } }
        : {})}
      onConfirm={(input) => remove.mutate(input)}
    >
      <WhoNote mode={mode} />
    </ConfirmDialog>
  )
}
