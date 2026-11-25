import { createHash, createPrivateKey } from "node:crypto"
import { readFileSync } from "node:fs"
import { importJWK, type JWK, SignJWT } from "jose"
import { derivedJwk, type Route } from "./determinism.ts"

/** The person every mock provider signs in. */
export interface IdpUser {
  readonly sub: string
  readonly email: string
  readonly name: string
}

/** Ways a provider can be made to misbehave, for the refusal cases. */
export interface IdpFaults {
  /** The ID token carries another nonce. */
  wrongNonce?: boolean
  /** The ID token is for another client. */
  wrongAudience?: boolean
  /** The token endpoint refuses the code. */
  refuseCode?: boolean
  refuseRefresh?: boolean
}

interface Grant {
  readonly nonce: string | null
  readonly clientId: string
  readonly redirectUri: string
}

/** The mock providers of a recording, reachable at their real origins through the routed `fetch`. */
export class MockProviders {
  readonly oidcIssuer = "https://idp.canopy.test"
  readonly routes = new Map<string, Route>()
  readonly faults: IdpFaults = {}
  user: IdpUser = { sub: "idp-user-1", email: "oidc@example.com", name: "OIDC User" }
  private readonly grants = new Map<string, Grant>()
  private codes = 0
  private readonly oidcJwk: JWK
  private readonly googleJwk: JWK

  constructor() {
    const { d, ...publicJwk } = derivedJwk(
      "P-256",
      createHash("sha256").update("canopy auth oracle idp key").digest(),
    )
    this.oidcJwk = { ...publicJwk, d, kid: "idp-key-1", alg: "ES256", use: "sig" }
    const rsa = createPrivateKey({
      key: readFileSync(
        new URL("../../../../crates/canopy-authn/tests/support/rsa-test-key.der", import.meta.url),
      ),
      format: "der",
      type: "pkcs1",
    }).export({ format: "jwk" })
    this.googleJwk = { ...rsa, kid: "google-key-1", alg: "RS256", use: "sig" }
    this.routes.set(this.oidcIssuer, (request) => this.oidc(request))
    this.routes.set("https://github.com", (request) => this.githubToken(request))
    this.routes.set("https://api.github.com", (request) => this.githubApi(request))
    this.routes.set("https://accounts.google.com", (request) => this.authorize(request))
    this.routes.set("https://oauth2.googleapis.com", (request) => this.googleToken(request))
    for (const origin of ["https://appleid.apple.com", "https://login.microsoftonline.com"])
      this.routes.set(origin, async () => Response.json({ keys: [publicOf(this.googleJwk)] }))
    this.routes.set(
      "https://graph.microsoft.com",
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
    )
    this.routes.set("https://www.googleapis.com", async () =>
      Response.json({ keys: [publicOf(this.googleJwk)] }),
    )
  }

  /** Resets codes and faults so each run of a case sees the same provider. */
  reset(): void {
    this.grants.clear()
    this.codes = 0
    for (const key of Object.keys(this.faults)) Reflect.deleteProperty(this.faults, key)
    this.user = { sub: "idp-user-1", email: "oidc@example.com", name: "OIDC User" }
  }

