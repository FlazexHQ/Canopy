import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import type { AppUser, ViewAs } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { useViewAs } from "../../app/view-as.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Checkbox } from "../../components/ui/checkbox.tsx"
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
import { formatEjson, parseEjsonObject } from "../../lib/ejson.ts"

const PAGE_SIZE = 25

function nameOf(user: AppUser): string {
  return user.email ?? user.name ?? user.id
}

/**
 * The identity "view as" uses for an app user: `authenticated` plus their custom roles, and the claims a
 * built in auth token carries (`sub`, `email`, `app_metadata`, `roles`), so policies resolve the same way.
 */
export function viewAsUser(user: AppUser): ViewAs {
  return {
    roles: ["authenticated", ...user.roles],
    claims: {
      sub: user.id,
      ...(user.email === undefined ? {} : { email: user.email }),
      app_metadata: user.appMetadata,
      roles: user.roles,
    },
    label: nameOf(user),
  }
}

/** Parses the roles field: comma separated names, trimmed, without duplicates. */
export function parseRoles(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((role) => role.trim())
        .filter((role) => role !== ""),
    ),
  ]
}

function Sessions({ user }: { readonly user: AppUser }) {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const query = useQuery({
    queryKey: [...keys.user(user.id), "sessions"],
    queryFn: ({ signal }) => api.userSessions(user.id, signal),
  })
  const end = useMutation({
    mutationFn: (sid: string) => api.revokeUserSessions(user.id, sid),
    onSuccess: async (count) => {
      await queryClient.invalidateQueries({ queryKey: keys.user(user.id) })
      toast({
        title: t("auth.users.revokedToast", { count, email: nameOf(user) }),
        variant: "success",
      })
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  if (query.isPending) return <LoadingState rows={1} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (query.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("auth.users.noSessions")}</p>
  }
  return (
    <Table aria-label={t("auth.users.sessions")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("auth.users.sessionDevice")}</TableHead>
          <TableHead>{t("auth.users.sessionAddress")}</TableHead>
          <TableHead>{t("auth.users.sessionCreated")}</TableHead>
          <TableHead>{t("auth.users.sessionExpires")}</TableHead>
          {permissions.manageUsers ? (
            <TableHead>
              <span className="sr-only">{t("common.more")}</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {query.data.map((session) => (
          <TableRow key={session.id}>
            <TableCell>{session.userAgent ?? t("common.unknown")}</TableCell>
            <TableCell className="font-mono text-xs">{session.ipAddress ?? ""}</TableCell>
            <TableCell>{formatRelative(session.createdAt)}</TableCell>
            <TableCell>{formatDateTime(session.expiresAt)}</TableCell>
            {permissions.manageUsers ? (
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={end.isPending}
                  aria-label={t("auth.users.endSessionLabel", {
                    date: formatDateTime(session.createdAt),
                  })}
                  onClick={() => end.mutate(session.id)}
                >
                  {t("auth.users.endSession")}
                </Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function UserDetail({ user, onClose }: { readonly user: AppUser; readonly onClose: () => void }) {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { start } = useViewAs()
  const rolesId = useId()
  const rolesHintId = useId()
  const [confirm, setConfirm] = useState<"delete" | "revoke" | "ban" | undefined>(undefined)
  const [roles, setRoles] = useState(user.roles.join(", "))
  const [metadata, setMetadata] = useState(formatEjson(user.appMetadata))
  const [banUntil, setBanUntil] = useState("")
  const label = nameOf(user)
  const parsedMetadata = parseEjsonObject(metadata)
  const changed = roles !== user.roles.join(", ") || metadata !== formatEjson(user.appMetadata)

  const refresh = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: keys.users })
    toast({ title: message, variant: "success" })
  }
  const failed = (error: unknown) =>
    toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" })

  const save = useMutation({
    mutationFn: () => {
      if (!parsedMetadata.ok) throw new TypeError(t("auth.users.invalidJson"))
      return api.updateUser(user.id, {
        roles: parseRoles(roles),
        appMetadata: parsedMetadata.value,
      })
    },
    onSuccess: () => refresh(t("auth.users.saved", { email: label })),
    onError: failed,
  })
  const ban = useMutation({
    mutationFn: (reason: string) =>
      api.banUser(user.id, {
        ...(reason === "" ? {} : { reason }),
        ...(banUntil === "" ? {} : { until: new Date(banUntil).toISOString() }),
      }),
    onSuccess: async () => {
      setConfirm(undefined)
      await refresh(t("auth.users.bannedToast", { email: label }))
    },
    onError: failed,
  })
  const unban = useMutation({
    mutationFn: () => api.unbanUser(user.id),
    onSuccess: () => refresh(t("auth.users.unbannedToast", { email: label })),
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: async () => {
      setConfirm(undefined)
      onClose()
      await refresh(t("auth.users.deletedToast", { email: label }))
    },
    onError: failed,
  })
  const revoke = useMutation({
    mutationFn: () => api.revokeUserSessions(user.id),
    onSuccess: async (count) => {
      setConfirm(undefined)
      await queryClient.invalidateQueries({ queryKey: keys.user(user.id) })
      await refresh(t("auth.users.revokedToast", { count, email: label }))
    },
    onError: failed,
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("auth.users.detailTitle", { email: label })}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {t("auth.users.id")}: {user.id}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {user.banned ? (
            <Badge variant="destructive">
              {user.banExpires === undefined
                ? t("auth.users.banned")
                : t("auth.users.bannedUntil", { date: formatDateTime(user.banExpires) })}
            </Badge>
          ) : (
            <Badge variant="success">{t("auth.users.active")}</Badge>
          )}
          <Badge variant={user.emailVerified ? "secondary" : "warning"}>
            {user.emailVerified ? t("auth.users.verified") : t("auth.users.unverified")}
          </Badge>
          {user.isAnonymous ? <Badge variant="outline">{t("auth.users.anonymous")}</Badge> : null}
        </div>
        {user.banReason === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t("auth.users.banReason")}: {user.banReason}
          </p>
        )}
        <section className="grid gap-2" aria-labelledby={`${rolesId}-heading`}>
          <h3 id={`${rolesId}-heading`} className="font-medium">
            {t("auth.users.roles")}
          </h3>
          <Label htmlFor={rolesId}>{t("auth.users.rolesLabel")}</Label>
          <Input
            id={rolesId}
            value={roles}
            readOnly={!permissions.manageUsers}
            aria-describedby={rolesHintId}
            onChange={(event) => setRoles(event.target.value)}
          />
          <p id={rolesHintId} className="text-xs text-muted-foreground">
            {t("auth.users.rolesHint")}
          </p>
        </section>
        <section className="grid gap-2">
          <h3 className="font-medium">{t("auth.users.appMetadata")}</h3>
          <p className="text-xs text-muted-foreground">{t("auth.users.appMetadataHint")}</p>
          <CodeEditor
            label={t("auth.users.appMetadata")}
            value={metadata}
            onChange={setMetadata}
            readOnly={!permissions.manageUsers}
            minHeight="4rem"
          />
        </section>
        <section className="grid gap-2">
          <h3 className="font-medium">{t("auth.users.userMetadata")}</h3>
          <p className="text-xs text-warning">{t("auth.users.userMetadataHint")}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">
            {formatEjson(user.userMetadata)}
          </pre>
        </section>
        <section className="grid gap-2">
          <h3 className="font-medium">{t("auth.users.sessions")}</h3>
          <Sessions user={user} />
        </section>
        {permissions.manageUsers ? null : (
          <p className="text-sm text-muted-foreground">{t("auth.users.readOnly")}</p>
        )}
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              start(viewAsUser(user))
              onClose()
              void navigate({ to: "/data" })
            }}
          >
            {t("auth.users.viewAs")}
          </Button>
          {permissions.manageUsers ? (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!changed || !parsedMetadata.ok || save.isPending}
                onClick={() => save.mutate()}
              >
                {t("auth.users.saveChanges")}
              </Button>
              <Button variant="outline" onClick={() => setConfirm("revoke")}>
                {t("auth.users.revokeSessions")}
              </Button>
              {user.banned ? (
                <Button variant="outline" disabled={unban.isPending} onClick={() => unban.mutate()}>
                  {t("auth.users.unban")}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setConfirm("ban")}>
                  {t("auth.users.ban")}
                </Button>
              )}
              <Button variant="destructive" onClick={() => setConfirm("delete")}>
                {t("auth.users.delete")}
              </Button>
            </div>
          ) : null}
        </DialogFooter>
        <ConfirmDialog
          open={confirm === "ban"}
          onOpenChange={(open) => setConfirm(open ? "ban" : undefined)}
          title={t("auth.users.banTitle", { email: label })}
          description={t("auth.users.banBody")}
          confirmLabel={t("auth.users.ban")}
          destructive
          reason={{ label: t("auth.users.banReason"), required: false }}
          pending={ban.isPending}
          onConfirm={({ reason }) => ban.mutate(reason)}
        >
          <div className="grid gap-2">
            <Label htmlFor={`${rolesId}-until`}>{t("auth.users.banUntil")}</Label>
            <Input
              id={`${rolesId}-until`}
              type="datetime-local"
              value={banUntil}
              aria-describedby={`${rolesId}-until-hint`}
              onChange={(event) => setBanUntil(event.target.value)}
            />
            <p id={`${rolesId}-until-hint`} className="text-xs text-muted-foreground">
              {t("auth.users.banUntilHint")}
            </p>
          </div>
        </ConfirmDialog>
        <ConfirmDialog
          open={confirm === "revoke"}
          onOpenChange={(open) => setConfirm(open ? "revoke" : undefined)}
          title={t("auth.users.revokeTitle", { email: label })}
          description={t("auth.users.revokeBody")}
          confirmLabel={t("auth.users.revokeSessions")}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate()}
        />
        <ConfirmDialog
          open={confirm === "delete"}
          onOpenChange={(open) => setConfirm(open ? "delete" : undefined)}
          title={t("auth.users.deleteTitle", { email: label })}
          description={t("auth.users.deleteBody")}
          confirmLabel={t("auth.users.delete")}
          destructive
          typedConfirmation={label}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </DialogContent>
    </Dialog>
  )
}

function CreateUserDialog({
  mode,
  onClose,
}: {
  readonly mode: "create" | "invite"
  readonly onClose: () => void
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const toast = useToast()
  const id = useId()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [verified, setVerified] = useState(false)
  const [redirectTo, setRedirectTo] = useState("")
  const [roles, setRoles] = useState("")
  const mutation = useMutation({
    mutationFn: () => {
      const extra = parseRoles(roles)
      return mode === "create"
        ? api.createUser({
            email,
            ...(password === "" ? {} : { password }),
            emailVerified: verified,
            ...(extra.length === 0 ? {} : { roles: extra }),
          })
        : api.inviteUser({
            email,
            ...(redirectTo === "" ? {} : { redirectTo }),
            ...(extra.length === 0 ? {} : { roles: extra }),
          })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.users })
      toast({
        title:
          mode === "create"
            ? t("auth.users.createdToast", { email })
            : t("auth.users.invitedToast", { email }),
        variant: "success",
      })
      onClose()
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (email.trim() !== "" && !mutation.isPending) mutation.mutate()
  }
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? t("auth.users.createTitle") : t("auth.users.inviteTitle")}
            </DialogTitle>
            <DialogDescription>
              {mode === "create" ? t("auth.users.createBody") : t("auth.users.inviteBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-email`}>{t("auth.users.email")}</Label>
            <Input
              id={`${id}-email`}
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {mode === "create" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor={`${id}-password`}>{t("auth.users.password")}</Label>
                <Input
                  id={`${id}-password`}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-verified`}
                  checked={verified}
                  onCheckedChange={(value) => setVerified(value === true)}
                />
                <Label htmlFor={`${id}-verified`}>{t("auth.users.emailVerifiedLabel")}</Label>
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-redirect`}>{t("auth.users.redirectTo")}</Label>
              <Input
                id={`${id}-redirect`}
                type="url"
                value={redirectTo}
                aria-describedby={`${id}-redirect-hint`}
                onChange={(event) => setRedirectTo(event.target.value)}
              />
              <p id={`${id}-redirect-hint`} className="text-xs text-muted-foreground">
                {t("auth.users.redirectHint")}
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-roles`}>{t("auth.users.rolesLabel")}</Label>
            <Input
              id={`${id}-roles`}
              value={roles}
              onChange={(event) => setRoles(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={email.trim() === "" || mutation.isPending}>
              {mode === "create" ? t("auth.users.create") : t("auth.users.invite")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** App users of built in auth: search, paging, details, and the admin actions their role allows. */
export function UsersTab() {
  const api = useApi()
  const { permissions } = useSession()
  const searchId = useId()
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<"create" | "invite" | undefined>(undefined)
  const query = useQuery({
    queryKey: [...keys.users, search, offset],
    queryFn: ({ signal }) => api.users({ email: search, limit: PAGE_SIZE, offset }, signal),
  })
  const detail = useQuery({
    queryKey: keys.user(selected ?? ""),
    queryFn: ({ signal }) => api.user(selected ?? "", signal),
    enabled: selected !== undefined,
  })
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("auth.features.users")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const page = query.data
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid w-full max-w-sm gap-2">
          <Label htmlFor={searchId}>{t("auth.users.searchLabel")}</Label>
          <Input
            id={searchId}
            type="search"
            value={search}
            placeholder={t("auth.users.searchPlaceholder")}
            onChange={(event) => {
              setSearch(event.target.value)
              setOffset(0)
            }}
          />
        </div>
        {permissions.manageUsers ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDialog("invite")}>
              {t("auth.users.invite")}
            </Button>
            <Button onClick={() => setDialog("create")}>{t("auth.users.create")}</Button>
          </div>
        ) : null}
      </div>
      {page === undefined ? (
        <LoadingState />
      ) : page.users.length === 0 ? (
        <EmptyState>{search === "" ? t("auth.users.noneYet") : t("auth.users.empty")}</EmptyState>
      ) : (
        <>
          <Table aria-label={t("auth.tabs.users")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("auth.users.email")}</TableHead>
                <TableHead>{t("auth.users.name")}</TableHead>
                <TableHead>{t("auth.users.roles")}</TableHead>
                <TableHead>{t("auth.users.status")}</TableHead>
                <TableHead>{t("auth.users.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      aria-label={t("auth.users.details", { email: nameOf(user) })}
                      onClick={() => setSelected(user.id)}
                    >
                      {user.email ?? t("auth.users.anonymous")}
                    </Button>
                  </TableCell>
                  <TableCell>{user.name ?? ""}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {user.roles.length === 0 ? t("auth.users.noRoles") : user.roles.join(", ")}
                  </TableCell>
                  <TableCell>
                    {user.banned ? (
                      <Badge variant="destructive">{t("auth.users.banned")}</Badge>
                    ) : (
                      <Badge variant="success">{t("auth.users.active")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>{formatRelative(user.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span aria-live="polite">
              {t("auth.users.page", {
                from: offset + 1,
                to: offset + page.users.length,
                total: page.total,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                {t("auth.users.previous")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + page.users.length >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                {t("auth.users.next")}
              </Button>
            </div>
          </div>
        </>
      )}
      {selected !== undefined && detail.data !== undefined ? (
        <UserDetail
          key={`${detail.data.id}:${detail.data.updatedAt}`}
          user={detail.data}
          onClose={() => setSelected(undefined)}
        />
      ) : null}
      {dialog === undefined ? null : (
        <CreateUserDialog mode={dialog} onClose={() => setDialog(undefined)} />
      )}
    </div>
  )
}
