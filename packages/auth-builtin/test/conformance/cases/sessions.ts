import { expectStatus, linkOf, signIn, signUpVerified } from "../flows.ts"
import type { CaseSpec } from "../harness.ts"

const PASSWORD = "correct horse battery 1"
const DAY = 86_400_000

/** Listing, refreshing, expiring and revoking sessions, and profile changes. */
export const sessions: CaseSpec[] = [
  {
    id: "list-and-revoke",
    description:
      "Three devices: lists the sessions, revokes one by token, then every other session, then all of them",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "pat@example.com", PASSWORD)
      const phone = context.client("phone")
      const tablet = context.client("tablet")
      const laptop = context.client("laptop")
      for (const device of [phone, tablet, laptop])
        expectStatus(await signIn(context, device, "pat@example.com", PASSWORD), 200, "sign in")
      const listed = await context.send(web, "GET", "/auth/v1/list-sessions")
      const sessions = JSON.parse(listed.text) as { token: string }[]
      const phoneToken = decodeURIComponent(
        phone.cookies.get("__Secure-canopy.session_token") ?? "",
      )
      const target = sessions.find((session) => phoneToken.startsWith(`${session.token}.`))
      if (target === undefined) throw new Error("the phone's session is not listed")
      await context.send(web, "POST", "/auth/v1/revoke-session", { token: target.token })
      await context.send(phone, "GET", "/auth/v1/get-session")
      await context.send(web, "POST", "/auth/v1/revoke-other-sessions", {})
      await context.send(tablet, "GET", "/auth/v1/get-session")
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.send(web, "POST", "/auth/v1/revoke-sessions", {})
      await context.send(web, "GET", "/auth/v1/get-session")
    },
  },
  {
    id: "refresh-and-expiry",
    description:
      "A session used after the update age is extended by seven days from then and its cookie is set again; one left unused past its expiry is gone",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "quin@example.com", PASSWORD)
      context.clock.advance(DAY / 2)
      await context.send(web, "GET", "/auth/v1/get-session")
      context.clock.advance(DAY)
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.send(web, "GET", "/auth/v1/token")
      context.clock.advance(8 * DAY)
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.send(web, "GET", "/auth/v1/token")
    },
  },
  {
    id: "update-user-and-change-email",
    description:
      "Updates the name and user metadata (app metadata and roles are not writable), then changes the email address through the confirmation sent to the current one",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "rae@example.com", PASSWORD)
      await context.send(web, "POST", "/auth/v1/update-user", {
        name: "Rae Q",
        userMetadata: { theme: "dark" },
      })
      await context.send(web, "POST", "/auth/v1/update-user", {
        appMetadata: { plan: "pro" },
        roles: ["admin"],
      })
      await context.send(web, "GET", "/auth/v1/get-session")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/change-email",
        { newEmail: "rae.new@example.com", callbackURL: "/settings" },
        { mails: 1 },
      )
      const link = linkOf((await context.mails(before, 1))[0])
      await context.visit(web, link, { mails: 1 })
      await context.send(web, "GET", "/auth/v1/get-session")
    },
  },
]

/** Bearer sessions for clients without cookies. */
export const bearer: CaseSpec[] = [
  {
    id: "bearer-session",
    description:
      "A native app signs in, receives the session in set-auth-token, uses it as a bearer token for the session, the access token and the session list, then signs out; a forged bearer token finds no session",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "sam@example.com", PASSWORD)
      const app = context.client("app", "bearer")
      expectStatus(await signIn(context, app, "sam@example.com", PASSWORD), 200, "sign in")
      await context.send(app, "GET", "/auth/v1/get-session")
      await context.send(app, "GET", "/auth/v1/token")
      await context.send(app, "GET", "/auth/v1/list-sessions")
      const forged = context.client("forger", "bearer")
      forged.bearer = context.name(
        `${app.bearer?.slice(0, 10) ?? ""}AAAAAAAAAAAAAAAAAAAAAA`,
        "forged-bearer",
      )
      await context.send(forged, "GET", "/auth/v1/get-session")
      await context.send(forged, "GET", "/auth/v1/token")
      await context.send(app, "POST", "/auth/v1/sign-out", {})
      await context.send(app, "GET", "/auth/v1/get-session")
    },
  },
]

