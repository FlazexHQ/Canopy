import {
  type EmailKind,
  type EmailTemplate,
  type EmailTemplateData,
  escapeHtml,
} from "@canopy/auth-builtin"
import { ConflictError, NotFoundError, ValidationError } from "@canopy/protocol"
import type { Collection, Db } from "mongodb"
import type { Actor, AuditLog, RequestOrigin } from "../audit.ts"

/** The emails built in auth sends, in the order Studio lists them. */
export const EMAIL_KINDS: readonly EmailKind[] = [
  "verification",
  "magic_link",
  "otp",
  "reset_password",
  "invite",
  "email_change",
]

/** The placeholders a template may use, written `{{name}}`. */
export const EMAIL_PLACEHOLDERS = ["appName", "email", "url", "otp", "newEmail"] as const
export type EmailPlaceholder = (typeof EMAIL_PLACEHOLDERS)[number]

/** Placeholders each kind must use somewhere, so an edited email still carries its link or code. */
const REQUIRED: Readonly<Record<EmailKind, readonly EmailPlaceholder[]>> = {
  verification: ["url"],
  magic_link: ["url"],
  otp: ["otp"],
  reset_password: ["url"],
  invite: ["url"],
  email_change: ["url", "newEmail"],
}

/** Placeholders each kind has values for; the others would always render empty. */
const AVAILABLE: Readonly<Record<EmailKind, readonly EmailPlaceholder[]>> = {
  verification: ["appName", "email", "url"],
  magic_link: ["appName", "email", "url"],
  otp: ["appName", "email", "otp"],
  reset_password: ["appName", "email", "url"],
  invite: ["appName", "email", "url"],
  email_change: ["appName", "email", "url", "newEmail"],
}

/** An editable template: text with `{{placeholder}}` markers. */
export interface StoredEmailTemplate {
  readonly subject: string
  readonly text: string
  /** HTML body. Placeholder values are escaped; the markup itself is the admin's. */
  readonly html?: string
}

/** Where the template in force comes from. */
export type TemplateSource = "default" | "studio"

/** One template as the admin API shows it. */
export interface EmailTemplateView extends StoredEmailTemplate {
  readonly kind: EmailKind
  readonly source: TemplateSource
  readonly placeholders: readonly EmailPlaceholder[]
  readonly required: readonly EmailPlaceholder[]
}

/** A published version of the templates. */
export interface EmailTemplateVersion {
  readonly version: number
  /** The kind that changed, or `undefined` for the empty starting point. */
  readonly kind?: EmailKind
  readonly change: "update" | "reset"
  readonly templates: Readonly<Partial<Record<EmailKind, StoredEmailTemplate>>>
  readonly updatedAt: Date
  readonly updatedBy: string
  readonly comment?: string
}

/** Test data for previews: realistic values for every placeholder. */
export const PREVIEW_DATA: Omit<EmailTemplateData, "appName"> = {
  email: "ada@example.com",
  url: "https://app.example.com/auth/v1/verify?token=preview",
  otp: "482913",
  newEmail: "ada.lovelace@example.com",
}

const LIMITS = { subject: 200, text: 20_000, html: 100_000 }
const MARKER = /\{\{\s*([A-Za-z]+)\s*\}\}/g

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000
}

function markers(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[1] ?? "")
}

/**
 * Checks an edited template: bounded sizes, a single line subject, known placeholders that the kind has
 * values for, the placeholders the kind needs (its link or code), and no script in the HTML body.
 */
export function validateTemplate(kind: EmailKind, input: StoredEmailTemplate): StoredEmailTemplate {
  const problems: string[] = []
  const subject = input.subject.trim()
  if (subject === "") problems.push("the subject is empty")
  if (subject.length > LIMITS.subject)
    problems.push(`the subject has more than ${LIMITS.subject} characters`)
  if (/[\r\n]/.test(subject)) problems.push("the subject must be a single line")
  if (input.text.trim() === "") problems.push("the text body is empty")
  if (input.text.length > LIMITS.text)
    problems.push(`the text body has more than ${LIMITS.text} characters`)
  const html = input.html === undefined || input.html.trim() === "" ? undefined : input.html
  if (html !== undefined) {
    if (html.length > LIMITS.html)
      problems.push(`the HTML body has more than ${LIMITS.html} characters`)
    if (/<\s*script\b/i.test(html) || /\bjavascript:/i.test(html) || /\son[a-z]+\s*=/i.test(html))
      problems.push("the HTML body may not contain scripts, javascript: links or event handlers")
  }
  const parts = [subject, input.text, html ?? ""]
  const used = new Set(parts.flatMap(markers))
  for (const name of used) {
    if (!(EMAIL_PLACEHOLDERS as readonly string[]).includes(name))
      problems.push(`{{${name}}} is not a placeholder`)
    else if (!AVAILABLE[kind].includes(name as EmailPlaceholder))
      problems.push(`{{${name}}} has no value in ${kind} emails`)
  }
  const bodies = new Set([...markers(input.text), ...markers(html ?? "")])
  for (const name of REQUIRED[kind]) {
    if (!bodies.has(name)) problems.push(`the body must contain {{${name}}}`)
  }
  if (problems.length > 0)
    throw new ValidationError(`The ${kind} template is not valid: ${problems.join("; ")}`, {
      details: { kind, problems },
    })
  return { subject, text: input.text, ...(html === undefined ? {} : { html }) }
}

