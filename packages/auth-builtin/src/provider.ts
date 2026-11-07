import {
  type AccessTokenClaims,
  type AuthProvider,
  type JwtAuthOptions,
  type RequestInfo,
  type Revocation,
  RevocationSet,
  type UserAdmin,
} from "@canopy/auth"
import { ErrorCode, UnauthorizedError } from "@canopy/protocol"
import { type JSONWebKeySet, errors as joseErrors, jwtVerify } from "jose"
import { type ChangeStream, MongoServerError } from "mongodb"
import { type AuditDocument, AuditLog } from "./audit.ts"
import { Mailer } from "./email/mailer.ts"
import {
  AUTH_COLLECTIONS,
  CLIENT_IP_HEADER,
  createEngine,
  type EngineApi,
  type EngineSettings,
  type EngineUser,
  keyMinter,
} from "./engine.ts"
import { IdentifierGuard, type IdentifierLimitDocument, resolveClientAddress } from "./guard.ts"
import { ensureAuthIndexes } from "./indexes.ts"
import { KeyRing, type SigningKeyDocument, type SigningKeyInfo } from "./keyring.ts"
import type { LeaseDocument } from "./lease.ts"
import { type AuthLogger, silentAuthLogger } from "./logger.ts"
import type { BuiltinAuthOptions, ClaimsHookResult } from "./options.ts"
import { type RevocationDocument, RevocationStore } from "./revocation-store.ts"
import { EngineUserAdmin, toAuthUser } from "./users.ts"

const BASE = "/auth/v1"
const DAY = 86_400
const MAX_BODY_BYTES = 64 * 1024
const RESERVED_ROLES = new Set(["anon", "authenticated", "service", "public"])
const JWKS_PATHS = new Set([
  "/.well-known/jwks.json",
  `${BASE}/jwks`,
  `${BASE}/.well-known/jwks.json`,
])

/** Routes whose answer time could reveal whether an email address has an account. */
const FLOOR_PATHS = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/sign-in/magic-link",
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/send-verification-email",
  "/upgrade",
])

/** Routes limited per email address, and whether they are sign ins (which also back off on failures). */
const IDENTIFIER_ROUTES: ReadonlyMap<string, boolean> = new Map([
  ["/sign-in/email", true],
  ["/sign-in/email-otp", true],
  ["/sign-up/email", false],
  ["/request-password-reset", false],
  ["/sign-in/magic-link", false],
  ["/email-otp/send-verification-otp", false],
  ["/email-otp/request-password-reset", false],
  ["/forget-password/email-otp", false],
  ["/send-verification-email", false],
  ["/upgrade", false],
])

const AUDITED: ReadonlyMap<string, string> = new Map([
  ["/reset-password", "auth.password_reset"],
  ["/change-password", "auth.password_changed"],
  ["/change-email", "auth.email_change_requested"],
  ["/verify-email", "auth.email_verified"],
  ["/update-user", "auth.user_updated"],
  ["/revoke-session", "auth.session_revoked"],
  ["/revoke-sessions", "auth.sessions_revoked"],
  ["/revoke-other-sessions", "auth.sessions_revoked"],
  ["/sign-out", "auth.sign_out"],
])

function json(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const response = Response.json(body, { status, headers })
  response.headers.set("cache-control", "no-store")
  return response
}

function failure(
  code: string,
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return json({ code, message }, status, headers)
}

