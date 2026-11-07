import { CanopyError } from "@canopy/protocol"
import type { TotpEnrollment } from "../../api/contract.ts"
import { CopyButton } from "../../components/copy-button.tsx"
import { t } from "../../i18n/index.ts"

/** The authenticator enrollment a 401 carries when the account has none confirmed yet. */
export function enrollmentOf(error: unknown): TotpEnrollment | undefined {
  if (!(error instanceof CanopyError)) return undefined
  const value = error.details?.["totpEnrollment"]
  if (typeof value !== "object" || value === null) return undefined
  const { secret, uri } = value as Record<string, unknown>
  return typeof secret === "string" && typeof uri === "string" ? { secret, uri } : undefined
}

/** Whether a login failed only because the authenticator code is missing or wrong. */
export function totpRequired(error: unknown): boolean {
  return error instanceof CanopyError && error.details?.["totpRequired"] === true
}

/** Shows the secret and `otpauth:` link to add the account to an authenticator app. */
export function TotpEnrollmentPanel({ enrollment }: { readonly enrollment: TotpEnrollment }) {
  return (
    <section
      aria-labelledby="totp-enrollment-title"
      className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <h2 id="totp-enrollment-title" className="font-medium">
        {t("session.enroll.title")}
      </h2>
      <p className="text-muted-foreground">{t("session.enroll.body")}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
          {enrollment.secret}
        </code>
        <CopyButton value={enrollment.secret} what={t("session.enroll.secret")} />
      </div>
      <a
        href={enrollment.uri}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {t("session.enroll.open")}
      </a>
    </section>
  )
}
