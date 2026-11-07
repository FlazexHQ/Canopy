import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlertCircleIcon } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { keys, useApi, useSession } from "../../app/context.tsx"
import { errorMessage } from "../../components/toast.tsx"
import { Alert, AlertDescription } from "../../components/ui/alert.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardHeader } from "../../components/ui/card.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { t } from "../../i18n/index.ts"

/** The shortest admin password the server accepts. */
const MIN_PASSWORD_LENGTH = 12

function ChangePassword() {
  const api = useApi()
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const errorId = useId()
  const hintId = useId()
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.me }),
    onError: (error) => setProblem(errorMessage(error)),
  })
  return (
    <main id="main" className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="font-semibold leading-none">{t("session.changePassword.title")}</h1>
          <CardDescription>{t("session.changePassword.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            noValidate
            aria-describedby={problem === undefined ? undefined : errorId}
            onSubmit={(event) => {
              event.preventDefault()
              if (next.length < MIN_PASSWORD_LENGTH) {
                setProblem(t("session.changePassword.tooShort", { min: MIN_PASSWORD_LENGTH }))
                return
              }
              if (next !== confirm) {
                setProblem(t("session.changePassword.mismatch"))
                return
              }
              setProblem(undefined)
              change.mutate()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="password-current">{t("session.changePassword.current")}</Label>
              <Input
                id="password-current"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password-next">{t("session.changePassword.next")}</Label>
              <Input
                id="password-next"
                type="password"
                autoComplete="new-password"
                required
                aria-describedby={hintId}
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
              <p id={hintId} className="text-xs text-muted-foreground">
                {t("session.changePassword.hint", { min: MIN_PASSWORD_LENGTH })}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password-confirm">{t("session.changePassword.confirm")}</Label>
              <Input
                id="password-confirm"
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
            <Button type="submit" disabled={change.isPending}>
              {change.isPending
                ? t("session.changePassword.submitting")
                : t("session.changePassword.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

/**
 * Shows the password change form instead of Studio while the account still has its temporary password,
 * because the server refuses every other request until then.
 */
export function PasswordGate({ children }: { readonly children: ReactNode }) {
  const session = useSession()
  return session.admin.mustChangePassword === true ? <ChangePassword /> : children
}
