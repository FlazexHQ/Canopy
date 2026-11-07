import { CanopyError } from "@canopy/protocol"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { statusOf } from "../../api/client.ts"
import { ADMIN_ROLES, type Admin, type AdminRole, type Settings } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { CodeBlock } from "../../components/copy-button.tsx"
import { ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
import { isAllowRule } from "../../lib/ip.ts"

/** Whether a value is a browser origin: a scheme and host with an optional port, no path. */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
  } catch {
    return false
  }
}

/** Parses the retention field: empty keeps entries forever, otherwise whole days from 1 to 36,500. */
export function retentionOf(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const days = Number(trimmed)
  return days >= 1 && days <= 36_500 ? days : undefined
}

function AuditRetentionCard({
  settings,
  editable,
}: {
  readonly settings: Settings
  readonly editable: boolean
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const id = useId()
  const [text, setText] = useState(String(settings.auditRetentionDays ?? ""))
  const [problem, setProblem] = useState(false)
  useEffect(() => setText(String(settings.auditRetentionDays ?? "")), [settings])
  const save = useMutation({
    mutationFn: (auditRetentionDays: number | null) => api.updateSettings({ auditRetentionDays }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.settings, next)
      toast({ title: t("settings.saved"), variant: "success" })
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.audit")}</CardTitle>
        <CardDescription>{t("settings.auditDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-lg gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const days = retentionOf(text)
            setProblem(days === undefined)
            if (days !== undefined) save.mutate(days)
          }}
        >
          <Label htmlFor={id}>{t("settings.retention")}</Label>
          <div className="flex gap-2">
            <Input
              id={id}
              inputMode="numeric"
              value={text}
              disabled={!editable}
              placeholder={t("settings.retentionForever")}
              aria-invalid={problem}
              aria-describedby={`${id}-hint`}
              onChange={(event) => setText(event.target.value)}
              className="max-w-40"
            />
            {editable ? (
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t("common.saving") : t("common.save")}
              </Button>
            ) : null}
          </div>
          <p
            id={`${id}-hint`}
            role={problem ? "alert" : undefined}
            className={problem ? "text-sm text-destructive" : "text-xs text-muted-foreground"}
          >
            {problem ? t("settings.retentionInvalid") : t("settings.retentionHint")}
          </p>
        </form>
      </CardContent>
    </Card>
  )
}

/** Parses the sample rate field, a percentage from 0 to 100, into a share from 0 to 1. */
export function sampleRateOf(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined
  const percent = Number(trimmed)
  return percent >= 0 && percent <= 100 ? percent / 100 : undefined
}

/** Parses the request log retention field: whole days from 1 to 90. */
export function logRetentionOf(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const days = Number(trimmed)
  return days >= 1 && days <= 90 ? days : undefined
}

function useSaveSettings() {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.updateSettings(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.settings, next)
      void queryClient.invalidateQueries({ queryKey: keys.logs })
      toast({ title: t("settings.saved"), variant: "success" })
    },
  })
}

