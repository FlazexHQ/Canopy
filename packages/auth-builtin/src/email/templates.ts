/** The emails built in auth sends. */
export type EmailKind =
  "verification" | "magic_link" | "otp" | "reset_password" | "invite" | "email_change"

/** What a template can use. Values are plain text; templates escape them for HTML. */
export interface EmailTemplateData {
  readonly appName: string
  readonly email: string
  /** The link to follow, for every kind except `otp`. */
  readonly url?: string
  /** The one time code, for `otp`. */
  readonly otp?: string
  /** For `email_change`: the address the user is moving to. */
  readonly newEmail?: string
}

/** A rendered email. */
export interface RenderedEmail {
  readonly subject: string
  readonly text: string
  readonly html?: string
}

/** Renders one kind of email. */
export type EmailTemplate = (data: EmailTemplateData) => RenderedEmail

/** One template per kind. */
export type EmailTemplates = Readonly<Record<EmailKind, EmailTemplate>>

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function linkEmail(subject: string, intro: string, action: string, outro: string): EmailTemplate {
  return (data) => {
    const url = data.url ?? ""
    return {
      subject: subject.replaceAll("{app}", data.appName),
      text: `${intro.replaceAll("{app}", data.appName)}\n\n${url}\n\n${outro}\n`,
      html: `<p>${escapeHtml(intro.replaceAll("{app}", data.appName))}</p><p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p><p>${escapeHtml(outro)}</p>`,
    }
  }
}

const IGNORE = "If you did not ask for this, you can ignore this email."

/** The default templates, plain and short so they render in any client. */
export const defaultTemplates: EmailTemplates = {
  verification: linkEmail(
    "Confirm your email for {app}",
    "Follow this link to confirm your email address for {app}:",
    "Confirm email",
    IGNORE,
  ),
  magic_link: linkEmail(
    "Your sign in link for {app}",
    "Follow this link to sign in to {app}:",
    "Sign in",
    IGNORE,
  ),
  reset_password: linkEmail(
    "Reset your password for {app}",
    "Follow this link to choose a new password for {app}:",
    "Reset password",
    IGNORE,
  ),
  invite: linkEmail(
    "You are invited to {app}",
    "You have been invited to {app}. Follow this link to accept and sign in:",
    "Accept invite",
    "If you were not expecting this invite, you can ignore this email.",
  ),
  email_change: (data) => {
    const target = data.newEmail ?? "a new address"
    const intro = `Follow this link to confirm changing your ${data.appName} email to ${target}:`
    const url = data.url ?? ""
    return {
      subject: `Confirm your email change for ${data.appName}`,
      text: `${intro}\n\n${url}\n\n${IGNORE}\n`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">Confirm change</a></p><p>${escapeHtml(IGNORE)}</p>`,
    }
  },
  otp: (data) => {
    const code = data.otp ?? ""
    return {
      subject: `Your ${data.appName} code is ${code}`,
      text: `Your one time code for ${data.appName} is ${code}. It expires in a few minutes.\n\n${IGNORE}\n`,
      html: `<p>Your one time code for ${escapeHtml(data.appName)} is</p><p><strong>${escapeHtml(code)}</strong></p><p>${escapeHtml(IGNORE)}</p>`,
    }
  },
}
