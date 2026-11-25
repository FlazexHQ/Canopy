import { expectStatus, signUpVerified } from "../flows.ts"
import type { CaseContext, CaseSpec, Client } from "../harness.ts"

const HOME = "https://app.canopy.test/home"

/** Starts a sign in at a provider, consents there and follows the redirect back to the callback. */
async function viaProvider(
  context: CaseContext,
  client: Client,
  path: string,
  body: Record<string, unknown>,
): Promise<{ readonly callback: string | undefined }> {
  const started = await context.send(client, "POST", path, body)
  const url = started.json["url"]
  if (typeof url !== "string") {
    if (started.status === 200) throw new Error(`${path} answered without a URL: ${started.text}`)
    return { callback: undefined }
  }
  const authorization = new URL(url)
  for (const parameter of ["state", "code_challenge", "nonce"]) {
    const value = authorization.searchParams.get(parameter)
    if (value !== null) context.name(value, parameter.replace("_", "-"))
  }
  const consented = await context.visit(client, url)
  const callback = consented.location
  if (callback === undefined) throw new Error(`the provider did not redirect: ${consented.status}`)
  if (callback !== undefined) context.name(new URL(callback).searchParams.get("code") ?? "", "code")
  return { callback }
}

/** Sign in through GitHub and Google, whose endpoints the mock providers answer. */
export const social: CaseSpec[] = [
  {
    id: "github",
    description:
      "Signs in with GitHub (OAuth 2 with PKCE, the address from the emails API), lands on the callback, and a second sign in reuses the account",
    async run(context) {
      context.providers.user = { sub: "4242", email: "gh@example.com", name: "Octo Cat" }
      const web = context.client("web")
      const { callback } = await viaProvider(context, web, "/auth/v1/sign-in/social", {
        provider: "github",
        callbackURL: HOME,
      })
      if (callback === undefined) throw new Error("no callback from GitHub")
      await context.visit(web, callback)
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.send(web, "GET", "/auth/v1/token")
      const again = context.client("again")
      const second = await viaProvider(context, again, "/auth/v1/sign-in/social", {
        provider: "github",
        callbackURL: HOME,
      })
      if (second.callback === undefined) throw new Error("no callback from GitHub")
      await context.visit(again, second.callback)
      await context.send(web, "GET", "/auth/v1/list-accounts")
    },
  },
  {
    id: "google",
    description:
      "Signs in with Google: the ID token is verified (RS256, issuer, audience, nonce) and the account created",
    async run(context) {
      context.providers.user = { sub: "1093", email: "goo@example.com", name: "Goo Gle" }
      const web = context.client("web")
      const { callback } = await viaProvider(context, web, "/auth/v1/sign-in/social", {
        provider: "google",
        callbackURL: HOME,
      })
      if (callback === undefined) throw new Error("no callback from Google")
      await context.visit(web, callback)
      await context.send(web, "GET", "/auth/v1/get-session")
    },
  },
  {
    id: "social-link-and-unlink",
    description:
      "Links GitHub to a password user, refreshes the linked account, and requires a fresh session and a remaining account to unlink",
    async run(context) {
      const email = "link@example.com"
      const web = context.client("web")
      const stranger = context.client("stranger")
      const body = { provider: "github", callbackURL: HOME, disableRedirect: true }
      const start = "/auth/v1/link-social"
      const unlink = "/auth/v1/unlink-account"
      expectStatus(await context.send(stranger, "POST", start, body), 401, "link without session")
      expectStatus(
        await context.send(stranger, "POST", unlink, { accountId: "unknown" }),
        401,
        "unlink without session",
      )
      await signUpVerified(context, web, email, "correct horse battery 1")
      expectStatus(
        await context.send(web, "POST", unlink, { accountId: "unknown" }),
        400,
        "last account",
      )
      context.providers.user = { sub: "4242", email, name: "Octo Cat" }
      for (const scopes of [["read:org"], ["repo"]]) {
        const { callback } = await viaProvider(context, web, start, { ...body, scopes })
        if (callback === undefined) throw new Error("no link callback from GitHub")
        if (scopes.includes("read:org"))
          expectStatus(await context.visit(stranger, callback), 302, "foreign state cookie")
        const linked = await context.visit(web, callback)
        if (linked.location !== HOME) throw new Error(`link failed: ${linked.location}`)
      }
      const listed = await context.send(web, "GET", "/auth/v1/list-accounts")
      const accounts = JSON.parse(listed.text) as { id: string; providerId: string }[]
      const github = accounts.find((account) => account.providerId === "github")
      const credential = accounts.find((account) => account.providerId === "credential")
      if (github === undefined || credential === undefined)
        throw new Error("the password and linked GitHub accounts must both be listed")
      expectStatus(
        await context.send(web, "POST", unlink, { accountId: "unknown" }),
        400,
        "account not found",
      )
      const other = context.client("other")
      await signUpVerified(context, other, "other@example.com", "correct horse battery 1")
      const mismatch = await viaProvider(context, other, start, body)
      if (mismatch.callback === undefined) throw new Error("no mismatch callback from GitHub")
      const mismatchReply = await context.visit(other, mismatch.callback)
      if (!mismatchReply.location?.endsWith("?error=email_does_not_match"))
        throw new Error(`email mismatch was accepted: ${mismatchReply.location}`)
      context.providers.user = { sub: "4242", email: "other@example.com", name: "Octo Cat" }
      const owned = await viaProvider(context, other, start, body)
      if (owned.callback === undefined) throw new Error("no account ownership callback from GitHub")
      const ownedReply = await context.visit(other, owned.callback)
      if (!ownedReply.location?.endsWith("?error=account_already_linked_to_different_user"))
        throw new Error(`foreign account was accepted: ${ownedReply.location}`)
      expectStatus(
        await context.send(web, "POST", unlink, { accountId: credential.id }),
        200,
        "unlink",
      )
      await context.send(web, "GET", "/auth/v1/list-accounts")
      context.clock.advance(900_000)
      expectStatus(
        await context.send(web, "POST", unlink, { accountId: github.id }),
        403,
        "stale session",
      )
    },
  },
  {
    id: "oauth-error-page",
    description: "Renders the OAuth error code and escapes the provider description as HTML",
    async run(context) {
      const query = new URLSearchParams({
        error: "access_denied",
        error_description: '<script>alert(1)</script> & "denied"',
      })
      expectStatus(
        await context.send(context.client("web"), "GET", `/auth/v1/error?${query}`),
        200,
        "error page",
      )
    },
  },
  {
    id: "social-refusals",
    description:
      "A foreign callback is refused before leaving; a callback with a state of another browser, an unknown provider, and a code the provider refuses end on the error page",
    async run(context) {
      await context.send(context.client("phished"), "POST", "/auth/v1/sign-in/social", {
        provider: "github",
        callbackURL: "https://evil.example/",
      })
      await context.send(context.client("lost"), "POST", "/auth/v1/sign-in/social", {
        provider: "myspace",
        callbackURL: HOME,
      })
      const web = context.client("web")
      const { callback } = await viaProvider(context, web, "/auth/v1/sign-in/social", {
        provider: "github",
        callbackURL: HOME,
      })
      if (callback === undefined) throw new Error("no callback from GitHub")
      await context.visit(context.client("other-browser"), callback)
      context.providers.faults.refuseCode = true
      const refusedBrowser = context.client("refused")
      const refused = await viaProvider(context, refusedBrowser, "/auth/v1/sign-in/social", {
        provider: "github",
        callbackURL: HOME,
      })
      if (refused.callback === undefined) throw new Error("no callback from GitHub")
      await context.visit(refusedBrowser, refused.callback)
    },
  },
]

