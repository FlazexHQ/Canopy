import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { SigningKey } from "../../api/contract.ts"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
import { TemplatesTab } from "./templates.tsx"
import { UsersTab } from "./users.tsx"

function ProvidersTab() {
  const api = useApi()
  const query = useQuery({
    queryKey: keys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("auth.features.providers")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const { mode, providers, external } = query.data
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        <span className="text-muted-foreground">{t("auth.providers.mode")}: </span>
        {mode === "builtin" ? t("auth.providers.builtin") : t("auth.providers.external")}
      </p>
      <Table aria-label={t("auth.tabs.providers")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("auth.providers.provider")}</TableHead>
            <TableHead>{t("auth.providers.enabled")}</TableHead>
            <TableHead>{t("auth.providers.configured")}</TableHead>
            <TableHead>{t("auth.providers.clientId")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((provider) => (
            <TableRow key={provider.id}>
              <TableCell className="font-medium">{provider.id}</TableCell>
              <TableCell>{provider.enabled ? t("common.on") : t("common.off")}</TableCell>
              <TableCell>
                {provider.configured === false ? (
                  <Badge variant="warning">{t("auth.providers.notConfigured")}</Badge>
                ) : (
                  t("common.yes")
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">{provider.clientId ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {external === undefined ? null : (
        <Card>
          <CardHeader>
            <CardTitle>{t("auth.providers.externalTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("auth.providers.issuer")}</dt>
              <dd>{external.issuer ?? t("common.unknown")}</dd>
              <dt className="text-muted-foreground">{t("auth.providers.audience")}</dt>
              <dd>{external.audience ?? t("common.unknown")}</dd>
              <dt className="text-muted-foreground">{t("auth.providers.jwksUrl")}</dt>
              <dd className="break-all">{external.jwksUrl ?? t("common.unknown")}</dd>
              <dt className="text-muted-foreground">{t("auth.providers.algorithms")}</dt>
              <dd>{(external.algorithms ?? []).join(", ") || t("common.unknown")}</dd>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function TokensTab() {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("auth.tokens.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("auth.tokens.body")}</p>
        </CardContent>
      </Card>
      <ProvidersTab />
    </div>
  )
}

function KeysTab() {
  const api = useApi()
  const { permissions } = useSession()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [rotating, setRotating] = useState(false)
  const [revoking, setRevoking] = useState<string | undefined>(undefined)
  const query = useQuery({
    queryKey: keys.signingKeys,
    queryFn: ({ signal }) => api.signingKeys(signal),
  })
  const failed = (error: unknown) =>
    toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" })
  const rotate = useMutation({
    mutationFn: () => api.rotateSigningKey(),
    onSuccess: (data) => {
      setRotating(false)
      queryClient.setQueryData(keys.signingKeys, data)
      toast({ title: t("auth.keys.rotated"), variant: "success" })
    },
    onError: failed,
  })
  const revoke = useMutation({
    mutationFn: (kid: string) => api.revokeSigningKey(kid),
    onSuccess: (data, kid) => {
      setRevoking(undefined)
      queryClient.setQueryData(keys.signingKeys, data)
      toast({ title: t("auth.keys.revoked", { kid }), variant: "success" })
    },
    onError: failed,
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("auth.features.keys")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const variant = (state: SigningKey["state"]) =>
    state === "active"
      ? "success"
      : state === "revoked"
        ? "destructive"
        : state === "standby"
          ? "outline"
          : "secondary"
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t("auth.keys.intro")}</p>
      {permissions.manageSettings ? (
        <div>
          <Button onClick={() => setRotating(true)}>{t("auth.keys.rotate")}</Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("auth.keys.readOnly")}</p>
      )}
      {query.data.length === 0 ? (
        <EmptyState>{t("auth.keys.empty")}</EmptyState>
      ) : (
        <Table aria-label={t("auth.tabs.keys")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("auth.keys.kid")}</TableHead>
              <TableHead>{t("auth.keys.alg")}</TableHead>
              <TableHead>{t("auth.keys.state")}</TableHead>
              <TableHead>{t("auth.keys.created")}</TableHead>
              <TableHead>{t("auth.keys.expires")}</TableHead>
              {permissions.manageSettings ? (
                <TableHead>
                  <span className="sr-only">{t("common.more")}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.map((key) => (
              <TableRow key={key.kid}>
                <TableCell className="font-mono text-xs">{key.kid}</TableCell>
                <TableCell>{key.alg}</TableCell>
                <TableCell>
                  <Badge variant={variant(key.state)}>{t(`auth.keys.states.${key.state}`)}</Badge>
                </TableCell>
                <TableCell>{formatDateTime(key.createdAt)}</TableCell>
                <TableCell>{formatDateTime(key.expiresAt)}</TableCell>
                {permissions.manageSettings ? (
                  <TableCell>
                    {key.state === "revoked" ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={t("auth.keys.revokeLabel", { kid: key.kid })}
                        onClick={() => setRevoking(key.kid)}
                      >
                        {t("auth.keys.revoke")}
                      </Button>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title={t("auth.keys.rotateTitle")}
        description={t("auth.keys.rotateBody")}
        confirmLabel={t("auth.keys.rotate")}
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => (open ? undefined : setRevoking(undefined))}
        title={t("auth.keys.revokeTitle", { kid: revoking ?? "" })}
        description={t("auth.keys.revokeBody")}
        confirmLabel={t("auth.keys.revoke")}
        destructive
        typedConfirmation={revoking ?? ""}
        pending={revoke.isPending}
        onConfirm={() => {
          if (revoking !== undefined) revoke.mutate(revoking)
        }}
      />
    </div>
  )
}

function AuditTab() {
  const api = useApi()
  const query = useQuery({
    queryKey: [...keys.audit, "auth"],
    queryFn: ({ signal }) => api.audit({}, signal),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        feature={t("auth.features.audit")}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const entries = query.data.entries.filter(
    (entry) => entry.action.startsWith("user.") || entry.action.startsWith("auth."),
  )
  if (entries.length === 0) return <EmptyState>{t("auth.audit.empty")}</EmptyState>
  return (
    <Table aria-label={t("auth.tabs.audit")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("auth.audit.at")}</TableHead>
          <TableHead>{t("auth.audit.actor")}</TableHead>
          <TableHead>{t("auth.audit.action")}</TableHead>
          <TableHead>{t("auth.audit.target")}</TableHead>
          <TableHead>{t("auth.audit.outcome")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>{formatDateTime(entry.at)}</TableCell>
            <TableCell>{entry.actor}</TableCell>
            <TableCell className="font-mono text-xs">{entry.action}</TableCell>
            <TableCell>{entry.target ?? ""}</TableCell>
            <TableCell>{entry.outcome ?? "ok"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function AuthPage() {
  return (
    <>
      <PageHeader title={t("auth.title")} description={t("auth.description")} />
      <Tabs defaultValue="users" className="gap-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="users">{t("auth.tabs.users")}</TabsTrigger>
          <TabsTrigger value="templates">{t("auth.tabs.templates")}</TabsTrigger>
          <TabsTrigger value="keys">{t("auth.tabs.keys")}</TabsTrigger>
          <TabsTrigger value="providers">{t("auth.tabs.providers")}</TabsTrigger>
          <TabsTrigger value="audit">{t("auth.tabs.audit")}</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="keys" className="mt-4">
          <KeysTab />
        </TabsContent>
        <TabsContent value="providers" className="mt-4">
          <TokensTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </>
  )
}
