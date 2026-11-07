import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import type { AppUser } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { useViewAs } from "../../app/view-as.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

function nameOf(user: AppUser): string {
  return user.email ?? user.name ?? user.id
}

/** The identity "view as" uses for an app user: their roles and the claims their token would carry. */
export function viewAsUser(user: AppUser) {
  return {
    roles: user.roles !== undefined && user.roles.length > 0 ? user.roles : ["authenticated"],
    claims: {
      sub: user.id,
      ...(user.email === undefined || user.email === null ? {} : { email: user.email }),
      ...(user.appMetadata ?? {}),
    },
    label: nameOf(user),
  }
}

function UserDetail({ user, onClose }: { readonly user: AppUser; readonly onClose: () => void }) {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const { start } = useViewAs()
  const [confirm, setConfirm] = useState<"delete" | "revoke" | undefined>(undefined)
  const label = nameOf(user)
  const done = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: keys.users })
    toast({ title: message, variant: "success" })
  }
  const fail = (error: unknown) =>
    toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" })
  const ban = useMutation({
    mutationFn: () => api.updateUser(user.id, { banned: user.banned !== true }),
    onSuccess: (next) =>
      done(
        t(next.banned === true ? "auth.users.banned_toast" : "auth.users.unbanned_toast", {
          email: label,
        }),
      ),
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: async () => {
      setConfirm(undefined)
      onClose()
      await done(t("auth.users.deleted_toast", { email: label }))
    },
    onError: fail,
  })
  const revoke = useMutation({
    mutationFn: () => api.revokeUserSessions(user.id),
    onSuccess: async () => {
      setConfirm(undefined)
      await done(t("auth.users.revoked_toast", { email: label }))
    },
    onError: fail,
  })
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("auth.users.detailTitle", { email: label })}</DialogTitle>
          <DialogDescription>
            {t("auth.users.id")}: <code className="font-mono">{user.id}</code>
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("auth.users.roles")}</dt>
          <dd>{(user.roles ?? ["authenticated"]).join(", ")}</dd>
          <dt className="text-muted-foreground">{t("auth.users.status")}</dt>
          <dd>{user.banned === true ? t("auth.users.banned") : t("auth.users.active")}</dd>
          <dt className="text-muted-foreground">{t("auth.users.lastSignIn")}</dt>
          <dd>
            {user.lastSignInAt === undefined || user.lastSignInAt === null
              ? t("common.never")
              : formatDateTime(user.lastSignInAt)}
          </dd>
        </dl>
        <section aria-labelledby="user-identities">
          <h3 id="user-identities" className="mb-1 text-sm font-medium">
            {t("auth.users.identities")}
          </h3>
          {(user.identities ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("auth.users.noIdentities")}</p>
          ) : (
            <ul className="text-sm">
              {(user.identities ?? []).map((identity) => (
                <li key={`${identity.provider}:${identity.subject ?? ""}`}>
                  <Badge variant="outline">{identity.provider}</Badge> {identity.subject}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="user-sessions">
          <h3 id="user-sessions" className="mb-1 text-sm font-medium">
            {t("auth.users.sessions")}
          </h3>
          {(user.sessions ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("auth.users.noSessions")}</p>
          ) : (
            <ul className="text-sm">
              {(user.sessions ?? []).map((session) => (
                <li key={session.id}>
                  {session.userAgent ?? session.id}
                  {session.createdAt === undefined
                    ? null
                    : ` (${formatRelative(session.createdAt)})`}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="user-app-metadata">
          <h3 id="user-app-metadata" className="text-sm font-medium">
            {t("auth.users.appMetadata")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("auth.users.appMetadataHint")}</p>
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            {JSON.stringify(user.appMetadata ?? {}, null, 2)}
          </pre>
        </section>
        <section aria-labelledby="user-user-metadata">
          <h3 id="user-user-metadata" className="text-sm font-medium">
            {t("auth.users.userMetadata")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("auth.users.userMetadataHint")}</p>
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            {JSON.stringify(user.userMetadata ?? {}, null, 2)}
          </pre>
        </section>
        <div className="flex flex-wrap gap-2">
          {permissions.impersonate ? (
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
          ) : null}
          {permissions.manageUsers ? (
            <>
              <Button variant="outline" disabled={ban.isPending} onClick={() => ban.mutate()}>
                {user.banned === true ? t("auth.users.unban") : t("auth.users.ban")}
              </Button>
              <Button variant="outline" onClick={() => setConfirm("revoke")}>
                {t("auth.users.revokeSessions")}
              </Button>
              <Button variant="destructive" onClick={() => setConfirm("delete")}>
                {t("auth.users.delete")}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("auth.users.readOnly")}</p>
          )}
        </div>
        <ConfirmDialog
          open={confirm === "delete"}
          onOpenChange={(open) => setConfirm(open ? "delete" : undefined)}
          title={t("auth.users.deleteTitle", { email: label })}
          description={t("auth.users.deleteBody")}
          confirmLabel={t("auth.users.delete")}
          destructive
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
        <ConfirmDialog
          open={confirm === "revoke"}
          onOpenChange={(open) => setConfirm(open ? "revoke" : undefined)}
          title={t("auth.users.revokeTitle", { email: label })}
          description={t("auth.users.revokeBody")}
          confirmLabel={t("auth.users.revokeSessions")}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate()}
        />
      </DialogContent>
    </Dialog>
  )
}

/** App users: search, details, ban, delete, force sign out and "view as". */
export function UsersTab() {
  const api = useApi()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const query = useQuery({
    queryKey: [...keys.users, search],
    queryFn: ({ signal }) => api.users({ search }, signal),
  })
  const user = query.data?.users.find((candidate) => candidate.id === selected)
  return (
    <div className="grid gap-4">
      <div className="grid max-w-sm gap-2">
        <Label htmlFor="user-search">{t("auth.users.searchLabel")}</Label>
        <Input
          id="user-search"
          type="search"
          value={search}
          placeholder={t("auth.users.searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          feature={t("auth.features.users")}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.users.length === 0 ? (
        <EmptyState>{t("auth.users.empty")}</EmptyState>
      ) : (
        <Table aria-label={t("auth.tabs.users")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("auth.users.email")}</TableHead>
              <TableHead>{t("auth.users.name")}</TableHead>
              <TableHead>{t("auth.users.status")}</TableHead>
              <TableHead>{t("auth.users.lastSignIn")}</TableHead>
              <TableHead>{t("auth.users.created")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.users.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    aria-label={t("auth.users.details", { email: nameOf(entry) })}
                    onClick={() => setSelected(entry.id)}
                  >
                    {nameOf(entry)}
                  </Button>
                </TableCell>
                <TableCell>{entry.name ?? ""}</TableCell>
                <TableCell>
                  <Badge variant={entry.banned === true ? "destructive" : "secondary"}>
                    {entry.banned === true ? t("auth.users.banned") : t("auth.users.active")}
                  </Badge>
                </TableCell>
                <TableCell>
                  {entry.lastSignInAt === undefined || entry.lastSignInAt === null
                    ? t("common.never")
                    : formatRelative(entry.lastSignInAt)}
                </TableCell>
                <TableCell>
                  {entry.createdAt === undefined ? "" : formatDateTime(entry.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {user === undefined ? null : (
        <UserDetail user={user} onClose={() => setSelected(undefined)} />
      )}
    </div>
  )
}
