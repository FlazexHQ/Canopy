import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useRouter, useSearch } from "@tanstack/react-router"
import { AlertCircleIcon } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type { TotpEnrollment } from "../../api/contract.ts"
import { keys, useApi } from "../../app/context.tsx"
import { Alert, AlertDescription } from "../../components/ui/alert.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardHeader } from "../../components/ui/card.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { t } from "../../i18n/index.ts"
import { enrollmentOf, TotpEnrollmentPanel, totpRequired } from "./totp-enrollment.tsx"

/** A redirect target is only followed when it stays inside Studio. */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined || !target.startsWith("/") || target.startsWith("//")) return "/"
  if (target.startsWith("/login") || target.startsWith("/setup")) return "/"
  return target
}

export function LoginPage() {
  const api = useApi()
  const router = useRouter()
  const queryClient = useQueryClient()
  const search = useSearch({ strict: false }) as { redirect?: string }
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [totp, setTotp] = useState("")
  const [needsTotp, setNeedsTotp] = useState(false)
  const [enrollment, setEnrollment] = useState<TotpEnrollment | undefined>(undefined)
  const errorId = useId()
  const totpHintId = useId()
  const totpRef = useRef<HTMLInputElement>(null)
  const setup = useQuery({
    queryKey: keys.setup,
    queryFn: ({ signal }) => api.setupStatus(signal),
    retry: false,
  })
  const login = useMutation({
    mutationFn: () =>
      api.login({ email: email.trim(), password, ...(needsTotp ? { totp: totp.trim() } : {}) }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: keys.me })
      await router.navigate({ href: safeRedirect(search.redirect) })
    },
    onError: (error) => {
      if (totpRequired(error)) setNeedsTotp(true)
      const next = enrollmentOf(error)
      if (next !== undefined) setEnrollment(next)
    },
  })
  useEffect(() => {
    if (needsTotp) totpRef.current?.focus()
  }, [needsTotp])

  const error = login.error
  const showError = error !== null
  return (
    <main id="main" className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm gap-6 py-7 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)]">
        <CardHeader className="gap-1.5 px-7">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="mb-3 size-9" />
          <h1 className="text-xl font-semibold tracking-tight">{t("session.title")}</h1>
          <CardDescription>{t("session.description")}</CardDescription>
        </CardHeader>
        <CardContent className="px-7">
          <form
            className="grid gap-4"
            aria-describedby={showError ? errorId : undefined}
            onSubmit={(event) => {
              event.preventDefault()
              login.mutate()
            }}
          >
            {setup.data?.required === true ? (
              <Alert role="status">
                <AlertDescription>
                  <p>{t("session.setupRequired")}</p>
                  <Link
                    to="/setup"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("session.setupLink")}
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="login-email">{t("session.email")}</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="login-password">{t("session.password")}</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {enrollment === undefined ? null : <TotpEnrollmentPanel enrollment={enrollment} />}
            {needsTotp ? (
              <div className="grid gap-2">
                <Label htmlFor="login-totp">{t("session.totp")}</Label>
                <Input
                  ref={totpRef}
                  id="login-totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={8}
                  required
                  aria-describedby={totpHintId}
                  value={totp}
                  onChange={(event) => setTotp(event.target.value)}
                />
                <p id={totpHintId} className="text-xs text-muted-foreground">
                  {t("session.totpHint")}
                </p>
              </div>
            ) : null}
            {showError ? (
              <Alert variant="destructive" id={errorId}>
                <AlertCircleIcon aria-hidden="true" />
                <AlertDescription className="text-destructive">
                  {error instanceof Error ? error.message : String(error)}
                </AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? t("session.submitting") : t("session.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
