import { base32, expectStatus, signIn, signUpVerified, totp } from "../flows.ts"
import { APP_ORIGIN, type CaseContext, type CaseSpec, type Client, type Json } from "../harness.ts"
import { type CredentialJson, type Faults, SoftwareAuthenticator } from "../webauthn.ts"

const PASSWORD = "correct horse battery 1"

/** The authenticators of the passkey cases; the manifest of the fixture lists the same ones. */
export const AUTHENTICATORS = {
  synced: new SoftwareAuthenticator({
    name: "synced",
    algorithm: "ES256",
    attestation: "none",
    seed: "canopy auth oracle synced passkey",
    counting: false,
    backedUp: true,
  }),
  device: new SoftwareAuthenticator({
    name: "device",
    algorithm: "EdDSA",
    attestation: "packed",
    seed: "canopy auth oracle device passkey",
    counting: true,
    backedUp: false,
  }),
} as const

async function enrolTotp(
  context: CaseContext,
  web: Client,
): Promise<{ secret: Buffer; backupCodes: string[] }> {
  const enabled = await context.send(web, "POST", "/auth/v1/two-factor/enable", {
    password: PASSWORD,
  })
  expectStatus(enabled, 200, "enable two factor")
  const uri = new URL(String(enabled.json["totpURI"]))
  const encoded = uri.searchParams.get("secret") ?? ""
  context.name(encoded, "totp-secret")
  const backupCodes = (enabled.json["backupCodes"] as string[]).map((code) =>
    context.name(code, "backup-code"),
  )
  const secret = base32(encoded)
  await verifyTotp(context, web, secret)
  return { secret, backupCodes }
}

async function verifyTotp(
  context: CaseContext,
  client: Client,
  secret: Buffer,
  headers: Record<string, string> = {},
) {
  const code = context.name(totp(secret, context.clock.now()), "totp")
  return context.send(
    client,
    "POST",
    "/auth/v1/two-factor/verify-totp",
    { code },
    { headers, details: { totpStep: Math.floor(context.clock.now() / 30_000) } },
  )
}

/** TOTP enrolment, second factor sign in and backup codes. */
export const twoFactor: CaseSpec[] = [
  {
    id: "enrol-and-sign-in",
    description:
      "Enrols TOTP (the first code confirms it), then a browser sign in stops at the second factor, a wrong code is refused, and the right code creates an aal2 session",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "ana@example.com", PASSWORD)
      await context.send(web, "GET", "/auth/v1/token")
      const { secret } = await enrolTotp(context, web)
      await context.send(web, "GET", "/auth/v1/token")
      context.clock.advance(60_000)
      const browser = context.client("browser")
      expectStatus(await signIn(context, browser, "ana@example.com", PASSWORD), 200, "sign in")
      await context.send(browser, "GET", "/auth/v1/token")
      await context.send(browser, "POST", "/auth/v1/two-factor/verify-totp", { code: "000000" })
      await verifyTotp(context, browser, secret)
      await context.send(browser, "GET", "/auth/v1/token")
    },
  },
  {
    id: "bearer-ceremony-and-backup-codes",
    description:
      "A bearer client carries the second factor ceremony in headers (a forged ceremony header is ignored; without an Origin header the bridged cookie is refused), then another sign in completes with a backup code that cannot be used twice; new backup codes and the TOTP URI need the password; disabling two factor",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "ben@example.com", PASSWORD)
      const { secret, backupCodes } = await enrolTotp(context, web)
      context.clock.advance(60_000)
      const app = context.client("app", "bearer")
      expectStatus(await signIn(context, app, "ben@example.com", PASSWORD), 200, "sign in")
      const ceremony = app.ceremony ?? ""
      await verifyTotp(context, app, secret)
      await verifyTotp(context, app, secret, {
        "x-canopy-ceremony": "canopy.session_token=stolen; other=1",
      })
      await verifyTotp(context, app, secret, { "x-canopy-ceremony": ceremony })
      await context.send(app, "GET", "/auth/v1/token")
      const native = context.client("native", "bearer")
      native.origin = undefined
      expectStatus(await signIn(context, native, "ben@example.com", PASSWORD), 200, "sign in")
      await verifyTotp(context, native, secret, { "x-canopy-ceremony": native.ceremony ?? "" })
      const second = context.client("second", "bearer")
      expectStatus(await signIn(context, second, "ben@example.com", PASSWORD), 200, "sign in")
      const code = backupCodes[0] ?? ""
      await context.send(
        second,
        "POST",
        "/auth/v1/two-factor/verify-backup-code",
        { code },
        { headers: { "x-canopy-ceremony": second.ceremony ?? "" } },
      )
      const third = context.client("third", "bearer")
      expectStatus(await signIn(context, third, "ben@example.com", PASSWORD), 200, "sign in")
      await context.send(
        third,
        "POST",
        "/auth/v1/two-factor/verify-backup-code",
        { code },
        { headers: { "x-canopy-ceremony": third.ceremony ?? "" } },
      )
      const regenerated = await context.send(
        web,
        "POST",
        "/auth/v1/two-factor/generate-backup-codes",
        { password: PASSWORD },
      )
      for (const fresh of (regenerated.json["backupCodes"] as string[] | undefined) ?? [])
        context.name(fresh, "backup-code")
      await context.send(web, "POST", "/auth/v1/two-factor/get-totp-uri", {
        password: "wrong password 123",
      })
      await context.send(web, "POST", "/auth/v1/two-factor/get-totp-uri", { password: PASSWORD })
      await context.send(web, "POST", "/auth/v1/two-factor/disable", { password: PASSWORD })
      expectStatus(
        await signIn(context, context.client("after"), "ben@example.com", PASSWORD),
        200,
        "sign in without a second factor",
      )
    },
  },
  {
    id: "passwordless-cannot-enrol",
    description:
      "A session from a magic link has no password, so enrolling TOTP is refused whatever password is sent",
    async run(context) {
      const web = context.client("web")
      const before = context.outbox.length
      await context.send(
        web,
        "POST",
        "/auth/v1/sign-in/magic-link",
        { email: "cal@example.com", callbackURL: "/" },
        { mails: 1 },
      )
      const [mail] = await context.mails(before, 1)
      const link = /https?:\/\/\S+/.exec(mail?.text ?? "")?.[0] ?? ""
      await context.visit(web, link)
      await context.send(web, "POST", "/auth/v1/two-factor/enable", {})
      await context.send(web, "POST", "/auth/v1/two-factor/enable", { password: "guess pass 1234" })
    },
  },
]