function signInMethod(path: string | undefined): string {
  if (path === undefined) return "unknown"
  if (path.startsWith("/sign-in/email-otp")) return "email_otp"
  if (path.startsWith("/sign-in/email") || path.startsWith("/sign-up/email")) return "password"
  if (path.startsWith("/magic-link")) return "magic_link"
  if (path.startsWith("/sign-in/anonymous")) return "anonymous"
  if (path.startsWith("/callback") || path.startsWith("/oauth2")) return "oauth"
  if (path.startsWith("/verify-email")) return "email_verification"
  return path.replace(/^\//, "")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** Built in auth: the {@link AuthProvider} on Better Auth, with Canopy's keyring and admin extras. */
export interface BuiltinAuth extends AuthProvider {
  /** The signing keys and their rotation. */
  readonly keys: {
    list(): readonly SigningKeyInfo[]
    /** Activates the standby key now; the old key stays published for the grace period. */
    rotate(): Promise<readonly SigningKeyInfo[]>
    /** Removes a key at once; its tokens stop verifying. */
    revoke(kid: string): Promise<boolean>
  }
  /** Whether a redirect target passes the allowlist. */
  isAllowedRedirect(target: string): boolean
}

class BetterAuthProvider implements BuiltinAuth {
  readonly users: UserAdmin
  readonly verification: JwtAuthOptions
  private readonly options: BuiltinAuthOptions
  private readonly engine: EngineApi
  private readonly keyring: KeyRing
  private readonly revocations: RevocationStore
  private readonly revoked = new RevocationSet()
  private readonly audit: AuditLog
  private readonly guard: IdentifierGuard
  private readonly settingsBody: Readonly<Record<string, unknown>>
  private readonly origins: ReadonlySet<string>
  private readonly logger: AuthLogger
  private readonly invites = new Map<string, number>()
  private readonly issuer: string
  private readonly audience: string
  private readonly ttl: number
  private readonly floorMs: number
  private keyStream: ChangeStream<SigningKeyDocument> | undefined
  private pruneTimer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(options: BuiltinAuthOptions, settings: EngineSettings) {
    this.options = options
    const logger = options.logger ?? silentAuthLogger
    this.logger = logger
    const meta = options.mongo.db(options.metaDatabase ?? "canopy")
    const authDb = options.mongo.db(settings.authDatabase)
    this.issuer = `${settings.publicUrl}${BASE}`
    this.audience = settings.publicUrl
    this.ttl = settings.accessTokenTtlSeconds
    this.floorMs = options.responseFloorMs ?? 80
    this.origins = new Set(settings.trustedOrigins)
    this.audit = new AuditLog(meta.collection<AuditDocument>("audit_log"), logger)
    this.guard = new IdentifierGuard({
      collection: authDb.collection<IdentifierLimitDocument>(AUTH_COLLECTIONS.identifierLimits),
      ...(options.identifierLimit?.max === undefined ? {} : { max: options.identifierLimit.max }),
      ...(options.identifierLimit?.windowSeconds === undefined
        ? {}
        : { windowSeconds: options.identifierLimit.windowSeconds }),
    })
    this.revocations = new RevocationStore({
      collection: meta.collection<RevocationDocument>("revocations"),
      logger,
    })
    this.revocations.onRevocation((revocation) => this.revoked.add(revocation))
    const mailer = new Mailer(options.email, settings.appName, logger)
    let engine: EngineApi | undefined
    const rotation = options.keyRotation ?? {}
    this.keyring = new KeyRing({
      keys: authDb.collection<SigningKeyDocument>(AUTH_COLLECTIONS.signingKeys),
      leases: authDb.collection<LeaseDocument>(AUTH_COLLECTIONS.leases),
      algorithm: settings.algorithm,
      intervalMs: (rotation.intervalSeconds ?? 30 * DAY) * 1000,
      graceMs: (rotation.graceSeconds ?? 30 * DAY) * 1000,
      ...(rotation.refreshMs === undefined ? {} : { refreshMs: rotation.refreshMs }),
      logger,
      mint: keyMinter(settings.algorithm, async () => {
        if (engine === undefined) throw new Error("The auth engine is not ready")
        return (await engine.context()).secret
      }),
    })
    engine = createEngine(settings, {
      mailer,
      keyring: this.keyring,
      logger,
      isInvite: (metadata) => {
        const nonce = metadata?.["canopyInvite"]
        if (typeof nonce !== "string") return false
        const expires = this.invites.get(nonce)
        this.invites.delete(nonce)
        return expires !== undefined && expires > Date.now()
      },
      sessionCreated: (session, path) =>
        this.audit.record({
          action: "auth.sign_in",
          actor: { type: "user", id: session.userId },
          target: { type: "session", id: session.id },
          details: { method: signInMethod(path) },
        }),
      sessionEnded: (session) => {
        this.revoke({ kind: "session", sub: session.userId, sid: session.id })
        this.audit.record({
          action: "auth.session_ended",
          actor: { type: "user", id: session.userId },
          target: { type: "session", id: session.id },
        })
      },
      userCreated: (user, path) =>
        this.audit.record({
          action: "auth.sign_up",
          actor: { type: "user", id: user.id },
          target: { type: "user", id: user.id },
          details: { method: signInMethod(path) },
        }),
    })
    this.engine = engine
    this.users = new EngineUserAdmin({
      engine,
      audit: this.audit,
      minPasswordLength: settings.emailPassword.minPasswordLength,
      revokeUser: (sub) => this.revoke({ kind: "user", sub }),
      sendInvite: async (email, redirectTo) => {
        if (!this.isAllowedRedirect(redirectTo))
          throw new UnauthorizedError("The invite redirect is not in the allowlist")
        const nonce = crypto.randomUUID()
        this.invites.set(nonce, Date.now() + 60_000)
        await engine.sendMagicLink({
          email,
          callbackURL: redirectTo,
          metadata: { canopyInvite: nonce },
        })
      },
    })
    this.verification = {
      issuer: this.issuer,
      audience: settings.publicUrl,
      algorithms: ["EdDSA", "ES256"],
      keys: this.keyring.resolve,
      rolesClaim: "roles",
      clockToleranceSeconds: 60,
      isRevoked: (claims) => this.revoked.has(claims),
    }
    this.settingsBody = {
      external: {
        email: settings.emailPassword.enabled,
        anonymous: settings.anonymous,
        magic_link: settings.magicLink,
        email_otp: settings.emailOtp,
        ...Object.fromEntries(Object.keys(settings.socialProviders).map((id) => [id, true])),
        ...Object.fromEntries(settings.oidcProviders.map((provider) => [provider.id, true])),
      },
      password: {
        min_length: settings.emailPassword.minPasswordLength,
        requires_email_verification: settings.emailPassword.requireEmailVerification,
      },
      access_token_ttl: settings.accessTokenTtlSeconds,
      issuer: this.issuer,
      jwks_uri: `${settings.publicUrl}${BASE}/.well-known/jwks.json`,
    }
  }

  async start(): Promise<void> {
    const authDb = this.options.mongo.db(this.options.authDatabase ?? "canopy_auth")
    await ensureAuthIndexes(authDb)
    await this.keyring.start()
    this.watchKeys()
    await this.revocations.start()
    this.pruneTimer = setInterval(() => this.revoked.prune(), 60_000)
    this.pruneTimer.unref?.()
  }

  private watchKeys(): void {
    if (this.closed) return
    const collection = this.options.mongo
      .db(this.options.authDatabase ?? "canopy_auth")
      .collection<SigningKeyDocument>(AUTH_COLLECTIONS.signingKeys)
    const stream = collection.watch([], {})
    this.keyStream = stream
    stream.on("change", () => {
      this.keyring
        .reload()
        .catch((error: unknown) =>
          this.logger.error({ err: error }, "reloading signing keys failed"),
        )
    })
    stream.on("error", (error: unknown) => {
      this.logger.error(
        { err: error },
        "signing key change stream failed; the periodic reload continues",
      )
      void stream.close()
      if (!this.closed) setTimeout(() => this.watchKeys(), 1000).unref?.()
    })
  }

  get keys(): BuiltinAuth["keys"] {
    return {
      list: () => this.keyring.list(),
      rotate: async () => {
        const keys = await this.keyring.rotate()
        this.audit.record({ action: "auth.admin.keys_rotated", actor: { type: "admin" } })
        return keys
      },
      revoke: async (kid) => {
        const done = await this.keyring.revoke(kid)
        if (done)
          this.audit.record({
            action: "auth.admin.key_revoked",
            actor: { type: "admin" },
            target: { type: "signing_key", id: kid },
          })
        return done
      },
    }
  }

  private revoke(input: {
    readonly kind: "session" | "user"
    readonly sub: string
    readonly sid?: string
  }): void {
    const at = new Date()
    const revocation: Revocation = {
      ...input,
      at,
      expiresAt: new Date(at.getTime() + (this.ttl + 120) * 1000),
    }
    void this.revocations.revoke(revocation)
  }

  onRevocation(listener: (revocation: Revocation) => void): () => void {
    return this.revocations.onRevocation(listener)
  }

  isAllowedRedirect(target: string): boolean {
    if (target.startsWith("/")) return !target.startsWith("//") && !target.includes("\\")
    const origin = originOf(target)
    return origin !== undefined && this.origins.has(origin)
  }

  async jwks(): Promise<JSONWebKeySet> {
    return this.keyring.jwks()
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let payload: AccessTokenClaims
    try {
      const verified = await jwtVerify(token, this.keyring.resolve, {
        algorithms: ["EdDSA", "ES256"],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: 60,
        requiredClaims: ["exp", "iat", "sub"],
      })
      payload = verified.payload as AccessTokenClaims
    } catch (error: unknown) {
      if (error instanceof joseErrors.JWTExpired)
        throw new UnauthorizedError("The token has expired", { cause: error }, true)
      throw new UnauthorizedError("Invalid token", { cause: error })
    }
    if (this.revoked.has(payload))
      throw new UnauthorizedError("The session of this token was revoked")
    return payload
  }

  private cors(request: Request, response: Response): Response {
    const origin = request.headers.get("origin")
    if (origin === null || !this.origins.has(origin)) return response
    const headers = new Headers(response.headers)
    headers.set("access-control-allow-origin", origin)
    headers.set("access-control-allow-credentials", "true")
    headers.set("access-control-expose-headers", "set-auth-token")
    headers.append("vary", "origin")
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  async handler(request: Request, info: RequestInfo = {}): Promise<Response> {
    const response = await this.route(request, info)
    return this.cors(request, response)
  }

  private async route(request: Request, info: RequestInfo): Promise<Response> {
    const started = performance.now()
    const url = new URL(request.url)
    const pathname = url.pathname
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin")
      if (origin === null || !this.origins.has(origin)) return new Response(null, { status: 204 })
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
          "access-control-max-age": "600",
        },
      })
    }
    if (JWKS_PATHS.has(pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return failure("METHOD_NOT_ALLOWED", 405, "Use GET")
      return Response.json(this.keyring.jwks(), {
        headers: { "cache-control": "public, max-age=300" },
      })
    }
    if (!pathname.startsWith(`${BASE}/`)) return failure("NOT_FOUND", 404, "Not found")
    const path = pathname.slice(BASE.length)
    const declared = Number(request.headers.get("content-length") ?? "0")
    if (declared > MAX_BODY_BYTES)
      return failure(ErrorCode.PayloadTooLarge, 413, "The request body is too large")
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer()
    if (body !== undefined && body.byteLength > MAX_BODY_BYTES)
      return failure(ErrorCode.PayloadTooLarge, 413, "The request body is too large")
    const ip = resolveClientAddress(
      request.headers,
      info.clientAddress,
      this.options.trustedProxies ?? [],
    )
    const headers = new Headers(request.headers)
    headers.set(CLIENT_IP_HEADER, ip)

    if (path === "/token" && request.method === "GET") return this.token(headers, ip)
    if (path === "/settings" && request.method === "GET") return json(this.settingsBody)

    const email = body === undefined ? undefined : this.emailOf(body)
    const signIn = IDENTIFIER_ROUTES.get(path)
    if (request.method === "POST" && signIn !== undefined && email !== undefined) {
      const verdict = await this.guard.check(path, email, signIn)
      if (!verdict.allowed) {
        this.audit.record({
          action: "auth.rate_limited",
          actor: { type: "anonymous" },
          ip,
          details: { path },
        })
        return failure(ErrorCode.RateLimited, 429, "Too many attempts; try again later", {
          "retry-after": String(verdict.retryAfterSeconds),
        })
      }
    }

    let response: Response
    if (path === "/upgrade" && request.method === "POST")
      response = await this.upgrade(headers, body, ip)
    else {
      response = await this.engine.handler(
        new Request(request.url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
        }),
      )
      if (path === "/sign-up/email") response = await this.uniformSignUp(response, email)
      await this.afterEngine(path, request.method, response, email, ip)
    }
    if (FLOOR_PATHS.has(path) && request.method === "POST") {
      const wait = this.floorMs - (performance.now() - started)
      if (wait > 0) await sleep(wait)
    }
    return response
  }

  private emailOf(body: ArrayBuffer): string | undefined {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
      if (typeof parsed !== "object" || parsed === null) return undefined
      const email = (parsed as { email?: unknown }).email
      return typeof email === "string" && email.length <= 320 ? email : undefined
    } catch {
      return undefined
    }
  }

  private async afterEngine(
    path: string,
    method: string,
    response: Response,
    email: string | undefined,
    ip: string,
  ): Promise<void> {
    if (method !== "POST") return
    if (IDENTIFIER_ROUTES.get(path) === true && email !== undefined) {
      if (response.status === 200) await this.guard.succeeded(email)
      else if (response.status === 401 || response.status === 403 || response.status === 400) {
        await this.guard.failed(email)
        this.audit.record({
          action: "auth.sign_in_failed",
          actor: { type: "anonymous" },
          ip,
          details: { method: signInMethod(path), email, status: response.status },
        })
      }
    }
    if (response.status === 429)
      this.audit.record({
        action: "auth.rate_limited",
        actor: { type: "anonymous" },
        ip,
        details: { path },
      })
    const action = AUDITED.get(path)
    if (action !== undefined && response.status === 200)
      this.audit.record({ action, actor: { type: "user" }, ip })
  }

  /**
   * Better Auth answers a sign up for a taken address with a synthetic user whose optional fields are null,
   * while a real insert omits them, so the shapes differ, and the losers of a race for one address get 422.
   * Every pending sign up, and every sign up for an address that exists, gets one body instead.
   */
  private async uniformSignUp(response: Response, email: string | undefined): Promise<Response> {
    if (response.status !== 200 && response.status !== 422) return response
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return new Response(text, response)
    }
    const fields =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    const uniform = (): Response =>
      new Response(JSON.stringify({ token: null, user: null, verification: "sent" }), {
        status: 200,
        headers,
      })
    if (response.status === 200)
      return fields["token"] === null ? uniform() : new Response(text, { status: 200, headers })
    if (fields["code"] === "FAILED_TO_CREATE_USER") {
      this.logger.warn({ email }, "sign up could not create the user; answered as pending")
      return uniform()
    }
    return new Response(text, { status: response.status, headers })
  }

  private async runClaimsHook(user: EngineUser, sessionId: string): Promise<ClaimsHookResult> {
    const hook = this.options.claims
    if (hook === undefined) return {}
    const timeoutMs = this.options.claimsTimeoutMs ?? 200
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          hook({
            user: toAuthUser(user),
            session: { id: sessionId },
            db: this.options.mongo.db(this.options.appDatabase),
            signal: controller.signal,
          }),
        ),
        timeout,
      ])
      return checkHookResult(result)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Mints an access token for the caller's session; any hook error, timeout or oversize token fails closed. */
  private async token(headers: Headers, ip: string): Promise<Response> {
    const { found, headers: refreshed } = await this.engine.getSession(headers)
    if (found === null) return failure(ErrorCode.Unauthorized, 401, "No valid session")
    const { user, session } = found
    if (
      user.banned === true &&
      (user.banExpires === null ||
        user.banExpires === undefined ||
        user.banExpires.getTime() > Date.now())
    )
      return failure(ErrorCode.Forbidden, 403, "This user is banned")
    let contributed: ClaimsHookResult
    try {
      contributed = await this.runClaimsHook(user, session.id)
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : "the hook failed"
      this.audit.record({
        action: "auth.claims_hook_failed",
        actor: { type: "user", id: user.id },
        ip,
        details: { reason },
      })
      return failure(ErrorCode.AuthHookFailed, 500, `The claims hook failed: ${reason}`)
    }
    const stored = toAuthUser(user)
    const now = Math.floor(Date.now() / 1000)
    const roles = [...new Set([...stored.roles, ...(contributed.roles ?? [])])]
    const payload: Record<string, unknown> = {
      iat: now,
      exp: now + this.ttl,
      sub: user.id,
      sid: session.id,
      role: "authenticated",
      roles,
      ...(stored.isAnonymous ? {} : { email: user.email, email_verified: user.emailVerified }),
      is_anonymous: stored.isAnonymous,
      aal: "aal1",
      app_metadata: { ...stored.appMetadata, ...contributed.app_metadata },
      user_metadata: stored.userMetadata,
    }
    const token = await this.engine.signJwt(payload)
    const size = new TextEncoder().encode(token).byteLength
    const cap = this.options.maxTokenBytes ?? 4096
    if (size > cap) {
      this.audit.record({
        action: "auth.claims_hook_failed",
        actor: { type: "user", id: user.id },
        ip,
        details: { reason: "token too large", bytes: size },
      })
      return failure(
        ErrorCode.AuthHookFailed,
        500,
        `The access token is ${size} bytes, over the ${cap} byte cap`,
      )
    }
    const response = json({
      access_token: token,
      token_type: "bearer",
      expires_in: this.ttl,
      expires_at: now + this.ttl,
    })
    for (const cookie of refreshed.getSetCookie()) response.headers.append("set-cookie", cookie)
    const rolled = refreshed.get("set-auth-token")
    if (rolled !== null) response.headers.set("set-auth-token", rolled)
    return response
  }

  /**
   * Turns the caller's anonymous user into a permanent one in place, so `sub` and everything the app stored
   * for it stay valid. Answers the same way whether or not the address is taken.
   */
  private async upgrade(
    headers: Headers,
    body: ArrayBuffer | undefined,
    ip: string,
  ): Promise<Response> {
    const { found } = await this.engine.getSession(headers)
    if (found === null) return failure(ErrorCode.Unauthorized, 401, "No valid session")
    if (found.user.isAnonymous !== true)
      return failure("USER_IS_NOT_ANONYMOUS", 400, "Only anonymous users can be upgraded")
    let input: { email?: unknown; password?: unknown; callbackURL?: unknown } = {}
    try {
      input = JSON.parse(new TextDecoder().decode(body ?? new ArrayBuffer(0))) as typeof input
    } catch {
      return failure(ErrorCode.ValidationFailed, 400, "The body must be JSON")
    }
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : ""
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
      return failure("INVALID_EMAIL", 400, "Invalid email address")
    const password = input.password
    const minimum = this.passwordMinimum()
    if (
      password !== undefined &&
      (typeof password !== "string" || password.length < minimum || password.length > 128)
    )
      return failure("PASSWORD_TOO_SHORT", 400, `Passwords need ${minimum} to 128 characters`)
    const callbackURL = typeof input.callbackURL === "string" ? input.callbackURL : undefined
    if (callbackURL !== undefined && !this.isAllowedRedirect(callbackURL))
      return failure("INVALID_CALLBACK_URL", 403, "The callback URL is not in the allowlist")
    const sent = json({ verification: "sent" })
    const context = await this.engine.context()
    if ((await context.internalAdapter.findUserByEmail(email)) !== null) return sent
    const id = found.user.id
    const hash = typeof password === "string" ? await context.hashPassword(password) : undefined
    try {
      await context.transaction(async () => {
        await context.internalAdapter.updateUser(id, {
          email,
          emailVerified: false,
          isAnonymous: false,
        })
        if (hash !== undefined)
          await context.internalAdapter.linkAccount({
            providerId: "credential",
            accountId: id,
            userId: id,
            password: hash,
          })
      })
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) return sent
      throw error
    }
    await this.engine.sendVerificationEmail(email, callbackURL)
    this.audit.record({ action: "auth.anonymous_upgraded", actor: { type: "user", id }, ip })
    return sent
  }

  private passwordMinimum(): number {
    const option = this.options.emailPassword
    return typeof option === "object" ? (option.minPasswordLength ?? 10) : 10
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer)
    await this.keyStream?.close()
    await this.keyring.close()
    await this.revocations.close()
    await this.audit.flush()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

