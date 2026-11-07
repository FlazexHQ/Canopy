import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Navigate, useRouter } from "@tanstack/react-router"
import { AlertCircleIcon, CheckIcon, RefreshCwIcon } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import type { ApiKey, CollectionSummary, TotpEnrollment } from "../../api/contract.ts"
import { keys, useApi } from "../../app/context.tsx"
import { CodeBlock, CopyButton } from "../../components/copy-button.tsx"
import { ErrorState, LoadingState } from "../../components/states.tsx"
import { Alert, AlertDescription } from "../../components/ui/alert.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent } from "../../components/ui/card.tsx"
import { Checkbox } from "../../components/ui/checkbox.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx"
import { t } from "../../i18n/index.ts"
import { cn } from "../../lib/utils.ts"
import { CheckGroups, countChecks } from "../doctor/checks.tsx"
import { TEMPLATE_IDS, type TemplateId, templateDraft } from "../policies/model.ts"
import { TotpEnrollmentPanel } from "../session/totp-enrollment.tsx"

/** The shortest owner password the wizard accepts, matching the server rule. */
const PASSWORD_MIN = 12

const STEPS = ["claim", "doctor", "collections", "connect"] as const
type Step = (typeof STEPS)[number]

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The SDK snippet shown at the end of setup. */
export function sdkSnippet(
  url: string,
  publishableKey: string,
  collection: string | undefined,
): string {
  const lines = [
    'import { createClient } from "@canopy/client"',
    "",
    "const canopy = createClient({",
    `  url: ${JSON.stringify(url)},`,
    `  publishableKey: ${JSON.stringify(publishableKey)},`,
    "})",
  ]
  if (collection !== undefined) {
    lines.push(
      "",
      `const query = canopy.from(${JSON.stringify(collection)}).find({}).limit(20)`,
      "query.subscribe((state) => console.log(state.status, state.data))",
    )
  }
  return `${lines.join("\n")}\n`
}

function StepHeading({ step, children }: { readonly step: Step; readonly children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <h2
      ref={ref}
      tabIndex={-1}
      id={`setup-step-${step}`}
      className="text-lg font-semibold outline-none"
    >
      {children}
    </h2>
  )
}