/** A generic OpenID Connect provider configured through discovery. */
export const oidc: CaseSpec[] = [
  {
    id: "generic-oidc-link",
    description: "Links a discovery configured provider to the signed in user",
    async run(context) {
      const web = context.client("web")
      const email = "oidc-link@example.com"
      await signUpVerified(context, web, email, "correct horse battery 1")
      context.providers.user = { sub: "oidc-link", email, name: "OIDC Link" }
      const { callback } = await viaProvider(context, web, "/auth/v1/link-social", {
        provider: "acme",
        callbackURL: HOME,
      })
      if (callback === undefined) throw new Error("no link callback from the provider")
      const linked = await context.visit(web, callback)
      if (linked.location !== HOME) throw new Error(`link failed: ${linked.location}`)
      await context.send(web, "GET", "/auth/v1/list-accounts")
    },
  },
  {
    id: "generic-oidc",
    description:
      "Signs in through the discovery configured provider (started like a social provider) with PKCE, state and nonce, and lands on the callback with a session",
    async run(context) {
      const web = context.client("web")
      const { callback } = await viaProvider(context, web, "/auth/v1/sign-in/social", {
        provider: "acme",
        callbackURL: HOME,
      })
      if (callback === undefined) throw new Error("no callback from the provider")
      expectStatus(await context.visit(web, callback), 302, "callback")
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.send(web, "GET", "/auth/v1/token")
    },
  },
  {
    id: "id-token-refusals",
    description:
      "An ID token with another nonce and one for another client are refused, ending on the error page without a session",
    async run(context) {
      for (const fault of ["wrongNonce", "wrongAudience"] as const) {
        context.providers.faults.wrongNonce = fault === "wrongNonce"
        context.providers.faults.wrongAudience = fault === "wrongAudience"
        const web = context.client(fault)
        const { callback } = await viaProvider(context, web, "/auth/v1/sign-in/social", {
          provider: "acme",
          callbackURL: HOME,
        })
        if (callback === undefined) throw new Error("no callback from the provider")
        await context.visit(web, callback)
        await context.send(web, "GET", "/auth/v1/get-session")
      }
    },
  },
]