function checkHookResult(result: unknown): ClaimsHookResult {
  if (result === undefined || result === null) return {}
  if (typeof result !== "object" || Array.isArray(result))
    throw new Error("the hook must return an object")
  const { app_metadata, roles, ...rest } = result as Record<string, unknown>
  const extra = Object.keys(rest)
  if (extra.length > 0)
    throw new Error(`the hook may only return app_metadata and roles, not ${extra.join(", ")}`)
  if (
    app_metadata !== undefined &&
    (typeof app_metadata !== "object" || app_metadata === null || Array.isArray(app_metadata))
  )
    throw new Error("app_metadata must be an object")
  if (roles !== undefined) {
    if (
      !Array.isArray(roles) ||
      roles.some((role) => typeof role !== "string" || role === "" || RESERVED_ROLES.has(role))
    )
      throw new Error(
        "roles must be a list of names other than anon, authenticated, service and public",
      )
  }
  return {
    ...(app_metadata === undefined
      ? {}
      : { app_metadata: app_metadata as Record<string, unknown> }),
    ...(roles === undefined ? {} : { roles: roles as string[] }),
  }
}

function resolveSettings(options: BuiltinAuthOptions): EngineSettings {
  let publicUrl: URL
  try {
    publicUrl = new URL(options.publicUrl)
  } catch {
    throw new TypeError("publicUrl must be an absolute URL")
  }
  if (options.secret.length < 32)
    throw new TypeError("The auth secret needs at least 32 characters")
  const ttl = options.accessTokenTtlSeconds ?? 600
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > 3600)
    throw new RangeError("accessTokenTtlSeconds must be between 300 and 3600")
  const grace = options.keyRotation?.graceSeconds ?? 30 * DAY
  if (grace < ttl) throw new RangeError("The key grace period must cover the access token lifetime")
  const emailPassword = options.emailPassword ?? true
  const minPasswordLength =
    typeof emailPassword === "object" ? (emailPassword.minPasswordLength ?? 10) : 10
  if (minPasswordLength < 10 || minPasswordLength > 128)
    throw new RangeError("minPasswordLength must be between 10 and 128")
  const trusted = new Set<string>([publicUrl.origin])
  for (const entry of options.redirectUrls ?? []) {
    const origin = originOf(entry)
    if (origin === undefined)
      throw new TypeError(`The redirect URL ${JSON.stringify(entry)} is not an http(s) URL`)
    trusted.add(origin)
  }
  for (const provider of options.oidcProviders ?? []) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider.id))
      throw new TypeError(
        `The OIDC provider id ${JSON.stringify(provider.id)} must be lower case letters, digits, _ or -`,
      )
  }
  return {
    appName: options.appName ?? "Canopy",
    publicUrl: publicUrl.origin + publicUrl.pathname.replace(/\/+$/, ""),
    secret: options.secret,
    mongo: options.mongo,
    authDatabase: options.authDatabase ?? "canopy_auth",
    trustedOrigins: [...trusted],
    accessTokenTtlSeconds: ttl,
    algorithm: options.algorithm ?? "EdDSA",
    emailPassword: {
      enabled: emailPassword !== false,
      minPasswordLength,
      requireEmailVerification:
        typeof emailPassword === "object" ? (emailPassword.requireEmailVerification ?? true) : true,
    },
    magicLink: options.magicLink ?? true,
    emailOtp: options.emailOtp ?? true,
    anonymous: options.anonymous ?? false,
    socialProviders: options.socialProviders ?? {},
    oidcProviders: options.oidcProviders ?? [],
    session: {
      expiresInSeconds: options.session?.expiresInSeconds ?? 7 * DAY,
      updateAgeSeconds: options.session?.updateAgeSeconds ?? DAY,
    },
    rateLimit: {
      windowSeconds: options.rateLimit?.windowSeconds ?? 60,
      max: options.rateLimit?.max ?? 100,
    },
  }
}

/**
 * Starts built in auth: creates the `canopy_auth` indexes, makes sure signing keys exist, loads the
 * revocations in force and starts the key rotation schedule. Close it with `close()`.
 */
export async function createBuiltinAuth(options: BuiltinAuthOptions): Promise<BuiltinAuth> {
  const provider = new BetterAuthProvider(options, resolveSettings(options))
  await provider.start()
  return provider
}
