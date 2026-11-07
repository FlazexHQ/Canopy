import type { AddressInfo } from "node:net"
import { createServer, type Socket } from "node:net"
import { describe, expect, it } from "vitest"
import {
  buildMime,
  defaultTemplates,
  type EmailMessage,
  Mailer,
  memoryTransport,
  postmark,
  resend,
  ses,
  signV4,
  smtp,
} from "../src/index.ts"

const silent = { warn() {}, error() {} }

function capture(status = 200): {
  calls: { url: string; init: RequestInit }[]
  fetch: (url: string, init: RequestInit) => Promise<Response>
} {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response("{}", { status })
    },
  }
}

const message: EmailMessage = {
  from: "Acme <no-reply@acme.example>",
  to: "user@example.com",
  subject: "Hello",
  text: "plain body",
  html: "<p>html body</p>",
}

describe("templates", () => {
  it("escapes values in HTML and keeps them verbatim in text", () => {
    const url = 'https://app.example/cb?a=1&b="x"<script>'
    const rendered = defaultTemplates.magic_link({ appName: "A&B", email: "u@example.com", url })
    expect(rendered.subject).toBe("Your sign in link for A&B")
    expect(rendered.text).toContain(url)
    expect(rendered.html).toContain("https://app.example/cb?a=1&amp;b=&quot;x&quot;&lt;script&gt;")
    expect(rendered.html).not.toContain("<script>")
    const otp = defaultTemplates.otp({ appName: "Acme", email: "u@example.com", otp: "123456" })
    expect(otp.subject).toBe("Your Acme code is 123456")
  })

  it("lets a template be replaced per kind", async () => {
    const transport = memoryTransport()
    const mailer = new Mailer(
      {
        from: "a@acme.example",
        transport,
        templates: {
          invite: (data) => ({ subject: `Join ${data.appName}`, text: data.url ?? "" }),
        },
      },
      "Acme",
      silent,
    )
    await mailer.send("invite", { email: "u@example.com", url: "https://x.example/i" })
    await mailer.send("reset_password", { email: "u@example.com", url: "https://x.example/r" })
    expect(transport.sent.map((mail) => mail.subject)).toEqual([
      "Join Acme",
      "Reset your password for Acme",
    ])
  })
})

describe("Mailer", () => {
  it("drops emails over the limit per kind and recipient, and never throws on transport errors", async () => {
    const transport = memoryTransport()
    const mailer = new Mailer(
      { from: "a@acme.example", transport, perRecipientLimit: 2 },
      "Acme",
      silent,
    )
    for (let i = 0; i < 4; i++) await mailer.send("otp", { email: "U@example.com", otp: "1" })
    await mailer.send("otp", { email: "other@example.com", otp: "1" })
    await mailer.send("magic_link", { email: "u@example.com", url: "https://x.example" })
    expect(transport.sent.map((mail) => `${mail.to} ${mail.subject.split(" ")[1]}`)).toEqual([
      "U@example.com Acme",
      "U@example.com Acme",
      "other@example.com Acme",
      "u@example.com sign",
    ])
    const errors: string[] = []
    const failing = new Mailer(
      {
        from: "a@acme.example",
        transport: {
          name: "broken",
          send: async () => {
            throw new Error("down")
          },
        },
      },
      "Acme",
      { warn() {}, error: (_fields, text) => errors.push(text) },
    )
    await expect(failing.send("otp", { email: "u@example.com", otp: "1" })).resolves.toBeUndefined()
    expect(errors).toEqual(["auth email failed"])
  })
})

