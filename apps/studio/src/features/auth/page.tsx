import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import { errorMessage, useToast } from "../../components/toast.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.tsx"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { formatDateTime, t } from "../../i18n/index.ts"
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

const SAMPLE = {
  name: "Alice",
  link: "https://app.example.com/verify?token=sample",
  email: "alice@example.com",
}

/** Fills `{{name}}` placeholders of an email template with test data. */
export function previewTemplate(text: string): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in SAMPLE ? SAMPLE[key as keyof typeof SAMPLE] : match,
  )
}

function TemplatesTab() {
  const api = useApi()
  const query = useQuery({
    queryKey: keys.templates,
    queryFn: ({ signal }) => api.templates(signal),
  })
  const [chosen, setChosen] = useState<string | undefined>(undefined)
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
  if (query.data.length === 0) return <EmptyState>{t("auth.templates.empty")}</EmptyState>
  const template = query.data.find((entry) => entry.id === chosen) ?? query.data[0]
  return (
    <div className="grid gap-4">
      <div className="grid max-w-xs gap-2">
        <Label htmlFor="template-choice">{t("auth.templates.choose")}</Label>
        <Select value={template?.id ?? ""} onValueChange={setChosen}>
          <SelectTrigger id="template-choice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {query.data.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {template === undefined ? null : (
        <Card>
          <CardHeader>
            <CardTitle>{t("auth.templates.preview")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>
              <span className="text-muted-foreground">{t("auth.templates.subject")}: </span>
              {previewTemplate(template.subject)}
            </p>
            <div>
              <p className="text-muted-foreground">{t("auth.templates.body")}</p>
              <p
                data-testid="template-preview"
                className="whitespace-pre-wrap rounded-md border p-3"
              >
                {previewTemplate(template.body)}
              </p>
            </div>
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
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: keys.signingKeys,
    queryFn: ({ signal }) => api.signingKeys(signal),
  })
  const rotate = useMutation({
    mutationFn: () => api.rotateSigningKey(),
    onSuccess: async ({ kid }) => {
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: keys.signingKeys })
      toast({ title: t("auth.keys.rotated", { kid }), variant: "success" })
    },
    onError: (error) =>
      toast({ title: t("common.errorTitle"), description: errorMessage(error), variant: "error" }),
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
  return (
    <div className="grid gap-4">
      {permissions.manageSettings ? (
        <div>
          <Button onClick={() => setOpen(true)}>{t("auth.keys.rotate")}</Button>
        </div>
      ) : null}
      {query.data.length === 0 ? (
        <EmptyState>{t("auth.keys.empty")}</EmptyState>
      ) : (
        <Table aria-label={t("auth.tabs.keys")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("auth.keys.kid")}</TableHead>
              <TableHead>{t("auth.keys.alg")}</TableHead>
              <TableHead>{t("auth.keys.status")}</TableHead>
              <TableHead>{t("auth.keys.created")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.map((key) => (
              <TableRow key={key.kid}>
                <TableCell className="font-mono text-xs">{key.kid}</TableCell>
                <TableCell>{key.alg}</TableCell>
                <TableCell>
                  <Badge variant={key.status === "active" ? "success" : "secondary"}>
                    {t(`auth.keys.${key.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {key.createdAt === undefined ? "" : formatDateTime(key.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("auth.keys.rotateTitle")}
        description={t("auth.keys.rotateBody")}
        confirmLabel={t("auth.keys.rotate")}
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>{formatDateTime(entry.at)}</TableCell>
            <TableCell>{entry.actor}</TableCell>
            <TableCell className="font-mono text-xs">{entry.action}</TableCell>
            <TableCell>{entry.target ?? ""}</TableCell>
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
          <TabsTrigger value="providers">{t("auth.tabs.providers")}</TabsTrigger>
          <TabsTrigger value="templates">{t("auth.tabs.templates")}</TabsTrigger>
          <TabsTrigger value="tokens">{t("auth.tabs.tokens")}</TabsTrigger>
          <TabsTrigger value="keys">{t("auth.tabs.keys")}</TabsTrigger>
          <TabsTrigger value="audit">{t("auth.tabs.audit")}</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="providers" className="mt-4">
          <ProvidersTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="tokens" className="mt-4">
          <TokensTab />
        </TabsContent>
        <TabsContent value="keys" className="mt-4">
          <KeysTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </>
  )
}
