import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangleIcon } from "lucide-react"
import { useId, useState } from "react"
import type { ApiKey } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { CopyButton } from "../../components/copy-button.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatDateTime, formatRelative, t } from "../../i18n/index.ts"

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onCreated: (created: { readonly key: string; readonly info: ApiKey }) => void
}) {
  const api = useApi()
  const { permissions } = useSession()
  const toast = useToast()
  const onlyPublishable = permissions.createKeys === "publishable"
  const [name, setName] = useState("")
  const [kind, setKind] = useState<ApiKey["kind"]>("publishable")
  const nameId = useId()
  const create = useMutation({
    mutationFn: () =>
      api.createApiKey({ name: name.trim(), kind: onlyPublishable ? "publishable" : kind }),
    onSuccess: (created) => {
      setName("")
      setKind("publishable")
      onCreated(created)
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() !== "") create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("api.keys.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={nameId}>{t("api.keys.name")}</Label>
            <Input
              id={nameId}
              value={name}
              required
              placeholder={t("api.keys.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("api.keys.kind")}</legend>
            {(["publishable", "secret"] as const).map((option) => {
              const disabled = onlyPublishable && option === "secret"
              return (
                <label
                  key={option}
                  className="flex items-start gap-2 rounded-md border p-3 text-sm has-[:disabled]:opacity-50"
                >
                  <input
                    type="radio"
                    name="key-kind"
                    value={option}
                    checked={(onlyPublishable ? "publishable" : kind) === option}
                    disabled={disabled}
                    onChange={() => setKind(option)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">{t(`api.keys.${option}`)}</span>
                    <span className="text-muted-foreground">{t(`api.keys.${option}Hint`)}</span>
                  </span>
                </label>
              )
            })}
            {onlyPublishable ? (
              <p className="text-xs text-muted-foreground">{t("api.keys.onlyPublishable")}</p>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={name.trim() === "" || create.isPending}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Shows a key once right after it was created. The value only lives in this component's state, never in the
 * query cache, so leaving the dialog drops it.
 */
function NewKeyDialog({
  created,
  onClose,
}: {
  readonly created: { readonly key: string; readonly info: ApiKey }
  readonly onClose: () => void
}) {
  const secret = created.info.kind === "secret"
  const valueId = useId()
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {secret ? t("api.keys.secretTitle") : t("api.keys.publishableTitle")}
          </DialogTitle>
          <DialogDescription>{created.info.name}</DialogDescription>
        </DialogHeader>
        {secret ? (
          <Alert variant="warning">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>{t("api.keys.secretTitle")}</AlertTitle>
            <AlertDescription>{t("api.keys.secretWarning")}</AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">{t("api.keys.publishableNote")}</p>
        )}
        <div className="grid gap-2">
          <Label htmlFor={valueId}>{t("api.keys.keyValue")}</Label>
          <div className="flex gap-2">
            <Input id={valueId} readOnly value={created.key} className="font-mono text-xs" />
            <CopyButton value={created.key} what={t("api.keys.keyValue")} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("api.keys.savedIt")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function canManage(kind: ApiKey["kind"], allowed: "all" | "publishable" | "none"): boolean {
  return allowed === "all" || (allowed === "publishable" && kind === "publishable")
}

/** API keys: list, create (secrets shown once) and revoke. */
export function KeysTab() {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<
    { readonly key: string; readonly info: ApiKey } | undefined
  >()
  const [revoking, setRevoking] = useState<ApiKey | undefined>(undefined)
  const query = useQuery({ queryKey: keys.apiKeys, queryFn: ({ signal }) => api.apiKeys(signal) })
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api.revokeApiKey(key.id),
    onSuccess: async (_, key) => {
      setRevoking(undefined)
      await queryClient.invalidateQueries({ queryKey: keys.apiKeys })
      toast({ title: t("api.keys.revoked", { name: key.name }), variant: "success" })
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  return (
    <div className="grid gap-4">
      {permissions.createKeys === "none" ? (
        <p className="text-sm text-muted-foreground">{t("api.keys.readOnly")}</p>
      ) : (
        <div>
          <Button onClick={() => setCreating(true)}>{t("api.keys.create")}</Button>
        </div>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          feature={t("api.keys.feature")}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.length === 0 ? (
        <EmptyState>{t("api.keys.empty")}</EmptyState>
      ) : (
        <Table aria-label={t("api.tabs.keys")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("api.keys.name")}</TableHead>
              <TableHead>{t("api.keys.kind")}</TableHead>
              <TableHead>{t("api.keys.prefix")}</TableHead>
              <TableHead>{t("api.keys.created")}</TableHead>
              <TableHead>{t("api.keys.lastUsed")}</TableHead>
              <TableHead>{t("api.keys.status")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common.more")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.map((key) => {
              const revoked = key.revokedAt !== undefined && key.revokedAt !== null
              return (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <Badge variant={key.kind === "secret" ? "warning" : "secondary"}>
                      {t(`api.keys.${key.kind}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">
                    {key.kind === "publishable" && typeof key.key === "string" ? (
                      <span className="flex items-center gap-2">
                        <span className="max-w-64 truncate" title={key.key}>
                          {key.key}
                        </span>
                        <CopyButton value={key.key} what={key.name} />
                      </span>
                    ) : (
                      `canopy_${key.kind === "secret" ? "sk" : "pk"}_${key.prefix}…`
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {key.createdAt === undefined ? "" : formatDateTime(key.createdAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {key.lastUsedAt === undefined || key.lastUsedAt === null
                      ? t("common.never")
                      : formatRelative(key.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    {revoked ? (
                      <Badge variant="destructive">
                        {t("api.keys.revokedStatus", { when: formatRelative(key.revokedAt ?? "") })}
                      </Badge>
                    ) : (
                      <Badge variant="success">{t("api.keys.activeStatus")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {!revoked && canManage(key.kind, permissions.createKeys) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("api.keys.revoke", { name: key.name })}
                        onClick={() => setRevoking(key)}
                      >
                        {t("api.keys.revokeShort")}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(next) => {
          setCreating(false)
          setCreated(next)
          void queryClient.invalidateQueries({ queryKey: keys.apiKeys })
        }}
      />
      {created === undefined ? null : (
        <NewKeyDialog created={created} onClose={() => setCreated(undefined)} />
      )}
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => (open ? undefined : setRevoking(undefined))}
        title={t("api.keys.revokeTitle", { name: revoking?.name ?? "" })}
        description={t("api.keys.revokeBody")}
        confirmLabel={t("api.keys.revoke", { name: revoking?.name ?? "" })}
        destructive
        pending={revoke.isPending}
        onConfirm={() => {
          if (revoking !== undefined) revoke.mutate(revoking)
        }}
      />
    </div>
  )
}
