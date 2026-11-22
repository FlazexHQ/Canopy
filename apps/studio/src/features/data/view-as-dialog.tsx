import { EyeIcon, LockIcon, UnlockIcon } from "lucide-react"
import { useId, useState } from "react"
import type { ViewAs } from "../../api/contract.ts"
import { useSession } from "../../app/context.tsx"
import { describeViewAs, useViewAs } from "../../app/view-as.tsx"
import { CodeEditor } from "../../components/code-editor.tsx"
import { ConfirmDialog } from "../../components/confirm-dialog.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { t } from "../../i18n/index.ts"
import { parseEjsonObject } from "../../lib/ejson.ts"

/** The identity kinds the picker offers. */
export type ViewAsMode = "anon" | "user" | "claims"

function splitRoles(text: string): string[] {
  return text
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "")
}

/**
 * Builds the identity to view as. An anonymous visitor has the `anon` role and no claims, a user the
 * `authenticated` role plus extra roles and a `sub`, and custom claims take the roles as given.
 */
export function buildViewAs(input: {
  readonly mode: ViewAsMode
  readonly subject: string
  readonly email: string
  readonly roles: string
  readonly claims: string
}):
  { readonly ok: true; readonly value: ViewAs } | { readonly ok: false; readonly message: string } {
  switch (input.mode) {
    case "anon":
      return { ok: true, value: { roles: ["anon"], claims: {}, label: t("data.viewAs.anon") } }
    case "user": {
      const subject = input.subject.trim()
      if (subject === "") return { ok: false, message: t("data.viewAs.subjectRequired") }
      const email = input.email.trim()
      return {
        ok: true,
        value: {
          roles: ["authenticated", ...splitRoles(input.roles).filter((r) => r !== "authenticated")],
          claims: { sub: subject, ...(email === "" ? {} : { email }) },
          label: email === "" ? subject : email,
        },
      }
    }
    case "claims": {
      const parsed = parseEjsonObject(input.claims)
      if (!parsed.ok)
        return { ok: false, message: t("data.viewAs.claimsInvalid", { message: parsed.message }) }
      const roles = splitRoles(input.roles)
      return {
        ok: true,
        value: { roles: roles.length === 0 ? ["authenticated"] : roles, claims: parsed.value },
      }
    }
  }
}

/** Picks an anonymous visitor, a user or arbitrary claims and renders the page through their policies. */
export function ViewAsButton() {
  const { permissions } = useSession()
  const { start } = useViewAs()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ViewAsMode>("user")
  const [subject, setSubject] = useState("")
  const [email, setEmail] = useState("")
  const [roles, setRoles] = useState("")
  const [claims, setClaims] = useState('{\n  "sub": "u_alice"\n}')
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const ids = { subject: useId(), email: useId(), roles: useId(), mode: useId() }
  if (!permissions.impersonate) return null
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <EyeIcon aria-hidden="true" />
        {t("data.viewAs.button")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setProblem(undefined)
          setOpen(next)
        }}
        title={t("data.viewAs.title")}
        description={t("data.viewAs.description")}
        confirmLabel={t("data.viewAs.start")}
        onConfirm={() => {
          const result = buildViewAs({ mode, subject, email, roles, claims })
          if (!result.ok) {
            setProblem(result.message)
            return
          }
          start(result.value)
          setOpen(false)
        }}
      >
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t("data.viewAs.mode")}</legend>
          {(["anon", "user", "claims"] as const).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={ids.mode}
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
              />
              {t(`data.viewAs.${option}`)}
            </label>
          ))}
        </fieldset>
        {mode === "user" ? (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor={ids.subject}>{t("data.viewAs.subject")}</Label>
              <Input
                id={ids.subject}
                value={subject}
                autoComplete="off"
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.email}>
                {t("data.viewAs.email")}
                <span className="font-normal text-muted-foreground">({t("common.optional")})</span>
              </Label>
              <Input
                id={ids.email}
                type="email"
                value={email}
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>
        ) : null}
        {mode === "claims" ? (
          <CodeEditor
            value={claims}
            onChange={setClaims}
            label={t("data.viewAs.claimsLabel")}
            minHeight="6rem"
          />
        ) : null}
        {mode === "anon" ? null : (
          <div className="grid gap-2">
            <Label htmlFor={ids.roles}>
              {mode === "user" ? t("data.viewAs.roles") : t("data.viewAs.customRoles")}
            </Label>
            <Input
              id={ids.roles}
              value={roles}
              autoComplete="off"
              aria-describedby={`${ids.roles}-hint`}
              onChange={(event) => setRoles(event.target.value)}
            />
            <p id={`${ids.roles}-hint`} className="text-xs text-muted-foreground">
              {mode === "user" ? t("data.viewAs.rolesHint") : t("data.viewAs.customRolesHint")}
            </p>
          </div>
        )}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </ConfirmDialog>
    </>
  )
}

/** Unlocks writes as the impersonated identity after asking for a reason, or locks them again. */
export function WriteUnlock() {
  const { permissions } = useSession()
  const { viewAs, writeReason, unlockWrites, lockWrites } = useViewAs()
  const [open, setOpen] = useState(false)
  if (viewAs === undefined || !permissions.writeAs) return null
  if (writeReason !== undefined) {
    return (
      <Button variant="outline" size="sm" onClick={lockWrites}>
        <LockIcon aria-hidden="true" />
        {t("data.viewAs.lockWrites")}
      </Button>
    )
  }
  const who = describeViewAs(viewAs)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UnlockIcon aria-hidden="true" />
        {t("data.viewAs.allowWrites")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("data.viewAs.allowWritesTitle", { who })}
        description={t("data.viewAs.allowWritesDescription", { who })}
        confirmLabel={t("data.viewAs.allowWritesConfirm")}
        reason={{ label: t("common.reason"), required: true }}
        onConfirm={({ reason }) => {
          unlockWrites(reason)
          setOpen(false)
        }}
      />
    </>
  )
}