describe("HTTP providers", () => {
  it("sends through Resend with a bearer key", async () => {
    const { calls, fetch } = capture()
    await resend({ apiKey: "re_123", fetch }).send(message)
    expect(calls[0]?.url).toBe("https://api.resend.com/emails")
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
      "Bearer re_123",
    )
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: message.from,
      to: ["user@example.com"],
      subject: "Hello",
      text: "plain body",
      html: "<p>html body</p>",
    })
  })

  it("sends through Postmark on the outbound stream", async () => {
    const { calls, fetch } = capture()
    await postmark({ serverToken: "pm-token", fetch }).send(message)
    expect(calls[0]?.url).toBe("https://api.postmarkapp.com/email")
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.["x-postmark-server-token"],
    ).toBe("pm-token")
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      From: message.from,
      To: "user@example.com",
      HtmlBody: "<p>html body</p>",
      MessageStream: "outbound",
    })
  })

  it("reports a refused email without the response body", async () => {
    const { fetch } = capture(422)
    await expect(resend({ apiKey: "k", fetch }).send(message)).rejects.toThrow(
      "Resend refused the email with HTTP 422",
    )
  })

  it("signs SES requests with SigV4 for the ses service", async () => {
    const { calls, fetch } = capture()
    await ses({ region: "eu-west-1", accessKeyId: "AKID", secretAccessKey: "secret", fetch }).send(
      message,
    )
    expect(calls[0]?.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails")
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: ["user@example.com"] },
    })
  })

  it("matches the get-vanilla vector of the AWS SigV4 test suite", async () => {
    const headers = await signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      date: new Date("2015-08-30T12:36:00Z"),
    })
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    )
  })
})

/** A fake SMTP relay that records the conversation. */
async function fakeSmtp(options: { starttls: boolean; auth: boolean }) {
  const lines: string[] = []
  let data = ""
  const server = createServer((socket: Socket) => {
    let inData = false
    let buffer = ""
    socket.setEncoding("utf8")
    socket.write("220 fake ESMTP\r\n")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n")
          if (end === -1) return
          data = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write("250 queued\r\n")
          continue
        }
        const end = buffer.indexOf("\r\n")
        if (end === -1) return
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        lines.push(line)
        const verb = line.split(" ")[0]?.toUpperCase()
        if (verb === "EHLO")
          socket.write(
            `250-fake\r\n${options.starttls ? "250-STARTTLS\r\n" : ""}${options.auth ? "250-AUTH PLAIN\r\n" : ""}250 OK\r\n`,
          )
        else if (verb === "AUTH") socket.write("235 ok\r\n")
        else if (verb === "MAIL" || verb === "RCPT") socket.write("250 ok\r\n")
        else if (verb === "DATA") {
          inData = true
          socket.write("354 go\r\n")
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n")
          socket.end()
        } else socket.write("502 no\r\n")
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    lines,
    data: () => data,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe("smtp", () => {
  it("refuses to send in clear text when the server offers no STARTTLS", async () => {
    const relay = await fakeSmtp({ starttls: false, auth: true })
    try {
      await expect(smtp({ host: "127.0.0.1", port: relay.port }).send(message)).rejects.toThrow(
        /STARTTLS/,
      )
      expect(relay.lines.some((line) => line.startsWith("MAIL"))).toBe(false)
    } finally {
      await relay.close()
    }
  })

  it("sends with AUTH PLAIN when clear text is allowed", async () => {
    const relay = await fakeSmtp({ starttls: false, auth: true })
    try {
      await smtp({
        host: "127.0.0.1",
        port: relay.port,
        requireTls: false,
        user: "u",
        pass: "p",
      }).send(message)
      expect(relay.lines.slice(0, 5)).toEqual([
        "EHLO canopy",
        `AUTH PLAIN ${Buffer.from("\u0000u\u0000p").toString("base64")}`,
        "MAIL FROM:<no-reply@acme.example>",
        "RCPT TO:<user@example.com>",
        "DATA",
      ])
      expect(relay.data()).toContain("Subject: Hello")
      expect(relay.data()).toContain("multipart/alternative")
    } finally {
      await relay.close()
    }
  })

  it("builds MIME with encoded non ASCII subjects and refuses header injection", () => {
    const { html: _html, ...plain } = message
    const mime = buildMime({ ...plain, subject: "Grüße" })
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Grüße").toString("base64")}?=`)
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8")
    const body = mime.split("\r\n\r\n")[1] ?? ""
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe("plain body")
    expect(() => buildMime({ ...message, subject: "x\r\nBcc: victim@example.com" })).toThrow()
  })
})