  /** The browser at a provider's authorization endpoint: consent is given at once. */
  async authorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const redirectUri = url.searchParams.get("redirect_uri") ?? ""
    const code = `code-${++this.codes}`
    this.grants.set(code, {
      nonce: url.searchParams.get("nonce"),
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri,
    })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    const state = url.searchParams.get("state")
    if (state !== null) target.searchParams.set("state", state)
    return new Response(null, { status: 302, headers: { location: target.toString() } })
  }

  private async form(request: Request): Promise<URLSearchParams> {
    return new URLSearchParams(await request.text())
  }

  private grant(form: URLSearchParams): Grant | undefined {
    if (this.faults.refuseCode === true) return undefined
    const code = form.get("code") ?? ""
    const grant = this.grants.get(code)
    this.grants.delete(code)
    return grant
  }

  private async idToken(jwk: JWK, issuer: string, grant: Grant, expired = false): Promise<string> {
    const nonce = this.faults.wrongNonce === true ? "not-the-nonce" : grant.nonce
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      email: this.user.email,
      email_verified: true,
      name: this.user.name,
      ...(nonce === null ? {} : { nonce }),
    })
      .setProtectedHeader({ alg: String(jwk.alg), kid: String(jwk.kid) })
      .setIssuer(issuer)
      .setAudience(this.faults.wrongAudience === true ? "another-client" : grant.clientId)
      .setSubject(this.user.sub)
      .setIssuedAt(now)
      .setExpirationTime(expired ? now - 90 : now + 300)
      .sign(await importJWK(jwk, String(jwk.alg)))
  }

  private async oidc(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const issuer = this.oidcIssuer
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256", "RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      })
    if (url.pathname === "/jwks")
      return Response.json({ keys: [publicOf(this.oidcJwk), publicOf(this.googleJwk)] })
    if (url.pathname === "/authorize") return this.authorize(request)
    if (url.pathname === "/token" && request.method === "POST") {
      const grant = this.grant(await this.form(request))
      if (grant === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({
        access_token: `oidc-access-${this.codes}`,
        id_token: await this.idToken(this.oidcJwk, issuer, grant),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      })
    }
    if (url.pathname === "/userinfo")
      return Response.json({
        sub: this.user.sub,
        email: this.user.email,
        email_verified: true,
        name: this.user.name,
      })
    return new Response("Not Found", { status: 404 })
  }

  private async githubToken(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/login/oauth/authorize") return this.authorize(request)
    if (url.pathname !== "/login/oauth/access_token")
      return new Response("Not Found", { status: 404 })
    const grant = this.grant(await this.form(request))
    if (grant === undefined)
      return Response.json({ error: "bad_verification_code" }, { status: 200 })
    return Response.json({
      access_token: `github-access-${this.codes}`,
      token_type: "bearer",
      scope: "read:user,user:email",
    })
  }

  private async githubApi(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/user")
      return Response.json({
        id: 4242,
        login: "octo",
        name: this.user.name,
        email: null,
        avatar_url: "https://avatars.example.com/u/4242",
      })
    if (url.pathname === "/user/emails")
      return Response.json([{ email: this.user.email, primary: true, verified: true }])
    return new Response("Not Found", { status: 404 })
  }

  async googleClientToken(expired = false): Promise<string> {
    return this.idToken(
      this.googleJwk,
      "https://accounts.google.com",
      {
        clientId: "google-client",
        nonce: "client-nonce",
        redirectUri: "",
      },
      expired,
    )
  }

  async clientToken(provider: "apple" | "acme" | "microsoft", nonce: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const tenant = "f3d06a89-8f1d-4c9a-8508-3cafe7c12af1"
    const issuers = {
      apple: "https://appleid.apple.com",
      acme: this.oidcIssuer,
      microsoft: `https://login.microsoftonline.com/${tenant}/v2.0`,
    }
    return new SignJWT({
      email: `${provider}@example.com`,
      name: "Provider User",
      email_verified: provider === "apple" ? "true" : true,
      nonce: provider === "apple" ? createHash("sha256").update(nonce).digest("hex") : nonce,
      ...(provider === "microsoft" ? { oid: "entra-object", tid: tenant } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "google-key-1" })
      .setIssuer(issuers[provider])
      .setAudience(`${provider}-client`)
      .setSubject(`${provider}-subject`)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(await importJWK(this.googleJwk, "RS256"))
  }

  private async googleToken(request: Request): Promise<Response> {
    const form = await this.form(request)
    if (form.get("grant_type") === "refresh_token") {
      const refresh = form.get("refresh_token")
      if (
        this.faults.refuseRefresh === true ||
        (refresh !== "google-refresh" && refresh !== "google-rotated")
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({
        access_token: refresh === "google-refresh" ? "google-refreshed" : "google-refreshed-again",
        ...(refresh === "google-refresh"
          ? { refresh_token: "google-rotated", refresh_token_expires_in: 600 }
          : {}),
        expires_in: 60,
        scope: "openid",
      })
    }
    const grant = this.grant(form)
    if (grant === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 })
    return Response.json({
      access_token: `google-access-${this.codes}`,
      id_token: await this.idToken(this.googleJwk, "https://accounts.google.com", grant),
      token_type: "Bearer",
      expires_in: 3599,
      ...(this.user.sub === "refresh-user" ? { refresh_token: "google-refresh" } : {}),
      scope: "openid email profile",
    })
  }
}

function publicOf(jwk: JWK): JWK {
  const { d, p, q, dp, dq, qi, ...rest } = jwk
  return rest
}
