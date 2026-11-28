import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose"
import { BSON, type Document, type MongoClient, ObjectId } from "mongodb"
import type { BuiltinAuth } from "../../src/index.ts"
import { AUTHENTICATORS } from "./cases/factors.ts"
import { EPOCH } from "./determinism.ts"
import { base32, linkOf, totp } from "./flows.ts"
import { decryptBetterAuth, signedCookieValue } from "./formats.ts"
import { APP_ORIGIN, Client, type Json, PUBLIC_URL, Recorder, SECRET } from "./harness.ts"
import { betterAuthScrypt, legacyUsers } from "./legacy.ts"
import type { SoftwareAuthenticator } from "./webauthn.ts"

/** The clock of the proof: an hour after the fixture was written, within every session and key. */
const PROOF_CLOCK = EPOCH + 3_600_000
const SESSION_COOKIE = "__Secure-canopy.session_token"

interface Answer {
  readonly status: number
  readonly json: Record<string, unknown>
  readonly location: string | undefined
}

/** Drives built in auth like a browser without recording anything. */
class Driver {
  private readonly auth: BuiltinAuth
  private readonly recorder: Recorder
  private ips = 0

  constructor(auth: BuiltinAuth, recorder: Recorder) {
    this.auth = auth
    this.recorder = recorder
  }

  client(mode: "cookie" | "bearer" = "cookie"): Client {
    return new Client(`client-${++this.ips}`, `198.51.100.${this.ips}`, mode)
  }