function RequestLogCard({
  settings,
  editable,
}: {
  readonly settings: Settings
  readonly editable: boolean
}) {
  const toast = useToast()
  const id = useId()
  const [rate, setRate] = useState(String(Math.round(settings.requestLogSampleRate * 10_000) / 100))
  const [days, setDays] = useState(String(settings.requestLogRetentionDays))
  const [problem, setProblem] = useState<"rate" | "days" | undefined>(undefined)
  useEffect(() => {
    setRate(String(Math.round(settings.requestLogSampleRate * 10_000) / 100))
    setDays(String(settings.requestLogRetentionDays))
  }, [settings])
  const save = useSaveSettings()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.requestLog.title")}</CardTitle>
        <CardDescription>{t("settings.requestLog.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-lg gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            const share = sampleRateOf(rate)
            const retention = logRetentionOf(days)
            setProblem(share === undefined ? "rate" : retention === undefined ? "days" : undefined)
            if (share === undefined || retention === undefined) return
            save.mutate(
              { requestLogSampleRate: share, requestLogRetentionDays: retention },
              {
                onError: (error) =>
                  toast({
                    title: t("common.errorTitle"),
                    description: errorMessage(error),
                    variant: "error",
                  }),
              },
            )
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={`${id}-rate`}>{t("settings.requestLog.rate")}</Label>
            <Input
              id={`${id}-rate`}
              inputMode="decimal"
              value={rate}
              disabled={!editable}
              aria-invalid={problem === "rate"}
              aria-describedby={`${id}-rate-hint`}
              onChange={(event) => setRate(event.target.value)}
              className="max-w-40"
            />
            <p
              id={`${id}-rate-hint`}
              role={problem === "rate" ? "alert" : undefined}
              className={
                problem === "rate" ? "text-sm text-destructive" : "text-xs text-muted-foreground"
              }
            >
              {problem === "rate"
                ? t("settings.requestLog.rateInvalid")
                : t("settings.requestLog.rateHint")}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-days`}>{t("settings.requestLog.retention")}</Label>
            <Input
              id={`${id}-days`}
              inputMode="numeric"
              value={days}
              disabled={!editable}
              aria-invalid={problem === "days"}
              aria-describedby={`${id}-days-hint`}
              onChange={(event) => setDays(event.target.value)}
              className="max-w-40"
            />
            <p
              id={`${id}-days-hint`}
              role={problem === "days" ? "alert" : undefined}
              className={
                problem === "days" ? "text-sm text-destructive" : "text-xs text-muted-foreground"
              }
            >
              {problem === "days"
                ? t("settings.requestLog.retentionInvalid")
                : t("settings.requestLog.retentionHint")}
            </p>
          </div>
          {editable ? (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  )
}

function AllowlistCard({
  settings,
  editable,
}: {
  readonly settings: Settings
  readonly editable: boolean
}) {
  const id = useId()
  const [rules, setRules] = useState<readonly string[]>(settings.adminAllowlist)
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  useEffect(() => setRules(settings.adminAllowlist), [settings])
  const save = useSaveSettings()
  const dirty = JSON.stringify(rules) !== JSON.stringify(settings.adminAllowlist)
  const add = () => {
    const value = draft.trim()
    if (!isAllowRule(value)) {
      setProblem(t("settings.allowlist.invalid", { value }))
      return
    }
    if (rules.includes(value)) {
      setProblem(t("settings.allowlist.duplicate", { value }))
      return
    }
    setProblem(undefined)
    setRules([...rules, value])
    setDraft("")
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.allowlist.title")}</CardTitle>
        <CardDescription>{t("settings.allowlist.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid max-w-lg gap-4">
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.allowlist.empty")}</p>
        ) : (
          <ul className="grid gap-1" aria-label={t("settings.allowlist.title")}>
            {rules.map((rule) => (
              <li
                key={rule}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5"
              >
                <span className="font-mono text-sm">{rule}</span>
                {editable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("settings.allowlist.remove", { value: rule })}
                    onClick={() => setRules(rules.filter((entry) => entry !== rule))}
                  >
                    {t("common.delete")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {editable ? (
          <>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                add()
              }}
            >
              <Label htmlFor={`${id}-rule`}>{t("settings.allowlist.add")}</Label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-rule`}
                  value={draft}
                  placeholder="203.0.113.0/24"
                  className="font-mono"
                  aria-invalid={problem !== undefined}
                  aria-describedby={`${id}-rule-hint`}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <Button type="submit" variant="outline" disabled={draft.trim() === ""}>
                  {t("settings.allowlist.addButton")}
                </Button>
              </div>
              <p
                id={`${id}-rule-hint`}
                role={problem === undefined ? undefined : "alert"}
                className={
                  problem === undefined
                    ? "text-xs text-muted-foreground"
                    : "text-sm text-destructive"
                }
              >
                {problem ?? t("settings.allowlist.hint")}
              </p>
            </form>
            <div className="flex gap-2">
              <Button
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate(
                    { adminAllowlist: rules },
                    {
                      onError: (error) => {
                        const reason =
                          error instanceof CanopyError ? error.details?.["reason"] : undefined
                        setProblem(
                          reason === "lockout"
                            ? t("settings.allowlist.lockout")
                            : errorMessage(error),
                        )
                      },
                    },
                  )
                }
              >
                {save.isPending ? t("common.saving") : t("settings.allowlist.save")}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty}
                onClick={() => setRules(settings.adminAllowlist)}
              >
                {t("common.reset")}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

