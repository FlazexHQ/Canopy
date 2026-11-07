import { type EmailTransport, type FetchLike, failure } from "./transport.ts"

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function sha256(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? new Uint8Array(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", imported, encoder.encode(data))
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(decodeURIComponent(segment)).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")
}

/** AWS credentials for Signature Version 4. */
export interface AwsCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** What {@link signV4} signs. */
export interface SignV4Input {
  readonly method: string
  readonly url: string
  /** Headers to sign besides `host` and `x-amz-date`, lower case names. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly region: string
  readonly service: string
  readonly credentials: AwsCredentials
  readonly date: Date
}

/**
 * Signs a request with AWS Signature Version 4 using Web Crypto. Returns the headers to send, the
 * `authorization` header included.
 */
export async function signV4(input: SignV4Input): Promise<Record<string, string>> {
  const url = new URL(input.url)
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken === undefined
      ? {}
      : { "x-amz-security-token": input.credentials.sessionToken }),
  }
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  )
  const canonicalHeaders = names
    .map((name) => `${name}:${(lower[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("")
  const signedHeaders = names.join(";")
  const query = [...url.searchParams]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
  const canonicalRequest = [
    input.method,
    encodePath(url.pathname),
    query,
    canonicalHeaders,
    signedHeaders,
    await sha256(input.body),
  ].join("\n")
  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join(
    "\n",
  )
  let key = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), day)
  key = await hmac(key, input.region)
  key = await hmac(key, input.service)
  key = await hmac(key, "aws4_request")
  const signature = hex(await hmac(key, stringToSign))
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** Amazon SES through the v2 `SendEmail` API. */
export function ses(
  options: AwsCredentials & {
    readonly region: string
    readonly endpoint?: string
    readonly fetch?: FetchLike
  },
): EmailTransport {
  const send = options.fetch ?? fetch
  const endpoint = options.endpoint ?? `https://email.${options.region}.amazonaws.com`
  return {
    name: "ses",
    async send(message, signal) {
      const url = `${endpoint}/v2/email/outbound-emails`
      const body = JSON.stringify({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              ...(message.html === undefined
                ? {}
                : { Html: { Data: message.html, Charset: "UTF-8" } }),
            },
          },
        },
      })
      const headers = await signV4({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        body,
        region: options.region,
        service: "ses",
        credentials: options,
        date: new Date(),
      })
      const { host: _host, ...sent } = headers
      const response = await send(url, {
        method: "POST",
        headers: sent,
        body,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw await failure("Amazon SES", response)
      await response.body?.cancel()
    },
  }
}