function decoded(credential: CredentialJson, authenticator: SoftwareAuthenticator): Json {
  const response = credential.response
  const clientData = JSON.parse(
    Buffer.from(String(response["clientDataJSON"]), "base64url").toString("utf8"),
  ) as Json
  const data = Buffer.from(
    String(response["authenticatorData"] ?? response["attestationObject"]),
    "base64url",
  )
  return {
    authenticator: authenticator.options.name,
    clientData,
    ...(response["authenticatorData"] === undefined
      ? { attestation: authenticator.options.attestation }
      : {
          authenticatorData: {
            rpIdHash: data.subarray(0, 32).toString("hex"),
            flags: data[32] ?? 0,
            signCount: data.readUInt32BE(33),
          },
        }),
  }
}

async function register(
  context: CaseContext,
  web: Client,
  authenticator: SoftwareAuthenticator,
  name: string,
  faults: Faults = {},
) {
  const options = await context.send(web, "GET", "/auth/v1/passkey/generate-register-options")
  expectStatus(options, 200, "registration options")
  const challenge = context.name(String(options.json["challenge"]), "challenge")
  const user = options.json["user"] as { id: string }
  context.name(user.id, "webauthn-user-id")
  const rp = options.json["rp"] as { id: string }
  const credential = authenticator.register({ challenge, rpId: rp.id }, APP_ORIGIN, faults)
  context.name(String(credential.response["clientDataJSON"]), "client-data-json")
  if (authenticator.options.attestation === "packed")
    context.name(String(credential.response["attestationObject"]), "attestation-object")
  return context.send(
    web,
    "POST",
    "/auth/v1/passkey/verify-registration",
    { response: credential, name },
    { details: decoded(credential, authenticator) },
  )
}

async function authenticate(
  context: CaseContext,
  client: Client,
  authenticator: SoftwareAuthenticator,
  userHandle: string,
  faults: Faults = {},
) {
  const options = await context.send(
    client,
    "GET",
    "/auth/v1/passkey/generate-authenticate-options",
  )
  expectStatus(options, 200, "authentication options")
  const challenge = context.name(String(options.json["challenge"]), "challenge")
  const rpId = String(options.json["rpId"] ?? new URL(APP_ORIGIN).hostname)
  const credential = authenticator.authenticate({ challenge, rpId }, APP_ORIGIN, userHandle, faults)
  context.name(String(credential.response["clientDataJSON"]), "client-data-json")
  context.name(String(credential.response["signature"]), "assertion-signature")
  return context.send(
    client,
    "POST",
    "/auth/v1/passkey/verify-authentication",
    { response: credential },
    {
      details: decoded(credential, authenticator),
      headers: client.mode === "bearer" ? { "x-canopy-ceremony": client.ceremony ?? "" } : {},
    },
  )
}