/** Fills a stored template. Values are inserted as plain text, and escaped in the HTML body. */
export function renderTemplate(template: StoredEmailTemplate, data: EmailTemplateData) {
  const values: Record<string, string> = {
    appName: data.appName,
    email: data.email,
    url: data.url ?? "",
    otp: data.otp ?? "",
    newEmail: data.newEmail ?? "",
  }
  const fill = (text: string, html: boolean) =>
    text.replace(MARKER, (_match, name: string) => {
      const value = values[name] ?? ""
      return html ? escapeHtml(value) : value
    })
  return {
    subject: fill(template.subject, false).replace(/[\r\n]+/g, " "),
    text: fill(template.text, false),
    ...(template.html === undefined ? {} : { html: fill(template.html, true) }),
  }
}

/**
 * Turns a template function (a default) into editable text, by rendering it with the placeholder markers
 * as values. Markers contain no characters HTML escaping changes, so they survive in the HTML body.
 */
export function templateText(template: EmailTemplate): StoredEmailTemplate {
  const rendered = template({
    appName: "{{appName}}",
    email: "{{email}}",
    url: "{{url}}",
    otp: "{{otp}}",
    newEmail: "{{newEmail}}",
  })
  return {
    subject: rendered.subject,
    text: rendered.text,
    ...(rendered.html === undefined ? {} : { html: rendered.html }),
  }
}

interface CurrentDocument {
  _id: "email_templates"
  version: number
  templates: Partial<Record<EmailKind, StoredEmailTemplate>>
  updatedAt: Date
  updatedBy: string
}

interface VersionDocument {
  _id: string
  kind: "email_templates_version"
  version: number
  changed?: EmailKind
  change: "update" | "reset"
  templates: Partial<Record<EmailKind, StoredEmailTemplate>>
  updatedAt: Date
  updatedBy: string
  comment?: string
}

/** Options of {@link EmailTemplateStore}. */
export interface EmailTemplateStoreOptions {
  readonly meta: Db
  readonly audit: AuditLog
  /** How long a node trusts its cached copy before reading again, so edits reach every node. */
  readonly refreshMs?: number
  readonly now?: () => number
}

/**
 * Email templates edited in Studio, versioned in `canopy.settings`: the current set is the
 * `email_templates` document and every change adds an `email_templates@<version>` document. A kind without
 * a stored template uses the default. Mail is rendered from a cache that is refreshed in the background.
 */
export class EmailTemplateStore {
  private readonly collection: Collection<CurrentDocument | VersionDocument>
  private readonly audit: AuditLog
  private readonly refreshMs: number
  private readonly now: () => number
  private defaults: Readonly<Partial<Record<EmailKind, EmailTemplate>>> = {}
  private cached: CurrentDocument | undefined
  private loadedAt = Number.NEGATIVE_INFINITY
  private refreshing: Promise<void> | undefined