const CONFIG_EXAMPLE = `export default defineConfig({
  publicUrl: "https://api.example.com",
  cors: { origins: ["https://app.example.com"] },
  rest: { defaultLimit: 50, maxLimit: 1000 },
})`

function ConfigCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.config")}</CardTitle>
        <CardDescription>{t("settings.configDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <CodeBlock code={CONFIG_EXAMPLE} what={t("settings.config")} />
        <p className="text-xs text-muted-foreground">{t("settings.configHint")}</p>
      </CardContent>
    </Card>
  )
}

function RealtimeCard() {
  const api = useApi()
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
  })
  const realtime = (collections.data ?? []).filter((collection) => collection.realtime)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.realtime")}</CardTitle>
        <CardDescription>{t("settings.realtimeDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {collections.isPending ? (
          <LoadingState rows={2} />
        ) : collections.isError ? (
          <ErrorState error={collections.error} />
        ) : realtime.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.noRealtime")}</p>
        ) : (
          <Table aria-label={t("settings.images")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.collection")}</TableHead>
                <TableHead>{t("settings.images")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {realtime.map((collection) => (
                <TableRow key={collection.name}>
                  <TableCell className="font-medium">{collection.name}</TableCell>
                  <TableCell>
                    <Badge variant={collection.images === "on" ? "success" : "secondary"}>
                      {collection.images === "on"
                        ? t("settings.imagesOn")
                        : collection.images === "off"
                          ? t("settings.imagesOff")
                          : t("settings.imagesUnknown")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">{t("settings.imagesHint")}</p>
      </CardContent>
    </Card>
  )
}

function CreateAdminDialog({
  open,
  onOpenChange,
  roles,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly roles: readonly AdminRole[]
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const emailId = useId()
  const nameId = useId()
  const roleId = useId()
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<AdminRole>("developer")
  const [created, setCreated] = useState<{ email: string; password: string } | undefined>(undefined)
  const create = useMutation({
    mutationFn: () =>
      api.createAdmin({
        email: email.trim(),
        role,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
      }),
    onSuccess: async (result) => {
      setCreated({ email: result.admin.email, password: result.password })
      await queryClient.invalidateQueries({ queryKey: keys.admins })
    },
  })
  const close = (next: boolean) => {
    if (!next) {
      setEmail("")
      setName("")
      setRole("developer")
      setCreated(undefined)
      create.reset()
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.adminCreate")}</DialogTitle>
          <DialogDescription>
            {created === undefined
              ? t("settings.adminCreateDescription")
              : t("settings.adminPasswordOnce")}
          </DialogDescription>
        </DialogHeader>
        {created !== undefined ? (
          <div className="grid gap-2">
            <p className="text-sm">{t("settings.adminPasswordFor", { email: created.email })}</p>
            <CodeBlock code={created.password} what={t("settings.adminPassword")} />
            <DialogFooter>
              <Button onClick={() => close(false)}>{t("common.done")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor={emailId}>{t("settings.email")}</Label>
              <Input
                id={emailId}
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={nameId}>
                {t("settings.name")}
                <span className="font-normal text-muted-foreground">({t("common.optional")})</span>
              </Label>
              <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={roleId}>{t("settings.role")}</Label>
              <Select value={role} onValueChange={(value) => setRole(value as AdminRole)}>
                <SelectTrigger id={roleId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`common.roles.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {create.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(create.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending || email.trim() === ""}>
                {t("common.create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

type AdminAction = "disable" | "enable" | "resetTotp" | "remove"

function AdminsCard() {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const session = useSession()
  const { permissions } = session
  const admins = useQuery({ queryKey: keys.admins, queryFn: ({ signal }) => api.admins(signal) })
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<{ admin: Admin; action: AdminAction } | undefined>(
    undefined,
  )
  const done = async (title: string) => {
    setPending(undefined)
    await queryClient.invalidateQueries({ queryKey: keys.admins })
    toast({ title, variant: "success" })
  }
  const fail = (error: unknown) =>
    toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" })
  const change = useMutation({
    mutationFn: ({ admin, role }: { admin: Admin; role: AdminRole }) =>
      api.updateAdmin(admin.id, { role }),
    onSuccess: (admin) => done(t("settings.adminUpdated", { email: admin.email })),
    onError: fail,
  })
  const act = useMutation({
    mutationFn: async ({ admin, action }: { admin: Admin; action: AdminAction }) => {
      if (action === "remove") await api.removeAdmin(admin.id)
      else if (action === "resetTotp") await api.resetAdminTotp(admin.id)
      else await api.updateAdmin(admin.id, { disabled: action === "disable" })
      return admin
    },
    onSuccess: (admin) => done(t("settings.adminUpdated", { email: admin.email })),
    onError: fail,
  })
  const roles = ADMIN_ROLES.filter((role) => role !== "owner" || permissions.manageOwners)
  const manageable = (admin: Admin) =>
    permissions.manageAdmins &&
    admin.id !== session.admin.id &&
    (admin.role !== "owner" || permissions.manageOwners)
  if (!permissions.readAdmins) return null
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1.5">
          <CardTitle>{t("settings.admins")}</CardTitle>
          <CardDescription>{t("settings.adminsDescription")}</CardDescription>
        </div>
        {permissions.manageAdmins ? (
          <Button onClick={() => setCreating(true)}>{t("settings.adminCreate")}</Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {admins.isPending ? (
          <LoadingState rows={2} />
        ) : admins.isError ? (
          <ErrorState error={admins.error} feature={t("settings.admins")} />
        ) : (
          <Table aria-label={t("settings.admins")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.email")}</TableHead>
                <TableHead>{t("settings.role")}</TableHead>
                <TableHead>{t("settings.totp")}</TableHead>
                <TableHead>{t("settings.lastLogin")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("common.more")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.data.map((admin) => (
                <TableRow key={admin.id}>
                  <TableCell>
                    <span className="block">{admin.email}</span>
                    {admin.disabled === true ? (
                      <Badge variant="destructive">{t("settings.adminDisabled")}</Badge>
                    ) : admin.mustChangePassword === true ? (
                      <Badge variant="warning">{t("settings.adminMustChange")}</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {manageable(admin) ? (
                      <Select
                        value={admin.role}
                        onValueChange={(role) => change.mutate({ admin, role: role as AdminRole })}
                      >
                        <SelectTrigger
                          className="w-36"
                          aria-label={t("settings.adminRoleOf", { email: admin.email })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {roles.map((role) => (
                            <SelectItem key={role} value={role}>
                              {t(`common.roles.${role}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      t(`common.roles.${admin.role}`)
                    )}
                  </TableCell>
                  <TableCell>
                    {admin.totp === true ? t("settings.totpOn") : t("settings.totpOff")}
                  </TableCell>
                  <TableCell>
                    {admin.lastLoginAt === undefined
                      ? t("common.never")
                      : formatDateTime(admin.lastLoginAt)}
                  </TableCell>
                  <TableCell>
                    {manageable(admin) ? (
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setPending({
                              admin,
                              action: admin.disabled === true ? "enable" : "disable",
                            })
                          }
                        >
                          {admin.disabled === true
                            ? t("settings.adminEnable")
                            : t("settings.adminDisable")}
                        </Button>
                        {admin.totp === true ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPending({ admin, action: "resetTotp" })}
                          >
                            {t("settings.adminResetTotp")}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setPending({ admin, action: "remove" })}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CreateAdminDialog open={creating} onOpenChange={setCreating} roles={roles} />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => (open ? undefined : setPending(undefined))}
        title={
          pending === undefined
            ? ""
            : t(`settings.adminConfirm.${pending.action}`, { email: pending.admin.email })
        }
        confirmLabel={t("common.confirm")}
        destructive={pending?.action === "remove" || pending?.action === "disable"}
        pending={act.isPending}
        onConfirm={() => {
          if (pending !== undefined) act.mutate(pending)
        }}
      />
    </Card>
  )
}

type DangerAction = "revokeSessions" | "rotateMasterKey"

function DangerZone() {
  const api = useApi()
  const toast = useToast()
  const [action, setAction] = useState<DangerAction | undefined>(undefined)
  const run = useMutation({
    mutationFn: ({ which, typed }: { which: DangerAction; typed: string }) =>
      which === "revokeSessions" ? api.revokeAllSessions(typed) : api.rotateMasterKey(typed),
    onSuccess: (_, { which }) => {
      setAction(undefined)
      toast({
        title:
          which === "revokeSessions"
            ? t("settings.danger.revokeSessionsDone")
            : t("settings.danger.rotateMasterKeyDone"),
        variant: "success",
      })
    },
    onError: (error) => {
      setAction(undefined)
      toast({
        title: statusOf(error) === 404 ? t("common.notAvailableTitle") : t("common.errorTitle"),
        description:
          statusOf(error) === 404 ? t("settings.danger.notAvailable") : errorMessage(error),
        variant: "error",
      })
    },
  })
  const phrase =
    action === "rotateMasterKey"
      ? t("settings.danger.rotateMasterKeyPhrase")
      : t("settings.danger.revokeSessionsPhrase")
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>{t("settings.danger.title")}</CardTitle>
        <CardDescription>{t("settings.danger.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {(["revokeSessions", "rotateMasterKey"] as const).map((which) => (
          <div key={which} className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-prose text-sm text-muted-foreground">
              {t(`settings.danger.${which}Body`)}
            </p>
            <Button variant="destructive" onClick={() => setAction(which)}>
              {t(`settings.danger.${which}`)}
            </Button>
          </div>
        ))}
      </CardContent>
      <ConfirmDialog
        open={action !== undefined}
        onOpenChange={(open) => (open ? undefined : setAction(undefined))}
        title={action === undefined ? "" : t(`settings.danger.${action}`)}
        description={action === undefined ? undefined : t(`settings.danger.${action}Body`)}
        confirmLabel={action === undefined ? t("common.confirm") : t(`settings.danger.${action}`)}
        destructive
        typedConfirmation={phrase}
        pending={run.isPending}
        onConfirm={({ typed }) => {
          if (action !== undefined) run.mutate({ which: action, typed })
        }}
      />
    </Card>
  )
}

export function SettingsPage() {
  const api = useApi()
  const { permissions } = useSession()
  const query = useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => api.settings(signal),
    enabled: permissions.readSettings,
  })
  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      <div className="grid max-w-4xl gap-6">
        {permissions.manageSettings ? null : (
          <p className="text-sm text-muted-foreground">{t("settings.readOnly")}</p>
        )}
        {!permissions.readSettings ? null : query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <AuditRetentionCard settings={query.data} editable={permissions.manageSettings} />
            <RequestLogCard settings={query.data} editable={permissions.manageSettings} />
            <AllowlistCard settings={query.data} editable={permissions.manageSettings} />
          </>
        )}
        <AdminsCard />
        <RealtimeCard />
        <ConfigCard />
        {permissions.dangerZone ? <DangerZone /> : null}
      </div>
    </>
  )
}
