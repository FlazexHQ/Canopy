import { connect as connectTcp, type Socket } from "node:net"
import { connect as connectTls, type TLSSocket } from "node:tls"
import type { EmailMessage, EmailTransport } from "./transport.ts"

/** Settings of an SMTP relay. */
export interface SmtpOptions {
  readonly host: string
  /** @default 587, or 465 with `secure` */
  readonly port?: number
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is required unless `requireTls` is false. */
  readonly secure?: boolean
  /** Refuse to send over a connection that never upgraded to TLS. @default true */
  readonly requireTls?: boolean
  readonly user?: string
  readonly pass?: string
  /** The name sent with `EHLO`. @default "canopy" */
  readonly clientName?: string
  /** Extra TLS settings, for example a private CA in tests. */
  readonly tls?: { readonly ca?: string; readonly rejectUnauthorized?: boolean }
  /** @default 10000 */
  readonly timeoutMs?: number
}

interface Reply {
  readonly code: number
  readonly lines: readonly string[]
}

class Connection {
  private socket: Socket | TLSSocket
  private buffer = ""
  private readonly replies: Reply[] = []
  private waiting: ((reply: Reply) => void) | undefined
  private failed: ((error: Error) => void) | undefined
  private pending: string[] = []
  private closedError: Error | undefined

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket
    this.listen(socket)
  }

  private listen(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.receive(chunk))
    socket.on("error", (error: Error) => this.fail(error))
    socket.on("close", () => this.fail(new Error("The SMTP server closed the connection")))
  }

  private fail(error: Error): void {
    this.closedError ??= error
    const failed = this.failed
    this.waiting = undefined
    this.failed = undefined
    failed?.(error)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf("\r\n")
      if (end === -1) return
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      this.pending.push(line.slice(4))
      if (line[3] === "-") continue
      const reply = { code: Number(line.slice(0, 3)), lines: this.pending }
      this.pending = []
      const waiting = this.waiting
      if (waiting === undefined) this.replies.push(reply)
      else {
        this.waiting = undefined
        this.failed = undefined
        waiting(reply)
      }
    }
  }

  read(): Promise<Reply> {
    const queued = this.replies.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closedError !== undefined) return Promise.reject(this.closedError)
    return new Promise((resolve, reject) => {
      this.waiting = resolve
      this.failed = reject
    })
  }

  async command(line: string, expect: readonly number[]): Promise<Reply> {
    this.socket.write(`${line}\r\n`)
    const reply = await this.read()
    if (!expect.includes(reply.code)) {
      const verb = line.split(" ")[0] ?? line
      throw new Error(`The SMTP server answered ${verb} with ${reply.code}`)
    }
    return reply
  }

  write(data: string): void {
    this.socket.write(data)
  }

  async upgrade(options: SmtpOptions): Promise<void> {
    const plain = this.socket
    plain.removeAllListeners("data")
    plain.removeAllListeners("error")
    plain.removeAllListeners("close")
    const secured = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = connectTls(
        {
          socket: plain,
          servername: options.host,
          ...(options.tls?.ca === undefined ? {} : { ca: options.tls.ca }),
          ...(options.tls?.rejectUnauthorized === undefined
            ? {}
            : { rejectUnauthorized: options.tls.rejectUnauthorized }),
        },
        () => resolve(socket),
      )
      socket.once("error", reject)
    })
    this.socket = secured
    this.buffer = ""
    this.listen(secured)
  }

  get encrypted(): boolean {
    return "encrypted" in this.socket && this.socket.encrypted === true
  }

  close(): void {
    this.socket.destroy()
  }
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

function base64Lines(text: string): string {
  return (
    Buffer.from(text, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n")
}

function address(value: string): string {
  const match = /<([^>]+)>\s*$/.exec(value)
  const bare = (match?.[1] ?? value).trim()
  if (/[\r\n<>]/.test(bare)) throw new Error("Invalid email address")
  return bare
}

/** Builds an RFC 5322 message with a text part and an optional HTML part, both base64 encoded. */
export function buildMime(message: EmailMessage, now: Date = new Date()): string {
  for (const value of [message.from, message.to, message.subject])
    if (/[\r\n]/.test(value)) throw new Error("Email headers must not contain line breaks")
  const domain = address(message.from).split("@")[1] ?? "localhost"
  const id = `${crypto.randomUUID()}@${domain}`
  const head = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
  ]
  if (message.html === undefined) {
    return [
      ...head,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.text),
      "",
    ].join("\r\n")
  }
  const boundary = `canopy-${crypto.randomUUID()}`
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n")
}

function open(options: SmtpOptions, port: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = options.secure
      ? connectTls(
          {
            host: options.host,
            port,
            servername: options.host,
            ...(options.tls?.ca === undefined ? {} : { ca: options.tls.ca }),
            ...(options.tls?.rejectUnauthorized === undefined
              ? {}
              : { rejectUnauthorized: options.tls.rejectUnauthorized }),
          },
          () => resolve(socket),
        )
      : connectTcp({ host: options.host, port }, () => resolve(socket))
    socket.once("error", reject)
  })
}

/**
 * Sends through an SMTP relay with `EHLO`, `STARTTLS` (required by default), `AUTH PLAIN` and one recipient
 * per message. Uses `node:net` and `node:tls`, so it runs on Node, Bun and Deno.
 */
export function smtp(options: SmtpOptions): EmailTransport {
  const port = options.port ?? (options.secure === true ? 465 : 587)
  const requireTls = options.requireTls ?? true
  const name = options.clientName ?? "canopy"
  return {
    name: "smtp",
    async send(message, signal) {
      signal?.throwIfAborted()
      const socket = await open(options, port)
      socket.setTimeout(options.timeoutMs ?? 10_000, () =>
        socket.destroy(new Error("The SMTP server timed out")),
      )
      const connection = new Connection(socket)
      const abort = (): void => connection.close()
      signal?.addEventListener("abort", abort, { once: true })
      try {
        const greeting = await connection.read()
        if (greeting.code !== 220) throw new Error(`The SMTP server greeted with ${greeting.code}`)
        let hello = await connection.command(`EHLO ${name}`, [250])
        const offers = (keyword: string): boolean =>
          hello.lines.some((line) => line.toUpperCase().startsWith(keyword))
        if (!connection.encrypted && offers("STARTTLS")) {
          await connection.command("STARTTLS", [220])
          await connection.upgrade(options)
          hello = await connection.command(`EHLO ${name}`, [250])
        }
        if (requireTls && !connection.encrypted)
          throw new Error("The SMTP server does not offer STARTTLS; refusing to send in clear text")
        if (options.user !== undefined) {
          const token = Buffer.from(`\u0000${options.user}\u0000${options.pass ?? ""}`).toString(
            "base64",
          )
          await connection.command(`AUTH PLAIN ${token}`, [235])
        }
        await connection.command(`MAIL FROM:<${address(message.from)}>`, [250])
        await connection.command(`RCPT TO:<${address(message.to)}>`, [250, 251])
        await connection.command("DATA", [354])
        const body = buildMime(message).replace(/^\./gm, "..")
        connection.write(`${body}\r\n.\r\n`)
        const accepted = await connection.read()
        if (accepted.code !== 250)
          throw new Error(`The SMTP server refused the message with ${accepted.code}`)
        await connection.command("QUIT", [221]).catch(() => undefined)
      } finally {
        signal?.removeEventListener("abort", abort)
        connection.close()
      }
    },
  }
}
