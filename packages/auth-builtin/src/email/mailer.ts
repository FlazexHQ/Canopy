import type { AuthLogger } from "../logger.ts"
import {
  defaultTemplates,
  type EmailKind,
  type EmailTemplate,
  type EmailTemplateData,
  type EmailTemplates,
} from "./templates.ts"
import type { EmailTransport } from "./transport.ts"

/** How email is sent. */
export interface EmailOptions {
  /** The sender, for example `Acme <no-reply@acme.example>`. */
  readonly from: string
  readonly transport: EmailTransport
  /** Replaces some or all default templates. */
  readonly templates?: Partial<Record<EmailKind, EmailTemplate>>
  /** At most this many emails of one kind to one recipient per window. @default 5 */
  readonly perRecipientLimit?: number
  /** @default 900 (15 minutes) */
  readonly perRecipientWindowSeconds?: number
}

/**
 * Renders and sends auth emails. Sending never fails the request that triggered it: errors are logged,
 * and emails over the per template and per recipient limit are dropped, so responses stay uniform.
 */
export class Mailer {
  private readonly options: EmailOptions | undefined
  private readonly templates: EmailTemplates
  private readonly appName: string
  private readonly logger: AuthLogger
  private readonly sent = new Map<string, number[]>()

  constructor(options: EmailOptions | undefined, appName: string, logger: AuthLogger) {
    this.options = options
    this.appName = appName
    this.logger = logger
    this.templates = { ...defaultTemplates, ...options?.templates }
  }

  /** Whether a transport is configured. Without one, flows that need email are turned off. */
  get enabled(): boolean {
    return this.options !== undefined
  }

  /** Renders an email without sending it, for previews. */
  render(kind: EmailKind, data: Omit<EmailTemplateData, "appName">) {
    return this.templates[kind]({ appName: this.appName, ...data })
  }

  /** Sends one email. Resolves once it was handed to the transport, dropped, or failed (logged). */
  async send(kind: EmailKind, data: Omit<EmailTemplateData, "appName">): Promise<void> {
    const options = this.options
    if (options === undefined) {
      this.logger.warn({ kind }, "no email transport is configured; the auth email was not sent")
      return
    }
    if (!this.allow(kind, data.email, options)) {
      this.logger.warn({ kind }, "auth email dropped: too many to this recipient")
      return
    }
    const rendered = this.render(kind, data)
    try {
      await options.transport.send({
        from: options.from,
        to: data.email,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.html === undefined ? {} : { html: rendered.html }),
      })
    } catch (error: unknown) {
      this.logger.error(
        { err: error, kind, transport: options.transport.name },
        "auth email failed",
      )
    }
  }

  private allow(kind: EmailKind, to: string, options: EmailOptions): boolean {
    const limit = options.perRecipientLimit ?? 5
    const windowMs = (options.perRecipientWindowSeconds ?? 900) * 1000
    const now = Date.now()
    const key = `${kind}|${to.trim().toLowerCase()}`
    const recent = (this.sent.get(key) ?? []).filter((at) => now - at < windowMs)
    if (recent.length >= limit) {
      this.sent.set(key, recent)
      return false
    }
    recent.push(now)
    this.sent.set(key, recent)
    if (this.sent.size > 10_000) {
      for (const [entry, times] of this.sent)
        if (times.every((at) => now - at >= windowMs)) this.sent.delete(entry)
    }
    return true
  }
}