  async send(client: Client, method: string, path: string, body?: unknown): Promise<Answer> {
    const headers = new Headers()
    if (client.origin !== undefined) headers.set("origin", client.origin)
    if (client.cookies.size > 0)
      headers.set(
        "cookie",
        [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      )
    if (client.mode === "bearer" && client.bearer !== undefined)
      headers.set("authorization", `Bearer ${client.bearer}`)
    if (client.ceremony !== undefined) headers.set("x-canopy-ceremony", client.ceremony)
    if (body !== undefined) headers.set("content-type", "application/json")
    const response = await this.auth.handler(
      new Request(new URL(path, PUBLIC_URL), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { clientAddress: client.ip },
    )
    const text = await response.text()
    client.absorb(response.headers, this.recorder.clock)
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>
    } catch {
      json = {}
    }
    return {
      status: response.status,
      json,
      location: response.headers.get("location") ?? undefined,
    }
  }

  async visit(client: Client, target: string): Promise<Answer> {
    const url = new URL(target)
    if (url.origin === PUBLIC_URL) {
      const origin = client.origin
      client.origin = undefined
      try {
        return await this.send(client, "GET", `${url.pathname}${url.search}`)
      } finally {
        client.origin = origin
      }
    }
    const route = this.recorder.providers.routes.get(url.origin)
    if (route === undefined) throw new Error(`nothing answers ${url.origin}`)
    const response = await route(new Request(url))
    return {
      status: response.status,
      json: {},
      location: response.headers.get("location") ?? undefined,
    }
  }

  async expect(client: Client, method: string, path: string, body: unknown, status: number) {
    const answer = await this.send(client, method, path, body)
    if (answer.status !== status)
      throw new Error(
        `${method} ${path}: expected ${status}, got ${answer.status} ${JSON.stringify(answer.json)}`,
      )
    return answer
  }

  async social(client: Client, provider: string): Promise<Answer> {
    const started = await this.expect(
      client,
      "POST",
      "/auth/v1/sign-in/social",
      { provider, callbackURL: `${APP_ORIGIN}/home` },
      200,
    )
    const consent = await this.visit(client, String(started.json["url"]))
    return this.visit(client, consent.location ?? "")
  }
}

async function signUpVerified(
  driver: Driver,
  outbox: readonly { readonly text: string }[],
  email: string,
  password: string,
): Promise<Client> {
  const web = driver.client()
  const before = outbox.length
  await driver.expect(web, "POST", "/auth/v1/sign-up/email", { email, password, name: email }, 200)
  for (let waited = 0; outbox.length === before && waited < 200; waited++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  await driver.visit(web, linkOf(outbox.at(-1) as Parameters<typeof linkOf>[0]))
  return web
}

async function registerPasskey(
  driver: Driver,
  web: Client,
  authenticator: SoftwareAuthenticator,
  name: string,
): Promise<void> {
  const options = await driver.expect(
    web,
    "GET",
    "/auth/v1/passkey/generate-register-options",
    undefined,
    200,
  )
  const credential = authenticator.register(
    {
      challenge: String(options.json["challenge"]),
      rpId: String((options.json["rp"] as { id: string }).id),
    },
    APP_ORIGIN,
  )
  await driver.expect(
    web,
    "POST",
    "/auth/v1/passkey/verify-registration",
    { response: credential, name },
    200,
  )
}

function sessionOf(client: Client): { token: string; cookie: string } {
  const cookie = decodeURIComponent(client.cookies.get(SESSION_COOKIE) ?? "")
  return { token: cookie.slice(0, cookie.lastIndexOf(".")), cookie }
}

function canonical(document: Document): Json {
  return JSON.parse(BSON.EJSON.stringify(document, { relaxed: false })) as Json
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

const PASSWORDS = {
  native: "native password 1",
  scrypt: "scrypt password 1",
  totp: "totp password 1",
  passkey: "passkey password 1",
} as const

/**
 * Writes `conformance/auth/documents`: a `canopy_auth` database written by the TypeScript server through its
 * own routes and user admin (users of every password hash kind, a session, accounts of every provider kind,
 * a two factor secret, passkeys from both software authenticators, EdDSA and ES256 signing keys), each
 * collection as canonical EJSON, and `manifest.json` with what belongs to each document.
 */
export async function writeDocuments(client: MongoClient, dir: string): Promise<void> {
  const recorder = new Recorder(client)
  await recorder.deterministic(async () => {
    const started = await recorder.start({ algorithm: "EdDSA" })
    const { auth, outbox, authDb } = started
    try {
      recorder.random.reseed("canopy auth fixture")
      const driver = new Driver(auth, recorder)
      const native = await signUpVerified(driver, outbox, "native@example.com", PASSWORDS.native)
      const signedIn = driver.client()
      await driver.expect(
        signedIn,
        "POST",
        "/auth/v1/sign-in/email",
        { email: "native@example.com", password: PASSWORDS.native },
        200,
      )
      const scrypt = await auth.users.create({
        email: "scrypt@example.com",
        password: PASSWORDS.scrypt,
        emailVerified: true,
        name: "Scrypt",
      })
      await authDb
        .collection("accounts")
        .updateOne(
          { userId: new ObjectId(scrypt.id), providerId: "credential" },
          { $set: { password: betterAuthScrypt(PASSWORDS.scrypt) } },
        )
      const legacy = await legacyUsers()
      await auth.users.import?.(
        legacy.map((user) => ({
          email: user.email,
          emailVerified: true,
          passwordHash: user.passwordHash,
        })),
      )
      const totpUser = await signUpVerified(driver, outbox, "totp@example.com", PASSWORDS.totp)
      const enabled = await driver.expect(
        totpUser,
        "POST",
        "/auth/v1/two-factor/enable",
        { password: PASSWORDS.totp },
        200,
      )
      const totpSecret = new URL(String(enabled.json["totpURI"])).searchParams.get("secret") ?? ""
      await driver.expect(
        totpUser,
        "POST",
        "/auth/v1/two-factor/verify-totp",
        { code: totp(base32(totpSecret), recorder.clock.now()) },
        200,
      )
      AUTHENTICATORS.device.reset()
      const passkeyUser = await signUpVerified(
        driver,
        outbox,
        "passkey@example.com",
        PASSWORDS.passkey,
      )
      await registerPasskey(driver, passkeyUser, AUTHENTICATORS.synced, "Phone")
      await registerPasskey(driver, passkeyUser, AUTHENTICATORS.device, "Laptop")
      const socials = [
        { provider: "github", sub: "4242", email: "github@example.com" },
        { provider: "google", sub: "1093", email: "google@example.com" },
        { provider: "acme", sub: "idp-user-7", email: "oidc@example.com" },
      ]
      for (const social of socials) {
        recorder.providers.user = { sub: social.sub, email: social.email, name: social.provider }
        await driver.social(driver.client(), social.provider)
      }
      await driver.expect(driver.client(), "POST", "/auth/v1/sign-in/anonymous", {}, 200)
      await auth.close()
      const second = await recorder.start({ algorithm: "ES256" }, started.names)
      await second.auth.close()

      await mkdir(dir, { recursive: true })
      const collections = (await authDb.listCollections({}, { nameOnly: true }).toArray())
        .map((collection) => collection.name)
        .sort()
      for (const collection of collections) {
        const documents = await authDb.collection(collection).find().sort({ _id: 1 }).toArray()
        await writeFile(join(dir, `${collection}.json`), json(documents.map(canonical)))
      }
      const nativeSession = sessionOf(signedIn)
      const verifiedSession = sessionOf(native)
      await writeFile(
        join(dir, "manifest.json"),
        json({
          secret: SECRET,
          publicUrl: PUBLIC_URL,
          appOrigin: APP_ORIGIN,
          writtenAt: new Date(EPOCH).toISOString(),
          proofClock: new Date(PROOF_CLOCK).toISOString(),
          passwords: [
            { email: "native@example.com", password: PASSWORDS.native, hash: "argon2id (native)" },
            { email: "scrypt@example.com", password: PASSWORDS.scrypt, hash: "better-auth-scrypt" },
            ...legacy.map((user) => ({
              email: user.email,
              password: user.password,
              hash: `imported ${user.kind}`,
            })),
            { email: "totp@example.com", password: PASSWORDS.totp, hash: "argon2id (native)" },
            {
              email: "passkey@example.com",
              password: PASSWORDS.passkey,
              hash: "argon2id (native)",
            },
          ],
          sessions: [
            {
              email: "native@example.com",
              via: "sign-in/email",
              cookieName: SESSION_COOKIE,
              ...nativeSession,
            },
            {
              email: "native@example.com",
              via: "verify-email",
              cookieName: SESSION_COOKIE,
              ...verifiedSession,
            },
          ],
          twoFactor: [
            {
              email: "totp@example.com",
              totpSecret: base32(totpSecret).toString("utf8"),
              totpSecretBase32: totpSecret,
              backupCodes: enabled.json["backupCodes"] as Json,
            },
          ],
          passkeys: [
            {
              email: "passkey@example.com",
              name: "Phone",
              authenticator: AUTHENTICATORS.synced.describe() as Json,
            },
            {
              email: "passkey@example.com",
              name: "Laptop",
              authenticator: AUTHENTICATORS.device.describe() as Json,
            },
          ],
          socialAccounts: socials,
          anonymous: 1,
          signingKeys: "every key in signing_keys.json; privateKey is decrypted with the secret",
        }),
      )
    } finally {
      await auth.close()
      await started.drop()
    }
  })
}

interface Manifest {
  readonly passwords: { email: string; password: string; hash: string }[]
  readonly sessions: { email: string; token: string; cookie: string }[]
  readonly twoFactor: {
    email: string
    totpSecret: string
    totpSecretBase32: string
    backupCodes: string[]
  }[]
  readonly passkeys: { email: string; name: string; authenticator: { name: string } }[]
  readonly socialAccounts: { provider: string; sub: string; email: string }[]
}

/**
 * Proves the committed fixture still works with the TypeScript server, the way a replacement must prove it:
 * every private key and two factor secret decrypts (with an XChaCha20-Poly1305 written apart from Better
 * Auth), every password signs in (imported hashes are replaced by Argon2id), the stored sessions are
 * accepted with their signed cookies, the passkeys authenticate, the provider accounts sign in again as the
 * same users, and tokens signed with the stored EdDSA and ES256 keys verify with the published key set.
 * Returns what failed.
 */
export async function proveDocuments(client: MongoClient, dir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest
  const files = (await readdir(dir)).filter(
    (file) => file.endsWith(".json") && file !== "manifest.json",
  )
  const loaded = new Map<string, Document[]>()
  for (const file of files)
    loaded.set(
      file.slice(0, -".json".length),
      BSON.EJSON.parse(await readFile(join(dir, file), "utf8"), { relaxed: false }) as Document[],
    )
  const failures: string[] = []
  const check = (what: string, ok: boolean): void => {
    if (!ok) failures.push(what)
  }
  const documents = (collection: string): Document[] => loaded.get(collection) ?? []

  for (const key of documents("signing_keys")) {
    const what = `signing key ${String(key["_id"])}`
    try {
      const stored: unknown = JSON.parse(String(key["privateKey"]))
      const jwk = JSON.parse(decryptBetterAuth(SECRET, String(stored))) as Record<string, string>
      const published = JSON.parse(String(key["publicKey"])) as Record<string, string>
      check(
        `${what} decrypts to the published key`,
        jwk["x"] === published["x"] && jwk["y"] === published["y"],
      )
    } catch (error: unknown) {
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const users = documents("users")
  const userId = (email: string): string | undefined => {
    const id = users.find((user) => user["email"] === email)?.["_id"]
    return id instanceof ObjectId ? id.toHexString() : undefined
  }
  for (const entry of manifest.twoFactor) {
    const stored = documents("two_factors").find(
      (document) => String(document["userId"]) === userId(entry.email),
    )
    try {
      const secret = decryptBetterAuth(SECRET, String(stored?.["secret"]))
      check(`the TOTP secret of ${entry.email} decrypts`, secret === entry.totpSecret)
      check(
        `the TOTP secret of ${entry.email} is the base32 secret of its URI`,
        base32(entry.totpSecretBase32).toString("utf8") === secret,
      )
      check(
        `the backup codes of ${entry.email} decrypt`,
        JSON.stringify(JSON.parse(decryptBetterAuth(SECRET, String(stored?.["backupCodes"])))) ===
          JSON.stringify(entry.backupCodes),
      )
    } catch (error: unknown) {
      failures.push(
        `two factor of ${entry.email}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  for (const session of manifest.sessions)
    check(
      `the cookie of the session of ${session.email} is the token and its HMAC-SHA256`,
      signedCookieValue(SECRET, session.token) === session.cookie,
    )

  const recorder = new Recorder(client)
  await recorder.deterministic(async () => {
    const names = {
      app: `canopy_app_proof_${new ObjectId().toHexString()}`,
      meta: `canopy_proof_${new ObjectId().toHexString()}`,
      auth: `canopy_auth_proof_${new ObjectId().toHexString()}`,
    }
    for (const [collection, docs] of loaded)
      if (docs.length > 0) await client.db(names.auth).collection(collection).insertMany(docs)
    recorder.clock.set(PROOF_CLOCK)
    const started = await recorder.start({ algorithm: "EdDSA" }, names)
    const { auth, authDb } = started
    try {
      const driver = new Driver(auth, recorder)
      for (const entry of manifest.passwords) {
        const web = driver.client()
        const answer = await driver.send(web, "POST", "/auth/v1/sign-in/email", {
          email: entry.email,
          password: entry.password,
        })
        if (answer.json["twoFactorRedirect"] === true) {
          const factor = manifest.twoFactor.find((item) => item.email === entry.email)
          const code = totp(base32(factor?.totpSecretBase32 ?? ""), recorder.clock.now())
          const verified = await driver.send(web, "POST", "/auth/v1/two-factor/verify-totp", {
            code,
          })
          check(`${entry.email} completes the second factor`, verified.status === 200)
        } else
          check(`${entry.email} signs in with its ${entry.hash} password`, answer.status === 200)
        const account = await authDb
          .collection("accounts")
          .findOne({ accountId: userId(entry.email), providerId: "credential" })
        check(
          `${entry.email} has an Argon2id hash after signing in`,
          String(account?.["password"]).startsWith("$argon2id$v=19$m=19456,t=2,p=1$"),
        )
      }
      for (const session of manifest.sessions) {
        const web = driver.client()
        web.cookies.set(SESSION_COOKIE, encodeURIComponent(session.cookie))
        const answer = await driver.send(web, "GET", "/auth/v1/get-session")
        const user = answer.json["user"] as { email?: string } | undefined
        check(`the stored session of ${session.email} is accepted`, user?.email === session.email)
      }
      const handle = Buffer.from(userId("passkey@example.com") ?? "").toString("base64url")
      const stored = documents("passkeys")
      for (const entry of manifest.passkeys) {
        const authenticator =
          entry.authenticator.name === "device" ? AUTHENTICATORS.device : AUTHENTICATORS.synced
        const counter = Number(
          stored.find((key) => key["credentialID"] === authenticator.id)?.["counter"],
        )
        authenticator.reset(Number.isInteger(counter) ? counter : 0)
        const web = driver.client()
        const options = await driver.send(
          web,
          "GET",
          "/auth/v1/passkey/generate-authenticate-options",
        )
        const credential = authenticator.authenticate(
          { challenge: String(options.json["challenge"]), rpId: String(options.json["rpId"]) },
          APP_ORIGIN,
          handle,
        )
        const answer = await driver.send(web, "POST", "/auth/v1/passkey/verify-authentication", {
          response: credential,
        })
        check(`the ${entry.name} passkey of ${entry.email} authenticates`, answer.status === 200)
      }
      for (const social of manifest.socialAccounts) {
        recorder.providers.user = { sub: social.sub, email: social.email, name: social.provider }
        const web = driver.client()
        await driver.social(web, social.provider)
        const session = await driver.send(web, "GET", "/auth/v1/get-session")
        const user = session.json["user"] as { id?: string } | undefined
        check(
          `the ${social.provider} account signs in as its user`,
          user?.id === userId(social.email),
        )
      }
      await verifyToken(driver, auth, "EdDSA", check)
      await auth.close()
      const es256 = await recorder.start({ algorithm: "ES256" }, names)
      try {
        await verifyToken(new Driver(es256.auth, recorder), es256.auth, "ES256", check)
      } finally {
        await es256.auth.close()
      }
      const keys = await authDb.collection("signing_keys").countDocuments()
      check("no signing key was created by the proof", keys === documents("signing_keys").length)
    } finally {
      await auth.close()
      await started.drop()
    }
  })
  return failures
}

async function verifyToken(
  driver: Driver,
  auth: BuiltinAuth,
  algorithm: "EdDSA" | "ES256",
  check: (what: string, ok: boolean) => void,
): Promise<void> {
  const web = driver.client()
  try {
    await driver.send(web, "POST", "/auth/v1/sign-in/email", {
      email: "native@example.com",
      password: PASSWORDS.native,
    })
    const answer = await driver.send(web, "GET", "/auth/v1/token")
    const token = String(answer.json["access_token"])
    await jwtVerify(token, createLocalJWKSet(await auth.jwks()), { algorithms: [algorithm] })
    check(
      `an ${algorithm} token from a stored key verifies`,
      decodeProtectedHeader(token).alg === algorithm,
    )
  } catch (error: unknown) {
    check(`an ${algorithm} token from a stored key verifies (${String(error)})`, false)
  }
}