  constructor(options: EmailTemplateStoreOptions) {
    this.collection = options.meta.collection<CurrentDocument | VersionDocument>("settings")
    this.audit = options.audit
    this.refreshMs = options.refreshMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  /** Sets the templates used for kinds without a stored one (built in auth's defaults). */
  setDefaults(defaults: Readonly<Partial<Record<EmailKind, EmailTemplate>>>): void {
    this.defaults = defaults
  }

  /** Reads the current set from the database. */
  async load(): Promise<void> {
    const doc = await this.collection.findOne({ _id: "email_templates" })
    this.cached = doc === null ? undefined : (doc as CurrentDocument)
    this.loadedAt = this.now()
  }

  private refreshInBackground(): void {
    if (this.now() - this.loadedAt < this.refreshMs || this.refreshing !== undefined) return
    this.refreshing = this.load()
      .catch(() => {
        this.loadedAt = this.now()
      })
      .finally(() => {
        this.refreshing = undefined
      })
  }

  /** The version in force; 0 before any edit. */
  get version(): number {
    return this.cached?.version ?? 0
  }

  /** The stored template of a kind, if one was edited in Studio. */
  stored(kind: EmailKind): StoredEmailTemplate | undefined {
    return this.cached?.templates[kind]
  }

  /**
   * Templates for built in auth's mailer: each kind renders the stored template when there is one and
   * falls back to `fallback` (the default) otherwise.
   */
  mailerTemplates(
    fallback: Readonly<Record<EmailKind, EmailTemplate>>,
  ): Record<EmailKind, EmailTemplate> {
    this.setDefaults(fallback)
    return Object.fromEntries(
      EMAIL_KINDS.map((kind) => [
        kind,
        (data: EmailTemplateData) => {
          this.refreshInBackground()
          const stored = this.stored(kind)
          return stored === undefined ? fallback[kind](data) : renderTemplate(stored, data)
        },
      ]),
    ) as Record<EmailKind, EmailTemplate>
  }

  private defaultOf(kind: EmailKind): StoredEmailTemplate {
    const template = this.defaults[kind]
    if (template === undefined) throw new NotFoundError(`No default ${kind} template`)
    return templateText(template)
  }

  /** Every kind with the template in force. */
  async list(): Promise<{ readonly version: number; readonly data: EmailTemplateView[] }> {
    await this.load()
    return {
      version: this.version,
      data: EMAIL_KINDS.map((kind) => this.view(kind)),
    }
  }

  private view(kind: EmailKind): EmailTemplateView {
    const stored = this.stored(kind)
    return {
      kind,
      ...(stored ?? this.defaultOf(kind)),
      source: stored === undefined ? "default" : "studio",
      placeholders: AVAILABLE[kind],
      required: REQUIRED[kind],
    }
  }

  /** Renders a template (the one in force, or a draft) with {@link PREVIEW_DATA}. */
  preview(kind: EmailKind, appName: string, draft?: StoredEmailTemplate) {
    const template = draft === undefined ? (this.stored(kind) ?? this.defaultOf(kind)) : draft
    if (draft !== undefined) validateTemplate(kind, draft)
    return renderTemplate(template, { appName, ...PREVIEW_DATA })
  }

  /**
   * Saves (or with `template` undefined, resets to the default) one kind. `expectedVersion` must be the
   * version the editor started from, so concurrent edits fail with a conflict instead of overwriting.
   */
  async save(input: {
    readonly kind: EmailKind
    readonly template: StoredEmailTemplate | undefined
    readonly expectedVersion: number
    readonly actor: Actor
    readonly origin?: RequestOrigin
    readonly comment?: string
  }): Promise<{ readonly version: number; readonly data: EmailTemplateView }> {
    const template =
      input.template === undefined ? undefined : validateTemplate(input.kind, input.template)
    await this.load()
    const current = this.cached
    const version = current?.version ?? 0
    if (version !== input.expectedVersion)
      throw new ConflictError(
        `The email templates changed since you loaded them: version ${version} is in force`,
        { details: { currentVersion: version } },
      )
    const before = current?.templates[input.kind]
    const templates: Partial<Record<EmailKind, StoredEmailTemplate>> = {
      ...current?.templates,
    }
    if (template === undefined) delete templates[input.kind]
    else templates[input.kind] = template
    const next = version + 1
    const updatedAt = new Date(this.now())
    let result: { readonly matchedCount: number; readonly upsertedCount: number }
    try {
      result = await this.collection.updateOne(
        version === 0
          ? { _id: "email_templates", version: { $exists: false } }
          : { _id: "email_templates", version },
        { $set: { version: next, templates, updatedAt, updatedBy: input.actor.id } },
        { upsert: version === 0 },
      )
    } catch (error: unknown) {
      if (isDuplicateKey(error))
        throw new ConflictError("The email templates changed while saving; reload and try again")
      throw error
    }
    if (result.matchedCount === 0 && result.upsertedCount === 0)
      throw new ConflictError("The email templates changed while saving; reload and try again")
    await this.collection.insertOne({
      _id: `email_templates@${next}`,
      kind: "email_templates_version",
      version: next,
      changed: input.kind,
      change: template === undefined ? "reset" : "update",
      templates,
      updatedAt,
      updatedBy: input.actor.id,
      ...(input.comment === undefined || input.comment === "" ? {} : { comment: input.comment }),
    })
    this.cached = {
      _id: "email_templates",
      version: next,
      templates,
      updatedAt,
      updatedBy: input.actor.id,
    }
    this.loadedAt = this.now()
    await this.audit.record({
      action: template === undefined ? "auth.templates.reset" : "auth.templates.update",
      actor: input.actor,
      target: { template: input.kind },
      diff: { before: before ?? null, after: template ?? null },
      details: { version: next },
      ...(input.comment === undefined || input.comment === "" ? {} : { comment: input.comment }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    })
    return { version: next, data: this.view(input.kind) }
  }

  /** Published versions, newest first. */
  async history(limit = 50): Promise<EmailTemplateVersion[]> {
    const docs = (await this.collection
      .find({ kind: "email_templates_version" } as never)
      .sort({ version: -1 })
      .limit(limit)
      .toArray()) as VersionDocument[]
    return docs.map((doc) => ({
      version: doc.version,
      ...(doc.changed === undefined ? {} : { kind: doc.changed }),
      change: doc.change,
      templates: doc.templates,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      ...(doc.comment === undefined ? {} : { comment: doc.comment }),
    }))
  }
}
