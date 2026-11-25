import { createHmac } from "node:crypto"
import type { EmailMessage } from "../../src/index.ts"
import type { CaseContext, Client, Reply } from "./harness.ts"

/** The first link in a text email. */
export function linkOf(mail: EmailMessage | undefined): string {
  const match = /https?:\/\/\S+/.exec(mail?.text ?? "")
  if (match === null) throw new Error(`No link in "${mail?.subject}"`)
  return match[0]
}

/** The six digit code of an OTP email. */
export function otpOf(context: CaseContext, mail: EmailMessage | undefined): string {
  const match = /\b(\d{6})\b/.exec(mail?.subject ?? "")
  if (match?.[1] === undefined) throw new Error("No code in the OTP email")
  return context.name(match[1], "otp")
}

/** RFC 4648 base32, as authenticator apps read TOTP secrets. */
export function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of text.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  const bytes: number[] = []
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  return Buffer.from(bytes)
}

/** RFC 6238 TOTP: HMAC-SHA1 over the 30 second step, six digits. */
export function totp(secret: Buffer, at: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const mac = createHmac("sha1", secret).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0x0f
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, "0")
}

/** Signs up and confirms the address through the mailed link, which signs the browser in. */
export async function signUpVerified(
  context: CaseContext,
  client: Client,
  email: string,
  password: string,
  name = "Ada",
): Promise<void> {
  const before = context.outbox.length
  const signUp = await context.send(
    client,
    "POST",
    "/auth/v1/sign-up/email",
    { email, password, name },
    { mails: 1 },
  )
  if (signUp.status !== 200) throw new Error(`sign up failed: ${signUp.status} ${signUp.text}`)
  const [mail] = await context.mails(before, 1)
  const verified = await context.visit(client, linkOf(mail))
  if (verified.status >= 400) throw new Error(`verification failed: ${verified.status}`)
}

/** Signs in with email and password. */
export function signIn(
  context: CaseContext,
  client: Client,
  email: string,
  password: string,
): Promise<Reply> {
  return context.send(client, "POST", "/auth/v1/sign-in/email", { email, password })
}

/** Fails a script whose flow did not go as the case expects, so a broken flow is never recorded. */
export function expectStatus(reply: Reply, status: number, what: string): void {
  if (reply.status !== status)
    throw new Error(`${what}: expected ${status}, got ${reply.status} ${reply.text}`)
}
