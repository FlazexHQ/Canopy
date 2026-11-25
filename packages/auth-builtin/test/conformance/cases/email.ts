import { expectStatus, linkOf, otpOf, signIn, signUpVerified } from "../flows.ts"
import type { CaseSpec } from "../harness.ts"

const PASSWORD = "correct horse battery 1"

/** Email and password: sign up, verification, sign in and sign out. */
export const emailPassword: CaseSpec[] = [
  {
    id: "sign-up-verify-sign-in-sign-out",
    description:
      "Signs up (the answer does not reveal the account), follows the verification link (which signs in), reads the session, signs out, then signs in again with the password",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "ada@example.com", PASSWORD)
      await context.send(web, "GET", "/auth/v1/get-session")
      expectStatus(await context.send(web, "POST", "/auth/v1/sign-out", {}), 200, "sign out")
      await context.send(web, "GET", "/auth/v1/get-session")
      expectStatus(await signIn(context, web, "ada@example.com", PASSWORD), 200, "sign in")
      await context.send(web, "GET", "/auth/v1/get-session")
    },
  },
  {
    id: "sign-up-taken-and-unverified",
    description:
      "A second sign up for a taken address answers like the first; signing in before verifying is refused",
    async run(context) {
      const web = context.client("web")
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-up/email",
        { email: "bob@example.com", password: PASSWORD, name: "Bob" },
        { mails: 1 },
      )
      await context.send(context.client("other"), "POST", "/auth/v1/sign-up/email", {
        email: "bob@example.com",
        password: "another password 22",
        name: "Mallory",
      })
      await signIn(context, web, "bob@example.com", PASSWORD)
    },
  },
  {
    id: "sign-in-refusals",
    description:
      "Wrong password, unknown address, missing fields, a password below the minimum at sign up, and a JSON body that does not parse",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "cy@example.com", PASSWORD)
      const other = context.client("other")
      await signIn(context, other, "cy@example.com", "wrong password 123")
      await signIn(context, context.client("third"), "nobody@example.com", PASSWORD)
      await context.send(context.client("fourth"), "POST", "/auth/v1/sign-in/email", {
        email: "cy@example.com",
      })
      await context.send(context.client("fifth"), "POST", "/auth/v1/sign-up/email", {
        email: "short@example.com",
        password: "short",
        name: "Short",
      })
      await context.send(context.client("sixth"), "POST", "/auth/v1/sign-in/email", undefined, {
        raw: "{not json",
      })
    },
  },
  {
    id: "sign-up-without-verification",
    description:
      "With email verification not required, sign up answers with the user and a session at once, and remember me off sets the dont_remember cookie",
    options: { emailPassword: { requireEmailVerification: false } },
    async run(context) {
      const web = context.client("web")
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-up/email",
        { email: "dee@example.com", password: PASSWORD, name: "Dee" },
        { mails: 1 },
      )
      await context.send(web, "GET", "/auth/v1/get-session")
      const other = context.client("other")
      await context.send(other, "POST", "/auth/v1/sign-in/email", {
        email: "dee@example.com",
        password: PASSWORD,
        rememberMe: false,
      })
      await context.send(other, "GET", "/auth/v1/get-session")
    },
  },
]

/** Email verification on its own. */
export const emailVerification: CaseSpec[] = [
  {
    id: "resend-and-verify",
    description:
      "Asks for the verification email again, then follows the link with a tampered token, the real token, and the real token once more",
    async run(context) {
      const web = context.client("web")
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-up/email",
        { email: "eve@example.com", password: PASSWORD, name: "Eve" },
        { mails: 1 },
      )
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/send-verification-email",
        { email: "eve@example.com", callbackURL: "/welcome" },
        { mails: 1 },
      )
      const link = linkOf((await context.mails(before, 1))[0])
      const tampered = new URL(link)
      const token = tampered.searchParams.get("token") ?? ""
      context.name(`${token.slice(token.lastIndexOf(".") + 1)}x`, "tampered-signature")
      tampered.searchParams.set("token", `${token}x`)
      await context.visit(web, tampered.toString())
      await context.visit(web, link)
      await context.visit(context.client("again"), link)
    },
  },
  {
    id: "expired-link",
    description: "A verification link followed after an hour is refused",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-up/email",
        { email: "fay@example.com", password: PASSWORD, name: "Fay" },
        { mails: 1 },
      )
      const link = linkOf((await context.mails(before, 1))[0])
      context.clock.advance(3_601_000)
      await context.visit(web, link)
    },
  },
]

/** Password reset through a link and password changes. */
export const passwordReset: CaseSpec[] = [
  {
    id: "reset-through-link",
    description:
      "Requests a reset for a known and an unknown address (same answer), follows the link to the callback, resets, which ends every session, signs in with the new password and fails to reuse the token",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "gil@example.com", PASSWORD)
      const phone = context.client("phone")
      await signIn(context, phone, "gil@example.com", PASSWORD)
      const before = context.outbox.length
      await context.send(
        context.client("forgetful"),
        "POST",
        "/auth/v1/request-password-reset",
        { email: "gil@example.com", redirectTo: "https://app.canopy.test/reset" },
        { mails: 1 },
      )
      await context.send(context.client("prober"), "POST", "/auth/v1/request-password-reset", {
        email: "nobody@example.com",
        redirectTo: "https://app.canopy.test/reset",
      })
      const link = linkOf((await context.mails(before, 1))[0])
      const landing = await context.visit(context.client("forgetful-browser"), link)
      const token = new URL(landing.location ?? "", "https://app.canopy.test").searchParams.get(
        "token",
      )
      if (token === null) throw new Error("the reset redirect carries no token")
      const browser = context.client("reset-page")
      await context.send(browser, "POST", "/auth/v1/reset-password", {
        newPassword: "new password 4567",
        token,
      })
      await context.send(phone, "GET", "/auth/v1/get-session")
      await signIn(context, context.client("after"), "gil@example.com", "new password 4567")
      await context.send(context.client("replay"), "POST", "/auth/v1/reset-password", {
        newPassword: "third password 89",
        token,
      })
    },
  },
  {
    id: "change-password",
    description:
      "Changes the password with the current one, revoking the other sessions; a wrong current password is refused",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "hal@example.com", PASSWORD)
      const phone = context.client("phone")
      await signIn(context, phone, "hal@example.com", PASSWORD)
      await context.send(web, "POST", "/auth/v1/change-password", {
        currentPassword: "not the password 1",
        newPassword: "changed password 22",
      })
      await context.send(web, "POST", "/auth/v1/change-password", {
        currentPassword: PASSWORD,
        newPassword: "changed password 22",
        revokeOtherSessions: true,
      })
      await context.send(phone, "GET", "/auth/v1/get-session")
      await context.send(web, "GET", "/auth/v1/get-session")
    },
  },
]

