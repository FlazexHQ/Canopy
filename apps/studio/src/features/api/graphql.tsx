import { CanopyError, ErrorCode } from "@canopy/protocol"
import { useMutation, useQuery } from "@tanstack/react-query"
import { buildClientSchema, getIntrospectionQuery, type IntrospectionQuery } from "graphql"
import { PlayIcon } from "lucide-react"
import { useId, useMemo, useState } from "react"
import type { GraphqlRequest, GraphqlResponse } from "../../api/contract.ts"
import { useApi } from "../../app/context.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { EmptyState, ErrorState, LoadingState } from "../../components/states.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { NativeSelect } from "../../components/ui/native-select.tsx"
import { t } from "../../i18n/index.ts"
import {
  initialOperation,
  type RootField,
  rootFields,
  starterOperation,
} from "./graphql-starter.ts"

const ROLES = ["service", "anon", "authenticated"] as const
type RunAs = (typeof ROLES)[number]

function identity(role: RunAs, user: string): GraphqlRequest["as"] {
  if (role === "service") return undefined
  if (role === "anon") return { role: "anon" }
  const sub = user.trim()
  return sub === "" ? { role: "authenticated" } : { user: sub }
}

function parseVariables(text: string): Record<string, unknown> | undefined | null {
  if (text.trim() === "") return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function SchemaDocs({
  fields,
  onPick,
}: {
  readonly fields: readonly RootField[]
  readonly onPick: (field: RootField) => void
}) {
  return (
    <nav aria-label={t("api.graphql.docs")} className="grid content-start gap-3 text-sm">
      {(["query", "mutation", "subscription"] as const).map((kind) => {
        const list = fields.filter((field) => field.kind === kind)
        if (list.length === 0) return null
        const heading =
          kind === "query"
            ? t("api.graphql.queries")
            : kind === "mutation"
              ? t("api.graphql.mutations")
              : t("api.graphql.subscriptions")
        return (
          <section key={kind} className="grid gap-1">
            <h3 className="font-medium">{heading}</h3>
            {kind === "subscription" ? (
              <p className="text-xs text-muted-foreground">{t("api.graphql.subscriptionsNote")}</p>
            ) : null}
            <ul className="grid gap-1">
              {list.map((field) => (
                <li key={field.name}>
                  <button
                    type="button"
                    className="w-full rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-muted focus-visible:outline focus-visible:outline-2"
                    title={field.description}
                    aria-label={`${t("api.graphql.insert")}: ${field.name}`}
                    onClick={() => onPick(field)}
                  >
                    {field.signature}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </nav>
  )
}

/**
 * The GraphQL explorer: runs operations through the admin API as `service` or as an impersonated caller,
 * with completion and validation against the schema that caller sees.
 */
export function GraphqlExplorer() {
  const api = useApi()
  const roleId = useId()
  const userId = useId()
  const [role, setRole] = useState<RunAs>("service")
  const [user, setUser] = useState("")
  const [query, setQuery] = useState<string | undefined>(undefined)
  const [variables, setVariables] = useState("")
  const as = identity(role, role === "authenticated" ? user : "")
  const asKey = JSON.stringify(as ?? null)

  const introspection = useQuery({
    queryKey: ["graphql", "schema", asKey],
    queryFn: async ({ signal }) => {
      const result = await api.graphql(
        { query: getIntrospectionQuery(), ...(as === undefined ? {} : { as }) },
        signal,
      )
      if (result.data === undefined || result.data === null)
        throw new Error(result.errors?.[0]?.message ?? t("api.graphql.noSchema"))
      return buildClientSchema(result.data as unknown as IntrospectionQuery)
    },
    retry: false,
  })
  const schema = introspection.data
  const fields = useMemo(() => (schema === undefined ? [] : rootFields(schema)), [schema])
  const text = query ?? (schema === undefined ? "" : initialOperation(schema))

  const run = useMutation({
    mutationFn: (input: GraphqlRequest): Promise<GraphqlResponse> => api.graphql(input),
  })
  const parsedVariables = parseVariables(variables)
  const submit = (): void => {
    if (parsedVariables === null) return
    run.mutate({
      query: text,
      ...(parsedVariables === undefined ? {} : { variables: parsedVariables }),
      ...(as === undefined ? {} : { as }),
    })
  }

  if (introspection.error instanceof CanopyError && introspection.error.code === ErrorCode.NotFound)
    return <EmptyState title={t("api.graphql.title")}>{t("api.graphql.off")}</EmptyState>

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor={roleId}>{t("api.graphql.runAs")}</Label>
          <NativeSelect
            id={roleId}
            value={role}
            onChange={(event) => setRole(event.target.value as RunAs)}
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {t(`api.graphql.roles.${option}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {role === "authenticated" ? (
          <div className="grid gap-1">
            <Label htmlFor={userId}>{t("api.graphql.user")}</Label>
            <Input
              id={userId}
              value={user}
              placeholder={t("api.graphql.userPlaceholder")}
              onChange={(event) => setUser(event.target.value)}
            />
          </div>
        ) : null}
        <Button onClick={submit} disabled={run.isPending || parsedVariables === null}>
          <PlayIcon aria-hidden="true" />
          {run.isPending ? t("api.graphql.running") : t("api.graphql.run")}
        </Button>
      </div>
      {role !== "service" ? (
        <p className="text-sm text-muted-foreground">{t("api.graphql.readOnly")}</p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Label>{t("api.graphql.query")}</Label>
          <CodeEditor
            language="graphql"
            label={t("api.graphql.query")}
            value={text}
            onChange={setQuery}
            onSubmit={submit}
            minHeight="16rem"
            {...(schema === undefined ? {} : { schema })}
          />
          <p className="text-xs text-muted-foreground">{t("api.graphql.runHint")}</p>
          <Label>{t("api.graphql.variables")}</Label>
          <CodeEditor
            language="ejson"
            label={t("api.graphql.variables")}
            value={variables}
            onChange={setVariables}
            onSubmit={submit}
            minHeight="4rem"
          />
          {parsedVariables === null ? (
            <p role="alert" className="text-sm text-destructive">
              {t("api.graphql.variablesInvalid")}
            </p>
          ) : null}
        </div>
        <section aria-label={t("api.graphql.result")} className="grid content-start gap-2">
          <h2 className="text-sm font-medium">{t("api.graphql.result")}</h2>
          {run.isError ? (
            <ErrorState error={run.error} feature={t("api.graphql.feature")} />
          ) : run.data === undefined ? (
            <p className="text-sm text-muted-foreground">{t("api.graphql.empty")}</p>
          ) : (
            <pre
              data-testid="graphql-result"
              className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs"
            >
              {JSON.stringify(run.data, null, 2)}
            </pre>
          )}
        </section>
        <aside className="grid content-start gap-2">
          <h2 className="text-sm font-medium">{t("api.graphql.docs")}</h2>
          {introspection.isPending ? (
            <LoadingState rows={3} label={t("api.graphql.loadingSchema")} />
          ) : introspection.isError ? (
            <ErrorState
              error={introspection.error}
              feature={t("api.graphql.feature")}
              onRetry={() => void introspection.refetch()}
            />
          ) : (
            <SchemaDocs
              fields={fields}
              onPick={(field) => {
                if (schema !== undefined) setQuery(starterOperation(schema, field.kind, field.name))
              }}
            />
          )}
        </aside>
      </div>
    </div>
  )
}