function ClaimStep({ onDone }: { readonly onDone: () => void }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const errorId = useId()
  const tokenHintId = useId()
  const passwordHintId = useId()
  const [enrollment, setEnrollment] = useState<TotpEnrollment | undefined>(undefined)
  const [code, setCode] = useState("")
  const claim = useMutation({
    mutationFn: () => api.setup({ token: token.trim(), email: email.trim(), password }),
    onSuccess: (result) => {
      setProblem(undefined)
      setEnrollment(result.totp)
    },
    onError: (error) => setProblem(errorText(error)),
  })
  const signIn = useMutation({
    mutationFn: () => api.login({ email: email.trim(), password, totp: code.trim() }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: keys.me })
      onDone()
      queryClient.setQueryData(keys.setup, { required: false })
    },
    onError: (error) => setProblem(errorText(error)),
  })
  if (enrollment !== undefined) {
    return (
      <form
        className="grid gap-4"
        aria-describedby={problem === undefined ? undefined : errorId}
        onSubmit={(event) => {
          event.preventDefault()
          signIn.mutate()
        }}
      >
        <StepHeading step="claim">{t("setup.steps.claim")}</StepHeading>
        <p className="text-sm text-muted-foreground">{t("setup.claim.claimed")}</p>
        <TotpEnrollmentPanel enrollment={enrollment} />
        <div className="grid gap-2">
          <Label htmlFor="setup-totp">{t("setup.claim.code")}</Label>
          <Input
            id="setup-totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={8}
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        {problem === undefined ? null : (
          <Alert variant="destructive" id={errorId}>
            <AlertCircleIcon aria-hidden="true" />
            <AlertDescription className="text-destructive">{problem}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={signIn.isPending || code.trim() === ""}>
          {signIn.isPending ? t("setup.claim.signingIn") : t("setup.claim.signIn")}
        </Button>
      </form>
    )
  }
  return (
    <form
      className="grid gap-4"
      noValidate
      aria-describedby={problem === undefined ? undefined : errorId}
      onSubmit={(event) => {
        event.preventDefault()
        if (password.length < PASSWORD_MIN) {
          setProblem(t("setup.claim.tooShort", { min: PASSWORD_MIN }))
          return
        }
        if (password !== confirm) {
          setProblem(t("setup.claim.mismatch"))
          return
        }
        setProblem(undefined)
        claim.mutate()
      }}
    >
      <StepHeading step="claim">{t("setup.steps.claim")}</StepHeading>
      <p className="text-sm text-muted-foreground">{t("setup.claim.description")}</p>
      <div className="grid gap-2">
        <Label htmlFor="setup-token">{t("setup.claim.token")}</Label>
        <Input
          id="setup-token"
          autoComplete="off"
          spellCheck={false}
          required
          aria-describedby={tokenHintId}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <p id={tokenHintId} className="text-xs text-muted-foreground">
          {t("setup.claim.tokenHint")}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="setup-email">{t("setup.claim.email")}</Label>
        <Input
          id="setup-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="setup-password">{t("setup.claim.password")}</Label>
        <Input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          aria-describedby={passwordHintId}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p id={passwordHintId} className="text-xs text-muted-foreground">
          {t("setup.claim.passwordHint", { min: PASSWORD_MIN })}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="setup-confirm">{t("setup.claim.confirm")}</Label>
        <Input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      {problem === undefined ? null : (
        <Alert variant="destructive" id={errorId}>
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription className="text-destructive">{problem}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={claim.isPending}>
        {claim.isPending ? t("setup.claim.submitting") : t("setup.claim.submit")}
      </Button>
    </form>
  )
}

function DoctorStep({ onDone }: { readonly onDone: () => void }) {
  const api = useApi()
  const report = useQuery({ queryKey: keys.doctor, queryFn: ({ signal }) => api.doctor(signal) })
  const errors = report.data === undefined ? 0 : countChecks(report.data.checks).error
  return (
    <div className="grid gap-4">
      <StepHeading step="doctor">{t("setup.steps.doctor")}</StepHeading>
      <p className="text-sm text-muted-foreground">{t("setup.doctor.description")}</p>
      {report.isPending ? (
        <LoadingState rows={5} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <CheckGroups checks={report.data.checks} headingLevel={3} />
      )}
      {errors > 0 ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{t("setup.doctor.blocked")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void report.refetch()}
          disabled={report.isFetching}
        >
          <RefreshCwIcon aria-hidden="true" />
          {t("setup.doctor.rerun")}
        </Button>
        {errors > 0 ? (
          <Button variant="secondary" onClick={onDone}>
            {t("setup.doctor.continueAnyway")}
          </Button>
        ) : (
          <Button onClick={onDone} disabled={report.data === undefined}>
            {t("common.next")}
          </Button>
        )}
      </div>
    </div>
  )
}

interface Choice {
  readonly expose: boolean
  readonly template: TemplateId
}

function CollectionRow({
  collection,
  choice,
  onChange,
}: {
  readonly collection: CollectionSummary
  readonly choice: Choice
  readonly onChange: (choice: Choice) => void
}) {
  const checkboxId = useId()
  const selectId = useId()
  const descriptionId = useId()
  return (
    <li className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_16rem] sm:items-start">
      <div className="flex items-start gap-3">
        <Checkbox
          id={checkboxId}
          checked={choice.expose}
          onCheckedChange={(checked) => onChange({ ...choice, expose: checked === true })}
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor={checkboxId}>
            {t("setup.collections.expose", { name: collection.name })}
          </Label>
          {collection.estimatedCount === undefined ? null : (
            <span className="text-xs text-muted-foreground">
              {t("setup.collections.documents", { count: collection.estimatedCount })}
            </span>
          )}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={selectId} className="sr-only">
          {t("setup.collections.template", { name: collection.name })}
        </Label>
        <Select
          value={choice.template}
          disabled={!choice.expose}
          onValueChange={(value) => onChange({ ...choice, template: value as TemplateId })}
        >
          <SelectTrigger
            id={selectId}
            aria-label={t("setup.collections.template", { name: collection.name })}
            aria-describedby={descriptionId}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEMPLATE_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {t(`setup.templates.${id}.label`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {t(`setup.templates.${choice.template}.description`)}
        </p>
      </div>
    </li>
  )
}

function CollectionsStep({ onDone }: { readonly onDone: (exposed: readonly string[]) => void }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const collections = useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) => api.collections(signal),
  })
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({})
  const choiceOf = (name: string): Choice =>
    choices[name] ?? { expose: false, template: "owner-only" }
  const publish = useMutation({
    mutationFn: async () => {
      const chosen = (collections.data ?? []).filter(
        (collection) => choiceOf(collection.name).expose,
      )
      for (const collection of chosen) {
        await api.publish(collection.name, {
          draft: templateDraft(collection.name, choiceOf(collection.name).template),
          expectedVersion: collection.policyVersion ?? 0,
          comment: t("setup.collections.comment"),
        })
      }
      return chosen.map((collection) => collection.name)
    },
    onSuccess: async (names) => {
      await queryClient.invalidateQueries({ queryKey: keys.collections })
      onDone(names)
    },
  })
  const selected = (collections.data ?? []).filter((collection) => choiceOf(collection.name).expose)
  return (
    <div className="grid gap-4">
      <StepHeading step="collections">{t("setup.steps.collections")}</StepHeading>
      <p className="text-sm text-muted-foreground">{t("setup.collections.description")}</p>
      {collections.isPending ? (
        <LoadingState rows={4} />
      ) : collections.isError ? (
        <ErrorState error={collections.error} onRetry={() => void collections.refetch()} />
      ) : collections.data.length === 0 ? (
        <p className="text-sm">{t("setup.collections.none")}</p>
      ) : (
        <ul className="grid gap-2">
          {collections.data.map((collection) => (
            <CollectionRow
              key={collection.name}
              collection={collection}
              choice={choiceOf(collection.name)}
              onChange={(choice) => setChoices((all) => ({ ...all, [collection.name]: choice }))}
            />
          ))}
        </ul>
      )}
      {publish.isError ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription className="text-destructive">
            {errorText(publish.error)}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => publish.mutate()}
          disabled={selected.length === 0 || publish.isPending}
        >
          {publish.isPending ? t("setup.collections.publishing") : t("setup.collections.publish")}
        </Button>
        <Button variant="outline" onClick={() => onDone([])} disabled={publish.isPending}>
          {t("setup.collections.skip")}
        </Button>
      </div>
    </div>
  )
}

function usablePublishable(list: readonly ApiKey[]): ApiKey | undefined {
  return list.find(
    (key) =>
      key.kind === "publishable" &&
      (key.revokedAt === undefined || key.revokedAt === null) &&
      typeof key.key === "string",
  )
}

function ConnectStep({ exposed }: { readonly exposed: readonly string[] }) {
  const api = useApi()
  const router = useRouter()
  const queryClient = useQueryClient()
  const key = useQuery({
    queryKey: [...keys.apiKeys, "setup"],
    queryFn: async ({ signal }) => {
      const existing = usablePublishable(await api.apiKeys(signal))
      if (existing?.key !== undefined && existing.key !== null) return existing.key
      const created = await api.createApiKey({
        name: "Default publishable key",
        kind: "publishable",
      })
      return created.key
    },
    staleTime: Number.POSITIVE_INFINITY,
  })
  const origin = typeof window === "undefined" ? "http://localhost:8080" : window.location.origin
  return (
    <div className="grid gap-4">
      <StepHeading step="connect">{t("setup.steps.connect")}</StepHeading>
      <p className="text-sm text-muted-foreground">{t("setup.connect.description")}</p>
      {key.isPending ? (
        <LoadingState rows={2} label={t("setup.connect.creating")} />
      ) : key.isError ? (
        <ErrorState error={key.error} onRetry={() => void key.refetch()} />
      ) : (
        <>
          <div className="grid gap-2">
            <Label htmlFor="setup-key">{t("setup.connect.key")}</Label>
            <div className="flex gap-2">
              <Input id="setup-key" readOnly value={key.data} className="font-mono" />
              <CopyButton value={key.data} what={t("setup.connect.keyLabel")} />
            </div>
          </div>
          <div className="grid gap-2">
            <p className="text-sm">{t("setup.connect.snippet")}</p>
            <CodeBlock
              code={sdkSnippet(origin, key.data, exposed[0])}
              what={t("setup.connect.snippetLabel")}
            />
          </div>
        </>
      )}
      <div>
        <Button
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: keys.apiKeys })
            void router.navigate({ to: "/" })
          }}
        >
          {t("setup.connect.open")}
        </Button>
      </div>
    </div>
  )
}

