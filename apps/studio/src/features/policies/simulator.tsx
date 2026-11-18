import { useMutation } from "@tanstack/react-query"
import { FlaskConicalIcon, PlayIcon } from "lucide-react"
import { useId, useState } from "react"
import type { PolicyDraft } from "../../api/client.ts"
import {
  SIMULATED_OPERATIONS,
  type SimulatedOperation,
  type Simulation,
  type ViewAs,
} from "../../api/contract.ts"
import { useApi } from "../../app/context.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { CodeBlock } from "../../components/copy-button.tsx"
import { ErrorState } from "../../components/states.tsx"
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
import { NativeSelect } from "../../components/ui/native-select.tsx"
import { t } from "../../i18n/index.ts"
import { formatEjson, parseEjsonObject } from "../../lib/ejson.ts"
import { testSnippet } from "./model.ts"
import { splitList } from "./policy-form.tsx"

type Mode = "user" | "anon" | "claims"

interface SimulatorInput {
  readonly mode: Mode
  readonly sub: string
  readonly email: string
  readonly orgIds: string
  readonly extraRoles: string
  readonly claims: string
  readonly op: SimulatedOperation
  readonly filter: string
  readonly document: string
  readonly update: string
}

/** Builds who the simulation runs as, or an error message for invalid claims. */
function simulatedIdentity(input: SimulatorInput): ViewAs | string {
  const extra = splitList(input.extraRoles).filter((role) => role !== "authenticated")
  if (input.mode === "anon") return { roles: ["anon"], claims: {}, label: "anon" }
  if (input.mode === "claims") {
    const parsed = parseEjsonObject(input.claims)
    if (!parsed.ok) return t("policies.simulator.claimsInvalid")
    const sub = parsed.value["sub"]
    return {
      roles: ["authenticated", ...extra],
      claims: parsed.value,
      ...(typeof sub === "string" ? { label: sub } : {}),
    }
  }
  const claims: Record<string, unknown> = {}
  if (input.sub.trim() !== "") claims["sub"] = input.sub.trim()
  if (input.email.trim() !== "") claims["email"] = input.email.trim()
  const orgIds = splitList(input.orgIds)
  if (orgIds.length > 0) claims["org_ids"] = orgIds
  return {
    roles: ["authenticated", ...extra],
    claims,
    label: input.email.trim() || input.sub.trim() || "user",
  }
}

