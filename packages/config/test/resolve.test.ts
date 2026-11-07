import { describe, expect, it } from "vitest"
import {
  type CanopyConfigInput,
  type Command,
  ConfigError,
  defineConfig,
  env,
  external,
  formatConfig,
  type Resolution,
  redactUri,
  resolveConfig,
} from "../src/index.ts"

const URI = "mongodb://localhost:27017/app?replicaSet=rs0"

function resolve(
  input: CanopyConfigInput | undefined,
  variables: Record<string, string> = {},
  command: Command = "start",
): Resolution {
  return resolveConfig(input, {
    env: variables,
    ...(input === undefined ? {} : { file: "/project/canopy/canopy.config.ts" }),
    baseDir: "/project/canopy",
    cwd: "/project",
    command,
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

describe("resolveConfig", () => {
  it("applies secure defaults and takes the database from the URI path", () => {
    const { config } = resolve({ mongodb: { uri: URI } })
    expect(config.mongodb).toEqual({
      uri: URI,
      database: "app",
      metaDatabase: "canopy",
      authDatabase: "canopy_auth",
    })
    expect(config.environment).toBe("development")
    expect(config.keys).toEqual({ publishable: [], secret: [] })
    expect(config.policies).toEqual({ source: "database", watch: true })
    expect(config.auth).toBeUndefined()
    expect(config.rest).toEqual({
      defaultLimit: 100,
      maxLimit: 1000,
      maxBodyBytes: 1048576,
      mutationTtlMs: 86_400_000,
    })
    expect(config.realtime).toEqual({
      fullDocument: "auto",
      transports: ["websocket", "sse", "long-poll"],
      resumeWindowMs: 120_000,
      checkpoints: "meta",
      drainWindowMs: 30_000,
    })
    expect(config.server).toEqual({
      port: 8080,
      metricsPort: 9464,
      adminListen: undefined,
      nodeId: "n1",
    })
    expect(config.cors).toBeUndefined()
  })

  it("resolves env markers with their types and defaults", () => {
    const { config } = resolve(
      {
        mongodb: { uri: env.secret("DB_URL") },
        server: { port: env.int("APP_PORT"), metricsPort: env.int("M_PORT", { default: 9100 }) },
        keys: { publishable: env.list("PKS") },
        realtime: { resumeWindow: env.duration("RESUME") },
        dev: { insecure: env.bool("INSECURE") },
        publicUrl: env.url.optional("PUBLIC"),
      },
      { DB_URL: URI, APP_PORT: "3000", PKS: "pk_a, pk_b,", RESUME: "5m", INSECURE: "1" },
    )
    expect(config.mongodb.uri).toBe(URI)
    expect(config.server.port).toBe(3000)
    expect(config.server.metricsPort).toBe(9100)
    expect(config.keys.publishable).toEqual(["pk_a", "pk_b"])
    expect(config.realtime !== false && config.realtime.resumeWindowMs).toBe(300_000)
    expect(config.dev.insecure).toBe(true)
    expect(config.publicUrl).toBeUndefined()
  })

  it("reports every unset variable and invalid value at once", () => {
    expect(
      problems(() =>
        resolve(
          {
            mongodb: { uri: env("MONGO") },
            server: { port: env.int("APP_PORT") },
            auth: external.auth0({ domain: env("AUTH0_DOMAIN"), audience: "https://api" }),
          },
          { APP_PORT: "eighty" },
        ),
      ).map((problem) => problem.path),
    ).toEqual(["mongodb.uri", "server.port", "auth.domain", "auth.issuer", "auth.jwksUrl"])
  })

  it("names unknown settings and suggests the intended one", () => {
    const found = problems(() =>
      resolve({
        mongodb: { uri: URI },
        realtime: { fullDocumnet: "auto" },
        corz: { origins: ["https://a.test"] },
      } as unknown as CanopyConfigInput),
    )
    expect(found).toEqual([
      {
        path: "realtime.fullDocumnet",
        message: "Unknown setting. Did you mean realtime.fullDocument?",
      },
      { path: "corz", message: "Unknown setting. Did you mean cors?" },
    ])
  })

  it("suggests the closest allowed value", () => {
    const [problem] = problems(() =>
      resolve({
        mongodb: { uri: URI },
        realtime: { fullDocument: "updatelookup" },
      } as unknown as CanopyConfigInput),
    )
    expect(problem?.message).toBe(
      'Received "updatelookup".\nExpected "auto", "updateLookup" or "images". Did you mean "updateLookup"?',
    )
  })

  it("fills settings the file leaves out from well known variables", () => {
    const { config, sources } = resolve(
      { mongodb: { uri: URI } },
      { CANOPY_PUBLISHABLE_KEYS: "pk_1", PORT: "9000", CANOPY_RESUME_WINDOW: "30s" },
    )
    expect(config.keys.publishable).toEqual(["pk_1"])
    expect(config.server.port).toBe(9000)
    expect(config.realtime !== false && config.realtime.resumeWindowMs).toBe(30_000)
    expect(sources.get("server.port")).toEqual({ kind: "env", name: "PORT", envFile: undefined })
  })

  it("fails when the file and a well known variable disagree", () => {
    expect(
      problems(() =>
        resolve(
          { mongodb: { uri: URI }, server: { port: 3000 } },
          { MONGODB_URI: "mongodb://other:27017/app", PORT: "3000" },
        ),
      ),
    ).toEqual([
      {
        path: "mongodb.uri",
        message:
          "mongodb.uri is set in the config file and by MONGODB_URI, with different values.\nRemove one of them: the config file and the environment must not disagree.",
      },
    ])
  })

  it("accepts a file that reads the well known variable itself", () => {
    const { config } = resolve({ mongodb: { uri: env("MONGODB_URI") } }, { MONGODB_URI: URI })
    expect(config.mongodb.uri).toBe(URI)
    expect(
      problems(() =>
        resolve(
          { mongodb: { uri: env("DATABASE_URL") } },
          { DATABASE_URL: URI, MONGODB_URI: "mongodb://elsewhere:27017/app" },
        ),
      )[0]?.message,
    ).toContain("set in the config file (through DATABASE_URL) and by MONGODB_URI")
  })

  it("configures the sidecar from variables alone, as before config files", () => {
    const { config } = resolve(
      undefined,
      {
        MONGODB_URI: URI,
        CANOPY_POLICIES: "./canopy/policies",
        CANOPY_JWT_JWKS_URL: "https://idp.test/.well-known/jwks.json",
        CANOPY_JWT_ISSUER: "https://idp.test/",
        CANOPY_JWT_AUDIENCE: "https://api.test",
        CANOPY_JWT_ALGORITHMS: "RS256",
        CANOPY_JWT_ROLES_CLAIM: "https://api.test/roles",
        CANOPY_PUBLISHABLE_KEYS: "pk_1,pk_2",
        CANOPY_REALTIME_FULL_DOCUMENT: "images",
        CANOPY_CHECKPOINTS: "off",
        CANOPY_CORS_ORIGINS: "*",
      },
      "realtime",
    )
    expect(config.file).toBeUndefined()
    expect(config.auth).toEqual({
      jwksUrl: "https://idp.test/.well-known/jwks.json",
      issuer: "https://idp.test/",
      audience: "https://api.test",
      algorithms: ["RS256"],
      rolesClaim: "https://api.test/roles",
    })
    expect(config.policies).toEqual({ dir: "/project/canopy/policies", watch: true })
    expect(config.realtime).toMatchObject({ fullDocument: "images", checkpoints: "off" })
    expect(config.cors).toEqual({ origins: "*" })
    expect(config.keys.publishable).toEqual(["pk_1", "pk_2"])
  })

  it("resolves policy directories from the file relative to the file", () => {
    const { config } = resolve({ mongodb: { uri: URI }, policies: { dir: "./policies" } })
    expect(config.policies).toEqual({ dir: "/project/canopy/policies", watch: true })
  })

  it("only requires what the command uses", () => {
    expect(() => resolve({ policies: { dir: "./policies" } }, {}, "policies")).not.toThrow()
    expect(problems(() => resolve({ policies: { dir: "./policies" } }, {}, "start"))).toEqual([
      {
        path: "mongodb.uri",
        message:
          "No MongoDB connection string.\nSet MONGODB_URI, or mongodb.uri in the config file.",
      },
    ])
    expect(() =>
      resolve(
        {
          mongodb: { uri: URI },
          auth: external({ issuer: env("ISS"), audience: "a", jwksUrl: "https://x.test/j" }),
        },
        {},
        "gen",
      ),
    ).not.toThrow()
  })

  it("still reports invalid values in sections the command does not use", () => {
    const outOfRange = problems(() =>
      resolve({ server: { port: 70_000 }, policies: { dir: "./p" } }, {}, "policies"),
    )
    expect(outOfRange.map((problem) => problem.path)).toEqual(["server.port"])
    const wrongType = problems(() =>
      resolve(
        { server: { port: "80" }, policies: { dir: "./p" } } as unknown as CanopyConfigInput,
        {},
        "policies",
      ),
    )
    expect(wrongType.map((problem) => problem.path)).toEqual(["server.port"])
  })

  it("expands identity provider presets", () => {
    const auth0 = resolve({
      mongodb: { uri: URI },
      auth: external.auth0({ domain: "example.eu.auth0.com", audience: "https://api.example.com" }),
    }).config.auth
    expect(auth0).toEqual({
      jwksUrl: "https://example.eu.auth0.com/.well-known/jwks.json",
      issuer: "https://example.eu.auth0.com/",
      audience: "https://api.example.com",
      algorithms: ["RS256"],
    })
    const firebase = resolve({
      mongodb: { uri: URI },
      auth: external.firebase({ projectId: "demo-app" }),
    }).config.auth
    expect(firebase).toMatchObject({
      issuer: "https://securetoken.google.com/demo-app",
      audience: "demo-app",
    })
    const supabase = resolve({
      mongodb: { uri: URI },
      auth: external.supabase({ projectRef: "abcd" }),
    }).config.auth
    expect(supabase).toMatchObject({
      jwksUrl: "https://abcd.supabase.co/auth/v1/.well-known/jwks.json",
      issuer: "https://abcd.supabase.co/auth/v1",
      audience: "authenticated",
    })
  })

  it("refuses insecure token verification", () => {
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          auth: external({
            jwksUrl: "http://idp.example.com/jwks",
            issuer: "i",
            audience: "a",
            algorithms: ["HS256", "RS256"],
          }),
        }),
      ).map((problem) => problem.path),
    ).toEqual(["auth.jwksUrl", "auth.algorithms"])
    expect(() =>
      resolve({
        mongodb: { uri: URI },
        auth: external({ jwksUrl: "http://localhost:4000/jwks", issuer: "i", audience: "a" }),
      }),
    ).not.toThrow()
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          auth: external({ jwksUrl: "https://x.test/j", issuer: "i" } as never),
        }),
      ).map((problem) => problem.path),
    ).toEqual(["auth.audience"])
  })

  it("enforces production rules", () => {
    const production = { CANOPY_ENV: "production" }
    expect(
      problems(() =>
        resolve(
          { mongodb: { uri: URI }, dev: { insecure: true }, cors: { origins: "*" } },
          production,
          "start",
        ),
      ).map((problem) => problem.path),
    ).toEqual(["cors.origins", "dev.insecure", "masterKey"])
    expect(() => resolve({ mongodb: { uri: URI } }, production, "realtime")).not.toThrow()
    expect(() =>
      resolve(
        { mongodb: { uri: URI } },
        { ...production, CANOPY_MASTER_KEY: "k".repeat(32) },
        "start",
      ),
    ).not.toThrow()
  })

  it("refuses variables for a section the file turned off", () => {
    expect(
      problems(() =>
        resolve(
          { mongodb: { uri: URI }, realtime: false },
          { CANOPY_REALTIME_FULL_DOCUMENT: "images" },
        ),
      ).map((problem) => problem.path),
    ).toEqual(["realtime.fullDocument"])
    expect(resolve({ mongodb: { uri: URI }, rest: false }).config.rest).toBe(false)
  })

  it("requires distinct app, meta and auth databases", () => {
    expect(
      problems(() => resolve({ mongodb: { uri: URI, metaDatabase: "app" } })).map((p) => p.path),
    ).toEqual(["mongodb"])
    expect(
      problems(() => resolve({ mongodb: { uri: "mongodb://localhost:27017" } })).map((p) => p.path),
    ).toEqual(["mongodb.database"])
  })

  it("prints the config with secrets and passwords masked and with sources", () => {
    const resolution = resolve(
      {
        mongodb: { uri: "mongodb://admin:hunter2@db.test:27017/app" },
        masterKey: env.secret("MASTER"),
        keys: { secret: ["canopy_sk_1"], publishable: ["pk_1"] },
      },
      { MASTER: "super-secret-value", PORT: "9000" },
    )
    const text = formatConfig(resolution, { sources: true })
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("super-secret-value")
    expect(text).not.toContain("canopy_sk_1")
    expect(text).toContain('mongodb.uri = "mongodb://admin:••••@db.test:27017/app"  (config file)')
    expect(text).toContain('masterKey = "••••"  (env MASTER)')
    expect(text).toContain('keys.publishable = ["pk_1"]  (config file)')
    expect(text).toContain("server.port = 9000  (env PORT)")
    expect(text).toContain("server.metricsPort = 9464  (default)")
  })

  it("never leaks secrets into error messages", () => {
    try {
      resolve(
        { mongodb: { uri: URI }, masterKey: env.secret("MASTER") },
        { MASTER: "abc", CANOPY_MASTER_KEY: "different-secret" },
      )
      throw new Error("expected a ConfigError")
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError)
      expect(String((error as Error).message)).not.toContain("different-secret")
      expect(String((error as Error).message)).not.toContain('"abc"')
    }
  })

  it("redacts URI passwords only", () => {
    expect(redactUri("mongodb+srv://u:p%40ss@c.test/app")).toBe("mongodb+srv://u:••••@c.test/app")
    expect(redactUri("mongodb://c.test/app")).toBe("mongodb://c.test/app")
  })

  it("keeps defineConfig an identity function for both forms", () => {
    const object = { mongodb: { uri: URI } }
    const fn = () => object
    expect(defineConfig(object)).toBe(object)
    expect(defineConfig(fn)).toBe(fn)
  })
})
