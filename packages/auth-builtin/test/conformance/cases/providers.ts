import { expectStatus } from "../flows.ts"
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