/** Magic links. */
export const magicLink: CaseSpec[] = [
  {
    id: "sign-in-once",
    description:
      "Sends a magic link to a new address, follows it (creating the user, landing on the callback), and fails to follow it again",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-in/magic-link",
        { email: "ivy@example.com", callbackURL: "https://app.canopy.test/home" },
        { mails: 1 },
      )
      const link = linkOf((await context.mails(before, 1))[0])
      await context.visit(web, link)
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.visit(context.client("replay"), link)
    },
  },
  {
    id: "expired-and-foreign-callback",
    description:
      "A link followed after 15 minutes is refused, and a callback outside the allowlist is refused when the link is requested",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-in/magic-link",
        { email: "jo@example.com", callbackURL: "/home" },
        { mails: 1 },
      )
      const link = linkOf((await context.mails(before, 1))[0])
      context.clock.advance(901_000)
      await context.visit(web, link)
      await context.send(context.client("phisher"), "POST", "/auth/v1/sign-in/magic-link", {
        email: "jo@example.com",
        callbackURL: "https://evil.example/steal",
      })
    },
  },
]

/** Email one time passwords. */
export const emailOtp: CaseSpec[] = [
  {
    id: "sign-in-with-code",
    description: "Sends a sign in code, signs in with it, and fails to use it again",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/email-otp/send-verification-otp",
        { email: "kim@example.com", type: "sign-in" },
        { mails: 1 },
      )
      const otp = otpOf(context, (await context.mails(before, 1))[0])
      await context.send(web, "POST", "/auth/v1/sign-in/email-otp", {
        email: "kim@example.com",
        otp,
      })
      await context.send(web, "GET", "/auth/v1/get-session")
      await context.send(context.client("replay"), "POST", "/auth/v1/sign-in/email-otp", {
        email: "kim@example.com",
        otp,
      })
    },
  },
  {
    id: "three-wrong-codes",
    description: "Three wrong codes use up the attempts, so the right code is refused afterwards",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/email-otp/send-verification-otp",
        { email: "lee@example.com", type: "sign-in" },
        { mails: 1 },
      )
      const otp = otpOf(context, (await context.mails(before, 1))[0])
      const wrong = otp === "000000" ? "111111" : "000000"
      for (const attempt of ["first", "second", "third"])
        await context.send(context.client(attempt), "POST", "/auth/v1/sign-in/email-otp", {
          email: "lee@example.com",
          otp: wrong,
        })
      await context.send(web, "POST", "/auth/v1/sign-in/email-otp", {
        email: "lee@example.com",
        otp,
      })
    },
  },
  {
    id: "expired-code",
    description: "A code used after five minutes is refused",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/email-otp/send-verification-otp",
        { email: "max@example.com", type: "sign-in" },
        { mails: 1 },
      )
      const otp = otpOf(context, (await context.mails(before, 1))[0])
      context.clock.advance(301_000)
      await context.send(web, "POST", "/auth/v1/sign-in/email-otp", {
        email: "max@example.com",
        otp,
      })
    },
  },
  {
    id: "verify-email-with-code",
    description: "Verifies the address of a new password user with an emailed code",
    async run(context) {
      const web = context.client("web")
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-up/email",
        { email: "ned@example.com", password: PASSWORD, name: "Ned" },
        { mails: 1 },
      )
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/email-otp/send-verification-otp",
        { email: "ned@example.com", type: "email-verification" },
        { mails: 1 },
      )
      const otp = otpOf(context, (await context.mails(before, 1))[0])
      await context.send(web, "POST", "/auth/v1/email-otp/check-verification-otp", {
        email: "ned@example.com",
        type: "email-verification",
        otp,
      })
      await context.send(web, "POST", "/auth/v1/email-otp/verify-email", {
        email: "ned@example.com",
        otp,
      })
      await context.send(web, "GET", "/auth/v1/get-session")
    },
  },
  {
    id: "reset-password-with-code",
    description: "Resets a password with an emailed code and signs in with the new password",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "oz@example.com", PASSWORD)
      const before = context.outbox.length
      await context.send(
        context.client("forgetful"),
        "POST",
        "/auth/v1/email-otp/request-password-reset",
        { email: "oz@example.com" },
        { mails: 1 },
      )
      const otp = otpOf(context, (await context.mails(before, 1))[0])
      await context.send(context.client("forgetful"), "POST", "/auth/v1/email-otp/reset-password", {
        email: "oz@example.com",
        otp,
        password: "reset by code 1234",
      })
      expectStatus(
        await signIn(context, context.client("after"), "oz@example.com", "reset by code 1234"),
        200,
        "sign in after the reset",
      )
    },
  },
]