async function userHandleOf(context: CaseContext, web: Client): Promise<string> {
  const options = await context.send(web, "GET", "/auth/v1/passkey/generate-register-options")
  return context.name(String((options.json["user"] as { id: string }).id), "webauthn-user-id")
}

/** Passkey registration, sign in and management. */
export const passkeys: CaseSpec[] = [
  {
    id: "register-and-sign-in",
    description:
      "Registers a synced ES256 passkey with no attestation and a device bound EdDSA passkey with packed self attestation, lists, renames and signs in with each (aal2 sessions), then deletes one",
    async run(context) {
      AUTHENTICATORS.device.reset()
      const web = context.client("web")
      await signUpVerified(context, web, "dot@example.com", PASSWORD)
      expectStatus(await register(context, web, AUTHENTICATORS.synced, "Phone"), 200, "register")
      expectStatus(await register(context, web, AUTHENTICATORS.device, "Laptop"), 200, "register")
      const listed = await context.send(web, "GET", "/auth/v1/passkey/list-user-passkeys")
      const keys = JSON.parse(listed.text) as { id: string; credentialID: string }[]
      const device = keys.find((key) => key.credentialID === AUTHENTICATORS.device.id)
      if (device === undefined) throw new Error("the device passkey is not listed")
      await context.send(web, "POST", "/auth/v1/passkey/update-passkey", {
        id: device.id,
        name: "Work laptop",
      })
      const handle = await userHandleOf(context, web)
      const browser = context.client("browser")
      await authenticate(context, browser, AUTHENTICATORS.synced, handle)
      await context.send(browser, "GET", "/auth/v1/token")
      const app = context.client("app", "bearer")
      await authenticate(context, app, AUTHENTICATORS.device, handle)
      await context.send(app, "GET", "/auth/v1/token")
      await context.send(web, "POST", "/auth/v1/passkey/delete-passkey", { id: device.id })
      await context.send(web, "GET", "/auth/v1/passkey/list-user-passkeys")
    },
  },
  {
    id: "ceremony-refusals",
    description:
      "Refuses a registration from a foreign origin, without user verification and with a bad attestation signature, and an assertion with a bad signature, for another relying party, of the wrong type and with a counter that went back",
    async run(context) {
      AUTHENTICATORS.device.reset()
      const web = context.client("web")
      await signUpVerified(context, web, "eli@example.com", PASSWORD)
      await register(context, web, AUTHENTICATORS.device, "Foreign", {
        origin: "https://evil.example",
      })
      await register(context, web, AUTHENTICATORS.device, "No UV", { noUserVerification: true })
      await register(context, web, AUTHENTICATORS.device, "Bad sig", { badSignature: true })
      expectStatus(await register(context, web, AUTHENTICATORS.device, "Laptop"), 200, "register")
      const handle = await userHandleOf(context, web)
      await authenticate(context, context.client("a"), AUTHENTICATORS.device, handle, {
        badSignature: true,
      })
      await authenticate(context, context.client("b"), AUTHENTICATORS.device, handle, {
        rpId: "evil.example",
      })
      await authenticate(context, context.client("c"), AUTHENTICATORS.device, handle, {
        type: "webauthn.create",
      })
      await authenticate(context, context.client("d"), AUTHENTICATORS.device, handle, {
        counter: 0,
      })
    },
  },
  {
    id: "fresh-session-required",
    description:
      "Registering a passkey needs a sign in within 15 minutes: an older session is refused until it signs in again; without a session the options are refused",
    async run(context) {
      const web = context.client("web")
      await signUpVerified(context, web, "fin@example.com", PASSWORD)
      context.clock.advance(16 * 60_000)
      await context.send(web, "GET", "/auth/v1/passkey/generate-register-options")
      expectStatus(await signIn(context, web, "fin@example.com", PASSWORD), 200, "sign in")
      await context.send(web, "GET", "/auth/v1/passkey/generate-register-options")
      await context.send(
        context.client("nobody"),
        "GET",
        "/auth/v1/passkey/generate-register-options",
      )
    },
  },
]
