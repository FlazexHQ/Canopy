import { CanopyError, ErrorCode, isDocument, isErrorCode, parse, stringify } from "@canopy/protocol"

/** A `fetch` compatible function, injected by tests. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The signed in admin, as `GET /admin/v1/me` reports it. */
export interface AdminIdentity {
  readonly email: string
  readonly role: string
  /** The server's `CANOPY_ENV`. */
  readonly environment: string
  readonly permissions: readonly string[]
}

/** A client for the admin API of one project, authenticated with a bearer token. */
export class AdminClient {
  readonly url: string
  private readonly token: string
  private readonly fetch: Fetch

  constructor(url: string, token: string, fetchImpl: Fetch = globalThis.fetch) {
    this.url = url
    this.token = token
    this.fetch = fetchImpl
  }

  /** `GET` a path under `/admin/v1`, decoding the EJSON body. */
  get(path: string): Promise<unknown> {
    return this.call("GET", path)
  }

  /** `POST` a body to a path under `/admin/v1`, decoding the EJSON answer. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.call("POST", path, body)
  }

  /** Checks the token and returns who it belongs to. */
  async me(): Promise<AdminIdentity> {
    const body = await this.get("/me")
    const user = isDocument(body) ? body["user"] : undefined
    if (!isDocument(body) || !isDocument(user))
      throw new CanopyError(
        ErrorCode.Internal,
        `${this.url} did not answer like a Canopy admin API`,
      )
    const permissions = body["permissions"]
    return {
      email: String(user["email"] ?? ""),
      role: String(user["role"] ?? ""),
      environment: String(body["environment"] ?? ""),
      permissions: Array.isArray(permissions) ? permissions.map(String) : [],
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetch(`${this.url}/admin/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error: unknown) {
      throw new CanopyError(ErrorCode.Unavailable, `${this.url} did not answer`, { cause: error })
    }
    const text = await response.text()
    let decoded: unknown
    try {
      decoded = text === "" ? undefined : parse(text)
    } catch {
      decoded = undefined
    }
    if (response.ok) return decoded
    throw problemError(response.status, decoded, this.url)
  }
}

function problemError(status: number, body: unknown, url: string): CanopyError {
  if (isDocument(body) && isErrorCode(body["code"])) {
    const details = isDocument(body["details"]) ? body["details"] : undefined
    const detail = typeof body["detail"] === "string" ? body["detail"] : `HTTP ${status}`
    return new CanopyError(body["code"], detail, details === undefined ? {} : { details })
  }
  const code =
    status === 401
      ? ErrorCode.Unauthorized
      : status === 403
        ? ErrorCode.Forbidden
        : status === 404
          ? ErrorCode.NotFound
          : ErrorCode.Internal
  return new CanopyError(code, `${url} answered HTTP ${status}`)
}
