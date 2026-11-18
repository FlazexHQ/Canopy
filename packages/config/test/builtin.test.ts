import { describe, expect, it } from "vitest"
import {
  builtin,
  type CanopyConfigInput,
  ConfigError,
  email,
  env,
  formatConfig,
  type Resolution,
  resolveConfig,
} from "../src/index.ts"

const URI = "mongodb://localhost:27017/app?replicaSet=rs0"
const KEY = "k".repeat(40)

function resolve(input: CanopyConfigInput, variables: Record<string, string> = {}): Resolution {
  return resolveConfig(input, {
    env: variables,
    file: "/project/canopy/canopy.config.ts",
    baseDir: "/project/canopy",
    cwd: "/project",
    command: "start",
  })
}

function problems(run: () => unknown): { path: string; message: string }[] {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof ConfigError)
      return error.problems.map(({ path, message }) => ({ path, message }))
    throw error
  }
  throw new Error("expected a ConfigError")
}

const production = {
  mongodb: { uri: URI },
  environment: "production",
  masterKey: KEY,
  publicUrl: "https://api.example.com",
} as const

describe("builtin()", () => {
  it("applies the defaults of built in auth, logging email in development", () => {
    const auth = resolve({
      mongodb: { uri: URI },
      cors: { origins: ["http://localhost:5173"] },
      auth: builtin(),
    }).config.auth
    expect(auth).toEqual({
      kind: "builtin",
      appName: "Canopy",
      secret: undefined,
      accessTokenTtlSeconds: 600,
      algorithm: "EdDSA",
      keyRotation: { intervalSeconds: 30 * 86_400, graceSeconds: 30 * 86_400 },
      redirectUrls: ["http://localhost:5173"],
      emailPassword: { minPasswordLength: 10, requireEmailVerification: true },
      magicLink: true,
      emailOtp: true,
      anonymous: false,
      twoFactor: true,
      passkeys: true,
      providers: {},
      oidc: [],
      claims: undefined,
      email: { from: "Canopy <auth@localhost>", transport: { kind: "log" } },
      trustedProxies: [],
      identifierLimit: { max: 10, windowSeconds: 60 },
      session: { expiresInSeconds: 7 * 86_400, updateAgeSeconds: 86_400 },
    })
  })

  it("takes the app name emails use and refuses an empty one", () => {
    const named = resolve({ mongodb: { uri: URI }, auth: builtin({ appName: "Acme Notes" }) })
    expect(named.config.auth).toMatchObject({ kind: "builtin", appName: "Acme Notes" })
    expect(() => resolve({ mongodb: { uri: URI }, auth: builtin({ appName: " " }) })).toThrow(
      /auth\.appName/,
    )
  })

  it("resolves every setting, with env markers and durations", () => {
    const claims = async () => ({ roles: ["x"] })
    const auth = resolve(
      {
        ...production,
        auth: builtin({
          accessTokenTtl: "15m",
          algorithm: "ES256",
          keyRotation: { interval: "7d", grace: "1d" },
          redirectUrls: ["https://app.example.com"],
          emailPassword: { minPasswordLength: 12, requireEmailVerification: env.bool("VERIFY") },
          anonymous: true,
          providers: { github: { clientId: "gh-id", clientSecret: env("GH_SECRET") } },
          oidc: [
            {
              id: "okta",
              discoveryUrl: "https://okta.example/.well-known/openid-configuration",
              clientId: "c",
              clientSecret: "s",
            },
          ],
          claims,
          email: {
            from: "Acme <auth@acme.example>",
            transport: email.resend({ apiKey: env("RESEND_API_KEY") }),
          },
          trustedProxies: ["10.0.0.0/8"],
          identifierLimit: { max: 5, window: "5m" },
          session: { expiresIn: "30d", updateAge: "12h" },
        }),
      },
      { VERIFY: "false", GH_SECRET: "gh-secret", RESEND_API_KEY: "re_1" },
    ).config.auth
    expect(auth).toMatchObject({
      kind: "builtin",
      secret: KEY,
      accessTokenTtlSeconds: 900,
      algorithm: "ES256",
      keyRotation: { intervalSeconds: 7 * 86_400, graceSeconds: 86_400 },
      emailPassword: { minPasswordLength: 12, requireEmailVerification: false },
      anonymous: true,
      providers: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
      oidc: [{ id: "okta", clientId: "c", clientSecret: "s" }],
      email: { from: "Acme <auth@acme.example>", transport: { kind: "resend", apiKey: "re_1" } },
      trustedProxies: ["10.0.0.0/8"],
      identifierLimit: { max: 5, windowSeconds: 300 },
      session: { expiresInSeconds: 30 * 86_400, updateAgeSeconds: 43_200 },
    })
    expect(auth?.kind === "builtin" ? auth.claims : undefined).toBe(claims)
  })

  it("enforces the production rules of built in auth", () => {
    const found = problems(() =>
      resolve({
        mongodb: { uri: URI },
        environment: "production",
        masterKey: "short",
        publicUrl: "http://api.example.com",
        auth: builtin({
          redirectUrls: ["http://app.example.com"],
          email: { from: "a@b.c", transport: email.log() },
        }),
      }),
    ).map((problem) => problem.path)
    expect(found).toEqual(
      expect.arrayContaining([
        "auth.secret",
        "publicUrl",
        "auth.redirectUrls",
        "auth.email.transport",
      ]),
    )
    const missing = problems(() => resolve({ ...production, auth: builtin() })).map(
      (problem) => problem.path,
    )
    expect(missing).toEqual(["auth.email"])
  })

  it("refuses well known development API keys in production only", () => {
    const keys = (publishable: string[], secret: string[]) => ({ publishable, secret })
    const refused = problems(() =>
      resolve({ ...production, keys: keys(["pk_dev"], ["sk_dev_change_me"]) }),
    ).map((problem) => problem.path)
    expect(refused).toEqual(["keys.publishable", "keys.secret"])
    const generated = problems(() =>
      resolve({
        ...production,
        keys: keys(["canopy_pk_live_1"], [`canopy_sk_dev_${"a".repeat(36)}`]),
      }),
    ).map((problem) => problem.path)
    expect(generated).toEqual(["keys.secret"])
    expect(
      resolve({ ...production, keys: keys(["canopy_pk_live_1"], [`sk_${"x".repeat(40)}`]) }).config
        .keys.secret,
    ).toEqual([`sk_${"x".repeat(40)}`])
    expect(
      resolve({ mongodb: { uri: URI }, keys: keys(["pk_dev"], ["sk_dev_change_me"]) }).config.keys,
    ).toEqual(keys(["pk_dev"], ["sk_dev_change_me"]))
    expect(
      problems(() =>
        resolve(
          { mongodb: { uri: URI } },
          {
            CANOPY_ENV: "production",
            CANOPY_MASTER_KEY: KEY,
            CANOPY_SECRET_KEYS: "sk_dev_change_me",
          },
        ),
      ).map((problem) => problem.path),
    ).toEqual(["keys.secret"])
  })

  it("refuses unsafe lifetimes, short passwords and bad provider ids", () => {
    const found = problems(() =>
      resolve({
        mongodb: { uri: URI },
        auth: builtin({
          accessTokenTtl: "2h",
          keyRotation: { interval: "10m", grace: "1m" },
          emailPassword: { minPasswordLength: 8 },
          oidc: [
            { id: "Bad Id", discoveryUrl: "https://x.example/d", clientId: "c", clientSecret: "s" },
            { id: "github", discoveryUrl: "https://x.example/d", clientId: "c", clientSecret: "s" },
          ],
        }),
      }),
    ).map((problem) => problem.path)
    expect(found.sort()).toEqual(
      [
        "auth.accessTokenTtl",
        "auth.emailPassword.minPasswordLength",
        "auth.keyRotation.grace",
        "auth.keyRotation.interval",
        "auth.oidc.0.id",
        "auth.oidc.1.id",
      ].sort(),
    )
  })

  it("resolves every email transport with only its own fields", () => {
    const transportOf = (transport: unknown, variables: Record<string, string> = {}) => {
      const auth = resolve(
        { mongodb: { uri: URI }, auth: builtin({ email: { from: "a@b.c", transport } as never }) },
        variables,
      ).config.auth
      return auth?.kind === "builtin" ? auth.email.transport : undefined
    }
    expect(
      transportOf(
        email.smtp({ host: "smtp.example", port: env.int("SMTP_PORT"), secure: true, pass: "p" }),
        { SMTP_PORT: "465" },
      ),
    ).toEqual({ kind: "smtp", host: "smtp.example", port: 465, secure: true, pass: "p" })
    expect(transportOf(email.postmark({ serverToken: "t" }))).toEqual({
      kind: "postmark",
      serverToken: "t",
    })
    expect(
      transportOf(email.ses({ region: "eu-west-1", accessKeyId: "a", secretAccessKey: "s" })),
    ).toEqual({ kind: "ses", region: "eu-west-1", accessKeyId: "a", secretAccessKey: "s" })
    expect(transportOf(email.log())).toEqual({ kind: "log" })
  })

  it("reports a transport without its required fields", () => {
    for (const transport of [
      { kind: "resend" },
      { kind: "postmark" },
      { kind: "smtp" },
      { kind: "ses", region: "eu-west-1", accessKeyId: "a" },
    ]) {
      const found = problems(() =>
        resolve({
          mongodb: { uri: URI },
          auth: builtin({ email: { from: "a@b.c", transport } as never }),
        }),
      )
      expect(
        found.map((problem) => problem.path),
        transport.kind,
      ).toEqual(["auth.email.transport"])
      expect(found[0]?.message, transport.kind).toContain(`The ${transport.kind} transport needs`)
    }
  })

  it("reports external only settings and variables, and unknown transports", () => {
    const found = problems(() =>
      resolve(
        {
          mongodb: { uri: URI },
          auth: builtin({ email: { from: "a@b.c", transport: { kind: "fax" } as never } }),
        },
        { CANOPY_JWT_ISSUER: "https://idp.example/" },
      ),
    )
    expect(found.map((problem) => problem.path).sort()).toEqual([
      "auth.email.transport.kind",
      "auth.issuer",
    ])
    expect(
      found.find((problem) => problem.path === "auth.email.transport.kind")?.message,
    ).toContain("email.resend()")
  })

  it("prints built in auth with every secret masked and the hook as a function", () => {
    const resolution = resolve({
      mongodb: { uri: URI },
      masterKey: KEY,
      auth: builtin({
        claims: () => undefined,
        providers: { google: { clientId: "g-id", clientSecret: "g-secret-value" } },
        oidc: [
          {
            id: "okta",
            discoveryUrl: "https://okta.example/d",
            clientId: "c",
            clientSecret: "oidc-secret-value",
          },
        ],
        email: {
          from: "a@b.c",
          transport: email.smtp({ host: "smtp.example", user: "u", pass: "smtp-pass-value" }),
        },
      }),
    })
    const printed = formatConfig(resolution)
    for (const secret of [KEY, "g-secret-value", "oidc-secret-value", "smtp-pass-value"])
      expect(printed).not.toContain(secret)
    expect(printed).toContain("auth.claims = [function]")
    expect(printed).toContain('auth.oidc.0.id = "okta"')
    expect(printed).toContain('auth.providers.google.clientSecret = "••••"')
    expect(printed).toContain('auth.email.transport.pass = "••••"')
    const sourced = formatConfig(resolution, { sources: true })
    expect(sourced).toContain("auth.accessTokenTtlSeconds = 600  (default)")
  })

  it("refuses a claims hook that is not a function", () => {
    const found = problems(() =>
      resolve({ mongodb: { uri: URI }, auth: builtin({ claims: "nope" as never }) }),
    )
    expect(found).toEqual([
      { path: "auth.claims", message: 'Received "nope".\nExpected a function.' },
    ])
  })
})
