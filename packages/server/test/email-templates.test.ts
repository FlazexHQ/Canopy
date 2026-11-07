import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { defaultTemplates } from "@canopy/auth-builtin"
import { createPolicySet } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  EMAIL_KINDS,
  renderTemplate,
  type StoredEmailTemplate,
  templateText,
  validateTemplate,
} from "../src/admin/email-templates.ts"
import { base32Decode, totp } from "../src/admin/totp.ts"
import { builtin, type Canopy, can, createCanopy, defineConfig } from "../src/index.ts"

type Kind = (typeof EMAIL_KINDS)[number]

function refusal(kind: Kind, template: StoredEmailTemplate): string {
  try {
    validateTemplate(kind, template)
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  return "accepted"
}

describe("email template text", () => {
  it("turns every default into text whose rendering matches the default", () => {
    const data = {
      appName: "Acme",
      email: "ada@example.com",
      url: "https://app.example.com/v?t=1&u=2",
      otp: "123456",
      newEmail: "new@example.com",
    }
    for (const kind of EMAIL_KINDS) {
      const text = templateText(defaultTemplates[kind])
      expect(renderTemplate(text, data), kind).toEqual(defaultTemplates[kind](data))
    }
    expect(templateText(defaultTemplates.verification).subject).toBe(
      "Confirm your email for {{appName}}",
    )
  })

  it("escapes placeholder values in HTML but not in the text body or subject", () => {
    const rendered = renderTemplate(
      { subject: "Hi {{email}}", text: "Go: {{url}}", html: '<a href="{{url}}">{{email}}</a>' },
      { appName: "A", email: 'x"<b>@example.com', url: "https://e.example/?a=1&b=2" },
    )
    expect(rendered.subject).toBe('Hi x"<b>@example.com')
    expect(rendered.text).toBe("Go: https://e.example/?a=1&b=2")
    expect(rendered.html).toBe(
      '<a href="https://e.example/?a=1&amp;b=2">x&quot;&lt;b&gt;@example.com</a>',
    )
  })

  it("keeps a value containing a newline out of the subject line", () => {
    const rendered = renderTemplate(
      { subject: "For {{email}}", text: "{{url}}" },
      { appName: "A", email: "a@example.com\r\nBcc: evil@example.com", url: "u" },
    )
    expect(rendered.subject).toBe("For a@example.com Bcc: evil@example.com")
  })

  it("accepts a valid edit, trims the subject and drops an empty HTML body", () => {
    expect(
      validateTemplate("verification", { subject: "  Confirm  ", text: "Open {{url}}", html: " " }),
    ).toEqual({ subject: "Confirm", text: "Open {{url}}" })
  })

  it("refuses templates that would send broken or unsafe email", () => {
    expect(refusal("verification", { subject: "Confirm", text: "No link here" })).toContain(
      "must contain {{url}}",
    )
    expect(refusal("otp", { subject: "Code", text: "Your link {{url}}" })).toContain(
      "{{url}} has no value in otp emails",
    )
    expect(refusal("otp", { subject: "Code {{otp}}", text: "nothing" })).toContain(
      "must contain {{otp}}",
    )
    expect(refusal("magic_link", { subject: "Hi {{name}}", text: "{{url}}" })).toContain(
      "{{name}} is not a placeholder",
    )
    expect(refusal("magic_link", { subject: "Line\nbreak", text: "{{url}}" })).toContain(
      "single line",
    )
    expect(refusal("email_change", { subject: "Change", text: "{{url}}" })).toContain(
      "must contain {{newEmail}}",
    )
    expect(refusal("reset_password", { subject: "", text: "{{url}}" })).toContain(
      "subject is empty",
    )
    for (const html of [
      "<p>{{url}}</p><script>alert(1)</script>",
      '<a href="javascript:alert(1)">{{url}}</a>',
      '<img src="x" onerror="alert(1)">{{url}}',
    ]) {
      expect(refusal("magic_link", { subject: "S", text: "{{url}}", html })).toContain("scripts")
    }
  })

  it("lets only owners and admins edit templates", () => {
    expect(can("admin", "settings.write", "production")).toBe(true)
    expect(can("developer", "settings.write", "development")).toBe(false)
    expect(can("viewer", "settings.read", "development")).toBe(false)
  })
})

const suite = MONGODB_URI === undefined ? describe.skip : describe
const APP = "http://localhost:5173"
const OWNER_PASSWORD = "owner password long enough"

suite("email templates through the admin API", () => {
  const name = `canopy_templates_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const names = { database: name, metaDatabase: `${name}_meta`, authDatabase: `${name}_auth` }
  const mails: { to: string; subject: string; body: string }[] = []
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let base: string
  let setupToken: string | undefined
  let token = ""
  const logger = {
    debug() {},
    info() {},
    error() {},
    warn(object: Record<string, unknown>) {
      if (typeof object["subject"] === "string")
        mails.push({
          to: String(object["to"]),
          subject: object["subject"],
          body: String(object["body"]),
        })
    },
  }
  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${base}/admin/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const mailTo = async (to: string): Promise<{ subject: string; body: string }> => {
    for (let i = 0; i < 100; i++) {
      const found = mails.findLast((mail) => mail.to === to)
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`no mail for ${to}`)
  }
  const signUp = (email: string) =>
    fetch(`${base}/auth/v1/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify({ email, password: `${email} password`, name: email }),
    })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
    server = createServer((request, response) => {
      if (handler === undefined) {
        response.statusCode = 503
        response.end()
      } else handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", ...names },
        publicUrl: base,
        masterKey: "m".repeat(48),
        auth: builtin({
          appName: "Acme Notes",
          redirectUrls: [APP],
          trustedProxies: ["127.0.0.1", "::1"],
        }),
        keys: { publishable: ["pk_templates_test"] },
        realtime: false,
      }),
      {
        env: {},
        logger,
        policies: createPolicySet([]),
        onSetupToken: (value) => {
          setupToken = value
        },
      },
    )
    handler = canopy.node()
    const post = (path: string, body: unknown) =>
      fetch(`${base}/admin/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const claimed = await post("/setup", {
      token: setupToken,
      email: "owner@example.com",
      password: OWNER_PASSWORD,
    })
    const secret = base32Decode(
      ((await claimed.json()) as { totp: { secret: string } }).totp.secret,
    )
    const login = await post("/login", {
      email: "owner@example.com",
      password: OWNER_PASSWORD,
      totp: totp(secret, Date.now()),
      transport: "bearer",
    })
    token = ((await login.json()) as { token: string }).token
  })

  afterAll(async () => {
    await canopy?.close({ drainMs: 0 })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const db of Object.values(names)) await mongo.db(db).dropDatabase()
    await mongo.close()
  })

  it("edits, previews, versions and resets a template, and sends mail with the version in force", async () => {
    const listed = (await (await admin("GET", "/auth/templates")).json()) as {
      version: number
      data: { kind: string; source: string; subject: string; required: string[] }[]
    }
    expect(listed.version).toBe(0)
    expect(listed.data.map((template) => template.kind)).toEqual([...EMAIL_KINDS])
    expect(listed.data.every((template) => template.source === "default")).toBe(true)
    expect(listed.data[0]).toMatchObject({
      kind: "verification",
      subject: "Confirm your email for {{appName}}",
      required: ["url"],
    })

    const draft = {
      subject: "Welcome to {{appName}}, confirm {{email}}",
      text: "Hello {{email}}, confirm here: {{url}}",
      html: '<p>Hello {{email}}</p><p><a href="{{url}}">Confirm</a></p>',
    }
    const preview = (await (
      await admin("POST", "/auth/templates/verification/preview", { template: draft })
    ).json()) as { rendered: { subject: string; text: string } }
    expect(preview.rendered.subject).toBe("Welcome to Acme Notes, confirm ada@example.com")
    expect(preview.rendered.text).toContain("https://app.example.com/auth/v1/verify?token=preview")
    const invalidPreview = await admin("POST", "/auth/templates/verification/preview", {
      template: { subject: "S", text: "no link" },
    })
    expect(invalidPreview.status).toBe(422)

    const settings = mongo.db(names.metaDatabase).collection<{ _id: string }>("settings")
    const invalid = await admin("PUT", "/auth/templates/verification", {
      subject: "Confirm",
      text: "There is no link",
      expectedVersion: 0,
    })
    expect(invalid.status).toBe(422)
    expect(await settings.findOne({ _id: "email_templates" })).toBeNull()

    const saved = await admin("PUT", "/auth/templates/verification", {
      ...draft,
      expectedVersion: 0,
      comment: "Friendlier welcome",
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      version: 1,
      data: { source: "studio", subject: draft.subject },
    })
    const stale = await admin("PUT", "/auth/templates/verification", {
      ...draft,
      expectedVersion: 0,
    })
    expect(stale.status).toBe(409)
    const unknownKind = await admin("PUT", "/auth/templates/nonsense", {
      ...draft,
      expectedVersion: 1,
    })
    expect(unknownKind.status).toBe(404)

    expect((await signUp("grace@example.com")).status).toBe(200)
    const edited = await mailTo("grace@example.com")
    expect(edited.subject).toBe("Welcome to Acme Notes, confirm grace@example.com")
    expect(edited.body).toMatch(/^Hello grace@example\.com, confirm here: https?:\/\/\S+/)
    expect(await settings.findOne({ _id: "email_templates@1" })).toMatchObject({
      version: 1,
      changed: "verification",
      change: "update",
      comment: "Friendlier welcome",
    })

    const reset = await admin("DELETE", "/auth/templates/verification?expectedVersion=1")
    expect(reset.status).toBe(200)
    expect(await reset.json()).toMatchObject({ version: 2, data: { source: "default" } })
    expect((await signUp("hopper@example.com")).status).toBe(200)
    expect((await mailTo("hopper@example.com")).subject).toBe("Confirm your email for Acme Notes")

    const history = (await (await admin("GET", "/auth/templates/history")).json()) as {
      data: { version: number; change: string; kind: string }[]
    }
    expect(history.data.map((entry) => [entry.version, entry.change, entry.kind])).toEqual([
      [2, "reset", "verification"],
      [1, "update", "verification"],
    ])

    const audit = await mongo
      .db(names.metaDatabase)
      .collection("audit_log")
      .find({ action: { $in: ["auth.templates.update", "auth.templates.reset"] } })
      .sort({ at: 1 })
      .toArray()
    expect(audit.map((entry) => entry["action"])).toEqual([
      "auth.templates.update",
      "auth.templates.reset",
    ])
    expect(audit[0]).toMatchObject({
      target: { template: "verification" },
      comment: "Friendlier welcome",
      diff: { before: null, after: { subject: draft.subject } },
    })
    expect(audit[1]).toMatchObject({ diff: { before: { subject: draft.subject }, after: null } })
  })
})
