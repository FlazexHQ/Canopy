import { expectStatus, signIn, signUpVerified } from "../flows.ts"
import type { CaseSpec } from "../harness.ts"

const PASSWORD = "correct horse battery 1"

/** The per address and per identifier limits. */
export const rateLimits: CaseSpec[] = [
  {
    id: "identifier-limit",
    description:
      "Eleven sign in attempts for one address from eleven client addresses within a minute: the eleventh is refused with retry-after; a minute later it is allowed again",
    async run(context) {
      await signUpVerified(context, context.client("owner"), "kay@example.com", PASSWORD)
      for (let attempt = 1; attempt <= 11; attempt++)
        await signIn(context, context.client(`device-${attempt}`), "kay@example.com", PASSWORD)
      context.clock.advance(61_000)
      expectStatus(
        await signIn(context, context.client("later"), "kay@example.com", PASSWORD),
        200,
        "sign in after the window",
      )
    },
  },
  {
    id: "failure-backoff",
    description:
      "After five failed sign ins every further failure locks the address for twice as long; while locked even the right password is refused",
    async run(context) {
      await signUpVerified(context, context.client("owner"), "lou@example.com", PASSWORD)
      for (let attempt = 1; attempt <= 7; attempt++) {
        await signIn(context, context.client(`guess-${attempt}`), "lou@example.com", "wrong 12345")
        context.clock.advance(1_000)
      }
      await signIn(context, context.client("owner-again"), "lou@example.com", PASSWORD)
      context.clock.advance(5_000)
      expectStatus(
        await signIn(context, context.client("owner-later"), "lou@example.com", PASSWORD),
        200,
        "sign in after the lock",
      )
    },
  },
  {
    id: "address-limit",
    description:
      "One client address signing in four times within ten seconds is refused by the engine's limit, and allowed again after the window",
    async run(context) {
      await signUpVerified(context, context.client("owner"), "mo@example.com", PASSWORD)
      const web = context.client("web")
      for (let attempt = 1; attempt <= 4; attempt++)
        await signIn(context, web, "mo@example.com", PASSWORD)
      context.clock.advance(11_000)
      expectStatus(await signIn(context, web, "mo@example.com", PASSWORD), 200, "sign in")
    },
  },
]

/** Refusals of the front of `/auth/v1`: routing, methods, bodies, origins and redirects. */
export const errors: CaseSpec[] = [
  {
    id: "routing-and-bodies",
    description:
      "Unknown and disabled routes, a path outside /auth/v1, a body over 64 KiB with and without a declared length, and the delete user route that is off",
    async run(context) {
      const web = context.client("web")
      const large = JSON.stringify({ email: "a@example.com", password: "x".repeat(70_000) })
      await context.send(web, "GET", "/auth/v1/nothing-here")
      await context.send(web, "GET", "/rest/v1/todos")
      await context.send(web, "POST", "/auth/v1/admin/list-users", {})
      await context.send(web, "POST", "/auth/v1/two-factor/send-otp", {})
      await context.send(web, "POST", "/auth/v1/sign-in/email", undefined, {
        raw: large,
        headers: { "content-length": String(large.length) },
      })
      await context.send(web, "POST", "/auth/v1/sign-in/email", undefined, { raw: large })
      await signUpVerified(context, web, "ola@example.com", PASSWORD)
      await context.send(web, "POST", "/auth/v1/delete-user", {})
    },
  },
  {
    id: "origins-and-cors",
    description:
      "Preflights from an allowed and a foreign origin, a cookie request from a foreign origin, and redirect targets outside the allowlist on sign up, password reset and verification",
    async run(context) {
      const anyone = context.client("anyone")
      await context.send(anyone, "OPTIONS", "/auth/v1/sign-in/email", undefined, {
        headers: { "access-control-request-method": "POST" },
      })
      anyone.origin = "https://evil.example"
      await context.send(anyone, "OPTIONS", "/auth/v1/sign-in/email", undefined, {
        headers: { "access-control-request-method": "POST" },
      })
      const web = context.client("web")
      await signUpVerified(context, web, "pia@example.com", PASSWORD)
      web.origin = "https://evil.example"
      await context.send(web, "POST", "/auth/v1/sign-out", {})
      web.origin = "https://app.canopy.test"
      await context.send(web, "GET", "/auth/v1/get-session")
      const stranger = context.client("stranger")
      await context.send(stranger, "POST", "/auth/v1/sign-up/email", {
        email: "qa@example.com",
        password: PASSWORD,
        name: "Qa",
        callbackURL: "https://evil.example/",
      })
      await context.send(stranger, "POST", "/auth/v1/request-password-reset", {
        email: "pia@example.com",
        redirectTo: "https://evil.example/",
      })
      await context.send(stranger, "POST", "/auth/v1/send-verification-email", {
        email: "pia@example.com",
        callbackURL: "//evil.example/",
      })
    },
  },
]
