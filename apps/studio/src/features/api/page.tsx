import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { ADMIN_BASE_PATH, type AdminApi } from "../../api/client.ts"
import { keys, useApi } from "../../app/context.tsx"
import { useTheme } from "../../app/theme.ts"
import { CodeBlock } from "../../components/copy-button.tsx"
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/states.tsx"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx"
import { t } from "../../i18n/index.ts"
import { NativeSelect } from "../realtime/native-select.tsx"
import { KeysTab } from "./keys.tsx"
import {
  insertSnippet,
  querySnippet,
  reactSnippet,
  setupSnippet,
  TYPEGEN_COMMANDS,
} from "./snippets.ts"

/** The server origin the admin API client talks to, empty for the page origin. */
export function serverOrigin(api: AdminApi): string {
  const admin = api.url("")
  return admin.endsWith(ADMIN_BASE_PATH) ? admin.slice(0, -ADMIN_BASE_PATH.length) : ""
}

const REFERENCE_ROLES = ["anon", "authenticated", "service"] as const

function ReferenceTab() {
  const api = useApi()
  const theme = useTheme()
  const host = useRef<HTMLDivElement>(null)
  const roleId = useId()
  const [role, setRole] = useState<(typeof REFERENCE_ROLES)[number]>("authenticated")
  const [mounting, setMounting] = useState(true)
  const spec = useQuery({
    queryKey: [...keys.openapi, role],
    queryFn: ({ signal }) => api.openApi(role, signal),
  })
  const dark =
    theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"))
  useEffect(() => {
    const element = host.current
    if (element === null || spec.data === undefined) return
    let unmount: (() => void) | undefined
    let cancelled = false
    void import("./scalar.ts").then(({ mountReference }) => {
      if (cancelled) return
      unmount = mountReference(element, spec.data, dark)
      setMounting(false)
    })
    return () => {
      cancelled = true
      unmount?.()
    }
  }, [spec.data, dark])
  if (spec.isPending) return <LoadingState label={t("api.reference.loading")} />
  if (spec.isError) {
    return (
      <ErrorState
        error={spec.error}
        feature={t("api.reference.feature")}
        onRetry={() => void spec.refetch()}
      />
    )
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={roleId}>{t("api.reference.role")}</Label>
        <NativeSelect
          id={roleId}
          value={role}
          onChange={(event) => {
            setMounting(true)
            setRole(event.target.value as (typeof REFERENCE_ROLES)[number])
          }}
        >
          {REFERENCE_ROLES.map((option) => (
            <option key={option} value={option}>
              {t(`api.reference.roles.${option}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">{t("api.reference.note")}</p>
      {mounting ? <LoadingState rows={1} label={t("api.reference.loading")} /> : null}
      <div ref={host} data-testid="scalar-reference" className="min-h-96 rounded-md border" />
    </div>
  )
}

function SnippetsTab() {
  const api = useApi()
  const selectId = useId()
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
  })
  const apiKeys = useQuery({ queryKey: keys.apiKeys, queryFn: ({ signal }) => api.apiKeys(signal) })
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  if (collections.isPending) return <LoadingState />
  if (collections.isError)
    return <ErrorState error={collections.error} onRetry={() => void collections.refetch()} />
  const exposed = collections.data.filter((collection) => collection.exposed)
  if (exposed.length === 0) return <EmptyState>{t("api.snippets.noExposed")}</EmptyState>
  const collection = exposed.find((entry) => entry.name === chosen)?.name ?? exposed[0]?.name ?? ""
  const publishable = (apiKeys.data ?? []).find(
    (key) =>
      key.kind === "publishable" &&
      (key.revokedAt === undefined || key.revokedAt === null) &&
      typeof key.key === "string",
  )
  const origin = serverOrigin(api) || window.location.origin
  const input = { url: origin, collection, publishableKey: publishable?.key ?? undefined }
  return (
    <div className="grid gap-4">
      <div className="grid max-w-xs gap-2">
        <Label htmlFor={selectId}>{t("api.snippets.collection")}</Label>
        <Select value={collection} onValueChange={setChosen}>
          <SelectTrigger id={selectId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {exposed.map((entry) => (
              <SelectItem key={entry.name} value={entry.name}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {publishable === undefined ? (
        <p className="text-sm text-muted-foreground">{t("api.snippets.noKey")}</p>
      ) : null}
      {(
        [
          ["setup", setupSnippet(input)],
          ["query", querySnippet(input)],
          ["insert", insertSnippet(input)],
          ["live", reactSnippet(input)],
        ] as const
      ).map(([id, code]) => (
        <section key={id} aria-labelledby={`snippet-${id}`} className="grid gap-2">
          <h2 id={`snippet-${id}`} className="text-sm font-medium">
            {t(`api.snippets.${id}`)}
          </h2>
          <CodeBlock code={code} what={t(`api.snippets.${id}`)} />
        </section>
      ))}
    </div>
  )
}

function TypesTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("api.types.title")}</CardTitle>
        <CardDescription>{t("api.types.body")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {(["generate", "role", "check"] as const).map((id) => (
          <div key={id} className="grid gap-1">
            <p className="text-sm">{t(`api.types.${id}`)}</p>
            <CodeBlock code={TYPEGEN_COMMANDS[id]} what={t(`api.types.${id}`)} />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function ApiPage() {
  const [tab, setTab] = useState("keys")
  return (
    <>
      <PageHeader title={t("api.title")} description={t("api.description")} />
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="keys">{t("api.tabs.keys")}</TabsTrigger>
          <TabsTrigger value="reference">{t("api.tabs.reference")}</TabsTrigger>
          <TabsTrigger value="graphql">{t("api.tabs.graphql")}</TabsTrigger>
          <TabsTrigger value="snippets">{t("api.tabs.snippets")}</TabsTrigger>
          <TabsTrigger value="types">{t("api.tabs.types")}</TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="mt-4">
          <KeysTab />
        </TabsContent>
        <TabsContent value="reference" className="mt-4">
          {tab === "reference" ? <ReferenceTab /> : null}
        </TabsContent>
        <TabsContent value="graphql" className="mt-4">
          <EmptyState title={t("api.graphql.title")}>{t("api.graphql.body")}</EmptyState>
        </TabsContent>
        <TabsContent value="snippets" className="mt-4">
          <SnippetsTab />
        </TabsContent>
        <TabsContent value="types" className="mt-4">
          <TypesTab />
        </TabsContent>
      </Tabs>
    </>
  )
}