/**
 * The first run wizard: claim the server with the one time setup token, run the doctor checks, expose
 * collections with starter policies, then show the publishable key and an SDK snippet.
 */
export function SetupWizard() {
  const api = useApi()
  const [step, setStep] = useState<Step>("claim")
  const [exposed, setExposed] = useState<readonly string[]>([])
  const status = useQuery({
    queryKey: keys.setup,
    queryFn: ({ signal }) => api.setupStatus(signal),
    retry: false,
  })
  if (step === "claim" && status.data?.required === false) return <Navigate to="/login" />
  const index = STEPS.indexOf(step)
  return (
    <main id="main" className="mx-auto grid w-full max-w-2xl gap-6 p-4 py-10">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("setup.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("setup.stepOf", { current: index + 1, total: STEPS.length })}
        </p>
      </header>
      <nav aria-label={t("setup.stepsLabel")}>
        <ol className="grid gap-2 sm:grid-cols-4">
          {STEPS.map((name, position) => (
            <li
              key={name}
              aria-current={name === step ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                name === step && "border-primary font-medium",
                position < index && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
                  position < index && "border-primary bg-primary text-primary-foreground",
                )}
                aria-hidden="true"
              >
                {position < index ? <CheckIcon className="size-3" /> : position + 1}
              </span>
              {t(`setup.steps.${name}`)}
            </li>
          ))}
        </ol>
      </nav>
      <Card>
        <CardContent>
          {status.isPending && step === "claim" ? (
            <LoadingState rows={4} />
          ) : step === "claim" ? (
            <ClaimStep onDone={() => setStep("doctor")} />
          ) : step === "doctor" ? (
            <DoctorStep onDone={() => setStep("collections")} />
          ) : step === "collections" ? (
            <CollectionsStep
              onDone={(names) => {
                setExposed(names)
                setStep("connect")
              }}
            />
          ) : (
            <ConnectStep exposed={exposed} />
          )}
        </CardContent>
      </Card>
    </main>
  )
}