/** Access tokens, the key set and the settings. */
export const tokens: CaseSpec[] = [
  {
    id: "eddsa-token-and-jwks",
    description:
      "Mints an EdDSA access token, serves the key set on its three paths (the standby key included), refuses other methods on it, answers /token without a session, and describes the enabled methods",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "tia@example.com", PASSWORD)
      await context.send(web, "GET", "/auth/v1/token")
      const anyone = context.client("anyone")
      anyone.origin = undefined
      await context.send(anyone, "GET", "/.well-known/jwks.json")
      await context.send(anyone, "GET", "/auth/v1/jwks")
      await context.send(anyone, "GET", "/auth/v1/.well-known/jwks.json")
      await context.send(anyone, "POST", "/auth/v1/jwks", {})
      await context.send(anyone, "GET", "/auth/v1/token")
      await context.send(anyone, "GET", "/auth/v1/settings")
    },
  },
  {
    id: "es256-token",
    description: "With ES256 configured, the access token and the key set use P-256 keys",
    options: { algorithm: "ES256", accessTokenTtlSeconds: 900 },
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "uma@example.com", PASSWORD)
      await context.send(web, "GET", "/auth/v1/token")
      const anyone = context.client("anyone")
      anyone.origin = undefined
      await context.send(anyone, "GET", "/.well-known/jwks.json")
    },
  },
]

/** Anonymous users, upgrading them and linking them to a new account. */
export const anonymous: CaseSpec[] = [
  {
    id: "anonymous-upgrade",
    description:
      "Signs in anonymously, mints an anonymous token, upgrades in place with an email and a password (sub is kept), verifies the address and signs in with the password",
    async run(context) {
      const web = context.client("web")
      await context.send(web, "POST", "/auth/v1/sign-in/anonymous", {})
      await context.send(web, "GET", "/auth/v1/token")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/upgrade",
        { email: "Vic@Example.com", password: PASSWORD, callbackURL: "/welcome" },
        { mails: 1 },
      )
      await context.send(web, "GET", "/auth/v1/token")
      await context.visit(web, linkOf((await context.mails(before, 1))[0]))
      expectStatus(
        await signIn(context, context.client("later"), "vic@example.com", PASSWORD),
        200,
        "sign in after the upgrade",
      )
    },
  },
  {
    id: "upgrade-refusals",
    description:
      "An upgrade to a taken address answers like any other and changes nothing; an invalid address, a short password, a foreign callback, no session and a permanent user are refused",
    async run(context) {
      const owner = context.client("owner")
      await signUpVerified(context, owner, "wes@example.com", PASSWORD)
      const web = context.client("web")
      await context.send(web, "POST", "/auth/v1/sign-in/anonymous", {})
      await context.send(web, "POST", "/auth/v1/upgrade", { email: "wes@example.com" })
      await context.send(web, "POST", "/auth/v1/upgrade", { email: "not an address" })
      await context.send(web, "POST", "/auth/v1/upgrade", {
        email: "fresh@example.com",
        password: "short",
      })
      await context.send(web, "POST", "/auth/v1/upgrade", {
        email: "fresh@example.com",
        callbackURL: "https://evil.example/",
      })
      await context.send(web, "POST", "/auth/v1/upgrade", undefined, { raw: "{" })
      await context.send(context.client("nobody"), "POST", "/auth/v1/upgrade", {
        email: "fresh@example.com",
      })
      await context.send(owner, "POST", "/auth/v1/upgrade", { email: "fresh@example.com" })
    },
  },
  {
    id: "anonymous-link-on-sign-in",
    description:
      "An anonymous browser signs in to an existing account: the anonymous user is linked and removed",
    async run(context) {
      const owner = context.client("owner")
      await signUpVerified(context, owner, "xia@example.com", PASSWORD)
      const web = context.client("web")
      await context.send(web, "POST", "/auth/v1/sign-in/anonymous", {})
      expectStatus(await signIn(context, web, "xia@example.com", PASSWORD), 200, "sign in")
      await context.send(web, "GET", "/auth/v1/get-session")
      const other = context.client("other")
      await context.send(other, "POST", "/auth/v1/sign-in/anonymous", {})
      await context.send(other, "POST", "/auth/v1/delete-anonymous-user", {})
      await context.send(other, "GET", "/auth/v1/get-session")
    },
  },
  {
    id: "anonymous-disabled",
    description: "With anonymous users off, the routes are not served",
    options: { anonymous: false },
    async run(context) {
      await context.send(context.client("web"), "POST", "/auth/v1/sign-in/anonymous", {})
    },
  },
]
