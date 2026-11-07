/** One email ready to send. */
export interface EmailMessage {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html?: string
}

/** Delivers email: SMTP, Resend, Postmark, Amazon SES or your own. */
export interface EmailTransport {
  readonly name: string
  send(message: EmailMessage, signal?: AbortSignal): Promise<void>
}

/** A `fetch` compatible function, injectable for tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** The message of a provider error, without the response body (which may echo the email). */
export async function failure(provider: string, response: Response): Promise<Error> {
  await response.body?.cancel()
  return new Error(`${provider} refused the email with HTTP ${response.status}`)
}

/** Keeps sent messages in memory, for tests and local development. */
export function memoryTransport(): EmailTransport & { readonly sent: EmailMessage[] } {
  const sent: EmailMessage[] = []
  return {
    name: "memory",
    sent,
    async send(message) {
      sent.push(message)
    },
  }
}

/** Resend (`https://resend.com`). */
export function resend(options: {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetch?: FetchLike
}): EmailTransport {
  const send = options.fetch ?? fetch
  const base = options.baseUrl ?? "https://api.resend.com"
  return {
    name: "resend",
    async send(message, signal) {
      const response = await send(`${base}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw await failure("Resend", response)
      await response.body?.cancel()
    },
  }
}

/** Postmark (`https://postmarkapp.com`), on the `outbound` message stream unless told otherwise. */
export function postmark(options: {
  readonly serverToken: string
  readonly messageStream?: string
  readonly baseUrl?: string
  readonly fetch?: FetchLike
}): EmailTransport {
  const send = options.fetch ?? fetch
  const base = options.baseUrl ?? "https://api.postmarkapp.com"
  return {
    name: "postmark",
    async send(message, signal) {
      const response = await send(`${base}/email`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-postmark-server-token": options.serverToken,
        },
        body: JSON.stringify({
          From: message.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          ...(message.html === undefined ? {} : { HtmlBody: message.html }),
          MessageStream: options.messageStream ?? "outbound",
        }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw await failure("Postmark", response)
      await response.body?.cancel()
    },
  }
}