function Result({ result }: { readonly result: Simulation }) {
  return (
    <div className="grid gap-3 text-sm" data-testid="simulation-result">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant={result.allowed ? "success" : "destructive"}>
          {result.allowed ? t("policies.simulator.allowed") : t("policies.simulator.denied")}
        </Badge>
        {result.count === undefined ? null : (
          <span data-testid="simulation-count">
            {t("policies.simulator.documents", { count: result.count })}
          </span>
        )}
        {result.bypass === true ? (
          <span className="text-muted-foreground">{t("policies.simulator.bypass")}</span>
        ) : null}
      </p>
      {result.violations === undefined || result.violations.length === 0 ? null : (
        <div>
          <h4 className="font-medium">{t("policies.simulator.violations")}</h4>
          <ul className="list-inside list-disc text-muted-foreground">
            {result.violations.map((violation) => (
              <li key={violation}>{violation}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-1">
        <h4 className="font-medium">{t("policies.simulator.effectiveFilter")}</h4>
        {result.effectiveFilter === null ? (
          <p className="text-muted-foreground">{t("policies.simulator.noFilter")}</p>
        ) : (
          <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
            {formatEjson(result.effectiveFilter)}
          </pre>
        )}
      </div>
      <div className="grid gap-1">
        <h4 className="font-medium">{t("policies.simulator.trace")}</h4>
        <ul className="grid gap-1" data-testid="simulation-trace">
          {result.policies.map((policy) => (
            <li key={policy.name} className="flex flex-wrap items-baseline gap-2">
              <span
                aria-hidden="true"
                className={policy.applies ? "text-success" : "text-muted-foreground"}
              >
                {policy.applies ? "✓" : "○"}
              </span>
              <span className="font-medium">{policy.name}</span>
              <span className="text-xs text-muted-foreground">
                {policy.kind},{" "}
                {policy.applies
                  ? t("policies.simulator.applies")
                  : t("policies.simulator.notApplies")}
                {policy.applies ? "" : `: ${policy.reason}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground">
        {result.hiddenFields === undefined || result.hiddenFields.length === 0
          ? t("policies.simulator.noHiddenFields")
          : t("policies.simulator.hiddenFields", { fields: result.hiddenFields.join(", ") })}
      </p>
      {result.documents === undefined || result.documents.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer font-medium">{t("policies.simulator.sample")}</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
            {formatEjson(result.documents.slice(0, 5))}
          </pre>
        </details>
      )}
    </div>
  )
}

/**
 * The simulator: evaluates the draft (not the published version) against the real data as a chosen
 * identity, read only, and shows the decision, the effective filter and the explain trace.
 */
export function Simulator({
  collection,
  draft,
  fields,
  canRun,
}: {
  readonly collection: string
  readonly draft: PolicyDraft
  readonly fields: readonly string[]
  readonly canRun: boolean
}) {
  const api = useApi()
  const id = useId()
  const [input, setInput] = useState<SimulatorInput>({
    mode: "user",
    sub: "",
    email: "",
    orgIds: "",
    extraRoles: "",
    claims: '{\n  "sub": "u_alice"\n}',
    op: "read",
    filter: "{}",
    document: "{}",
    update: '{ "$set": {} }',
  })
  const [inputError, setInputError] = useState<string | undefined>(undefined)
  const [testOpen, setTestOpen] = useState(false)
  const set = (patch: Partial<SimulatorInput>) => setInput((current) => ({ ...current, ...patch }))
  const simulation = useMutation({
    mutationFn: (request: Parameters<typeof api.simulate>[1]) => api.simulate(collection, request),
  })
  const run = () => {
    const as = simulatedIdentity(input)
    if (typeof as === "string") {
      setInputError(as)
      return
    }
    const parse = (text: string, what: string) => {
      const parsed = parseEjsonObject(text)
      if (!parsed.ok)
        throw new TypeError(t("policies.simulator.invalidInput", { what, message: parsed.message }))
      return parsed.value
    }
    try {
      const request =
        input.op === "read"
          ? {
              draft,
              as,
              op: input.op,
              filter: parse(input.filter, t("policies.simulator.filterLabel")),
            }
          : {
              draft,
              as,
              op: input.op,
              document: parse(input.document, t("policies.simulator.documentLabel")),
              ...(input.op === "update"
                ? { update: parse(input.update, t("policies.simulator.updateLabel")) }
                : {}),
            }
      setInputError(undefined)
      simulation.mutate(request)
    } catch (error: unknown) {
      setInputError(error instanceof Error ? error.message : String(error))
    }
  }
  const lastRequest = simulation.variables
  const result = simulation.data
  const snippet =
    result === undefined || lastRequest === undefined
      ? ""
      : testSnippet({
          collection,
          as: lastRequest.as,
          op: lastRequest.op,
          document:
            lastRequest.op === "read"
              ? (result.documents?.[0] ?? lastRequest.filter ?? {})
              : (lastRequest.document ?? {}),
          ...(lastRequest.update === undefined ? {} : { update: lastRequest.update }),
          allowed:
            lastRequest.op === "read" ? result.allowed && (result.count ?? 0) > 0 : result.allowed,
          ...(result.hiddenFields === undefined ? {} : { hiddenFields: result.hiddenFields }),
        })
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid gap-4 rounded-lg border p-4"
      data-testid="simulator"
    >
      <div>
        <h2 id={`${id}-title`} className="flex items-center gap-2 font-semibold">
          <FlaskConicalIcon className="size-4" aria-hidden="true" />
          {t("policies.simulator.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("policies.simulator.description")}</p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t("policies.simulator.as")}</legend>
        <div className="flex flex-wrap gap-4">
          {(["user", "anon", "claims"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={input.mode === mode}
                className="accent-primary"
                onChange={() => set({ mode })}
              />
              {t(`policies.simulator.${mode}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {input.mode === "user" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-sub`}>{t("policies.simulator.sub")}</Label>
            <Input
              id={`${id}-sub`}
              value={input.sub}
              placeholder="u_alice"
              onChange={(e) => set({ sub: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-email`}>{t("policies.simulator.email")}</Label>
            <Input
              id={`${id}-email`}
              type="email"
              value={input.email}
              placeholder="alice@example.com"
              onChange={(e) => set({ email: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-orgs`}>{t("policies.simulator.orgIds")}</Label>
            <Input
              id={`${id}-orgs`}
              value={input.orgIds}
              placeholder="o1, o2"
              aria-describedby={`${id}-orgs-hint`}
              onChange={(e) => set({ orgIds: e.target.value })}
            />
            <p id={`${id}-orgs-hint`} className="text-xs text-muted-foreground">
              {t("policies.simulator.orgIdsHint")}
            </p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-roles`}>{t("policies.simulator.rolesLabel")}</Label>
            <Input
              id={`${id}-roles`}
              value={input.extraRoles}
              aria-describedby={`${id}-roles-hint`}
              onChange={(e) => set({ extraRoles: e.target.value })}
            />
            <p id={`${id}-roles-hint`} className="text-xs text-muted-foreground">
              {t("policies.simulator.rolesHint")}
            </p>
          </div>
        </div>
      ) : input.mode === "claims" ? (
        <div className="grid gap-3">
          <CodeEditor
            label={t("policies.simulator.claimsLabel")}
            value={input.claims}
            minHeight="4rem"
            onChange={(claims) => set({ claims })}
          />
          <div className="grid gap-1">
            <Label htmlFor={`${id}-claim-roles`}>{t("policies.simulator.rolesLabel")}</Label>
            <Input
              id={`${id}-claim-roles`}
              value={input.extraRoles}
              onChange={(e) => set({ extraRoles: e.target.value })}
            />
          </div>
        </div>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor={`${id}-op`}>{t("policies.simulator.op")}</Label>
        <NativeSelect
          id={`${id}-op`}
          value={input.op}
          onChange={(event) => set({ op: event.target.value as SimulatedOperation })}
        >
          {SIMULATED_OPERATIONS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </NativeSelect>
      </div>
      {input.op === "read" ? (
        <CodeEditor
          label={t("policies.simulator.filterLabel")}
          value={input.filter}
          minHeight="3rem"
          completion={{ fields }}
          onSubmit={run}
          onChange={(filter) => set({ filter })}
        />
      ) : (
        <>
          <CodeEditor
            label={t("policies.simulator.documentLabel")}
            value={input.document}
            minHeight="4rem"
            completion={{ fields }}
            onChange={(document) => set({ document })}
          />
          {input.op === "update" ? (
            <CodeEditor
              label={t("policies.simulator.updateLabel")}
              value={input.update}
              minHeight="3rem"
              completion={{ fields }}
              onChange={(update) => set({ update })}
            />
          ) : null}
        </>
      )}
      {inputError === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {inputError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={run} disabled={!canRun || simulation.isPending}>
          <PlayIcon aria-hidden="true" />
          {simulation.isPending ? t("policies.simulator.running") : t("policies.simulator.run")}
        </Button>
        <Button variant="outline" disabled={result === undefined} onClick={() => setTestOpen(true)}>
          {t("policies.simulator.saveAsTest")}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {simulation.isError ? <ErrorState error={simulation.error} /> : null}
        {result === undefined ? null : <Result result={result} />}
      </div>
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("policies.simulator.testTitle")}</DialogTitle>
            <DialogDescription>
              {t("policies.simulator.testDescription", { name: collection })}
            </DialogDescription>
          </DialogHeader>
          <CodeBlock code={snippet} what={t("policies.simulator.testTitle")} />
        </DialogContent>
      </Dialog>
    </section>
  )
}
