import { describe, expect, it } from "vitest"
import {
  amendConfig,
  type CanopyConfigInput,
  type Command,
  ConfigError,
  defineConfig,
  env,
  external,
  formatConfig,
  isResolvedConfig,
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
  it("runs the TypeScript core unless the engine is set, from the file or CANOPY_ENGINE", () => {
    expect(resolve({ mongodb: { uri: URI } }).config.server.engine).toBe("ts")
    expect(
      resolve({ mongodb: { uri: URI }, server: { engine: "wasm" } }).config.server.engine,
    ).toBe("wasm")
    expect(
      resolve(undefined, { MONGODB_URI: URI, CANOPY_ENGINE: "native" }).config.server.engine,
    ).toBe("native")
    expect(
      problems(() => resolve(undefined, { MONGODB_URI: URI, CANOPY_ENGINE: "rust" })).map(
        (problem) => problem.path,
      ),
    ).toEqual(["server.engine"])
  })

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
      echoTimeoutMs: 2000,
      server: "ts",
    })
    expect(config.server).toEqual({
      port: 8080,
      metricsPort: 9464,
      metricsHost: "127.0.0.1",
      metricsToken: undefined,
      adminListen: undefined,
      nodeId: "n1",
      trustedProxies: [],
      engine: "ts",
    })
    expect(config.cors).toBeUndefined()
  })

  it("binds metrics to loopback unless told otherwise, and keeps the metrics token secret", () => {
    const resolution = resolve(
      { mongodb: { uri: URI } },
      { METRICS_HOST: "0.0.0.0", CANOPY_METRICS_TOKEN: "a-long-metrics-token" },
    )
    expect(resolution.config.server.metricsHost).toBe("0.0.0.0")
    expect(resolution.config.server.metricsToken).toBe("a-long-metrics-token")
    const text = formatConfig(resolution, { sources: true })
    expect(text).not.toContain("a-long-metrics-token")
    expect(text).toContain('server.metricsToken = "••••"  (env CANOPY_METRICS_TOKEN)')
    expect(
      problems(() => resolve({ mongodb: { uri: URI }, server: { metricsToken: "short" } })).map(
        (problem) => problem.path,
      ),
    ).toEqual(["server.metricsToken"])
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

  it("reads the trusted proxies from CANOPY_TRUSTED_PROXIES", () => {
    const { config } = resolve(
      { mongodb: { uri: URI } },
      { CANOPY_TRUSTED_PROXIES: "10.0.0.0/8, fd00::/8" },
    )
    expect(config.server.trustedProxies).toEqual(["10.0.0.0/8", "fd00::/8"])
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

  it("amends a resolved config into one that is still recognised as resolved", () => {
    const config = resolve({ mongodb: { uri: URI } }).config
    const amended = amendConfig(config, {
      server: { ...config.server, trustedProxies: ["127.0.0.1"] },
    })
    expect(isResolvedConfig(amended)).toBe(true)
    expect(isResolvedConfig({ ...config })).toBe(false)
    expect(amended.server.trustedProxies).toEqual(["127.0.0.1"])
    expect(config.server.trustedProxies).toEqual([])
    expect(amended.mongodb).toBe(config.mongodb)
  })

  it("reads the realtime server from the file or CANOPY_REALTIME_SERVER, and refuses an unknown one", () => {
    const fromFile = resolve({ mongodb: { uri: URI }, realtime: { server: "gateway" } }).config
    expect(fromFile.realtime !== false && fromFile.realtime.server).toBe("gateway")
    const fromEnv = resolve({ mongodb: { uri: URI } }, { CANOPY_REALTIME_SERVER: "gateway" }).config
    expect(fromEnv.realtime !== false && fromEnv.realtime.server).toBe("gateway")
    expect(() => resolve({ mongodb: { uri: URI } }, { CANOPY_REALTIME_SERVER: "rust" })).toThrow(
      ConfigError,
    )
  })

  it("reads the echo timeout from the file or CANOPY_ECHO_TIMEOUT, and refuses one that is not a duration", () => {
    const fromFile = resolve({ mongodb: { uri: URI }, realtime: { echoTimeout: "10s" } }).config
    expect(fromFile.realtime !== false && fromFile.realtime.echoTimeoutMs).toBe(10_000)
    const fromEnv = resolve({ mongodb: { uri: URI } }, { CANOPY_ECHO_TIMEOUT: "750ms" }).config
    expect(fromEnv.realtime !== false && fromEnv.realtime.echoTimeoutMs).toBe(750)
    expect(() => resolve({ mongodb: { uri: URI } }, { CANOPY_ECHO_TIMEOUT: "soon" })).toThrow(
      ConfigError,
    )
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

  it("accepts an inline key set only with a keys array of objects", () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }
    const auth = resolve({
      mongodb: { uri: URI },
      auth: external({ jwks: { keys: [key] }, issuer: "i", audience: "a" }),
    }).config.auth
    expect(auth).toMatchObject({ jwks: { keys: [key] } })
    for (const jwks of [{}, { keys: key }, { keys: [key, "k2"] }])
      expect(
        problems(() =>
          resolve({
            mongodb: { uri: URI },
            auth: external({ jwks, issuer: "i", audience: "a" } as never),
          }),
        ).map((problem) => problem.path),
        JSON.stringify(jwks),
      ).toEqual(["auth.jwks"])
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

  it("marks resolved configs so they can be told from config input", () => {
    const input = { mongodb: { uri: URI } }
    expect(isResolvedConfig(resolve(input).config)).toBe(true)
    expect(isResolvedConfig(input)).toBe(false)
    expect(isResolvedConfig({ ...resolve(input).config })).toBe(false)
  })

  it("keeps defineConfig an identity function for both forms", () => {
    const object = { mongodb: { uri: URI } }
    const fn = () => object
    expect(defineConfig(object)).toBe(object)
    expect(defineConfig(fn)).toBe(fn)
  })
})

describe("GraphQL settings", () => {
  it("defaults the limits and keeps introspection open outside production", () => {
    expect(resolve({ mongodb: { uri: URI } }).config.graphql).toEqual({
      maxDepth: 10,
      maxComplexity: 5000,
      maxAliases: 30,
      maxBatch: 10,
      introspection: "always",
      persisted: undefined,
    })
  })

  it("closes introspection to anon in production unless configured", () => {
    const production = { CANOPY_ENV: "production", CANOPY_MASTER_KEY: "k".repeat(32) }
    const graphql = (input: CanopyConfigInput) => {
      const config = resolve(input, production).config.graphql
      return config === false ? undefined : config.introspection
    }
    expect(graphql({ mongodb: { uri: URI } })).toBe("authenticated")
    expect(graphql({ mongodb: { uri: URI }, graphql: { introspection: "never" } })).toBe("never")
  })

  it("turns off with rest and resolves persisted files against the config directory", () => {
    expect(resolve({ mongodb: { uri: URI }, rest: false }).config.graphql).toBe(false)
    expect(resolve({ mongodb: { uri: URI }, graphql: false }).config.graphql).toBe(false)
    const config = resolve({
      mongodb: { uri: URI },
      graphql: { persisted: { file: "operations.json", only: true } },
    }).config.graphql
    expect(config === false ? undefined : config.persisted?.only).toBe(true)
    expect(config === false ? "" : config.persisted?.file.replaceAll("\\", "/")).toMatch(
      /\/project\/canopy\/operations\.json$/,
    )
  })

  it("refuses limits out of range and only without a file", () => {
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          graphql: { maxDepth: 0, maxBatch: 1000, persisted: { only: true } as never },
        }),
      ).map((problem) => problem.path),
    ).toEqual(
      expect.arrayContaining(["graphql.maxDepth", "graphql.maxBatch", "graphql.persisted.file"]),
    )
  })

  it("resolves type names and relations per collection", () => {
    expect(
      resolve({
        mongodb: { uri: URI },
        collections: {
          people: { typeName: "Person", relations: { team: { to: "teams", local: "teamId" } } },
          todos: {
            idType: "string",
            relations: { tags: { to: "tags", local: "tagIds", many: true } },
          },
        },
      }).config.collections,
    ).toEqual({
      people: {
        idType: "auto",
        typeName: "Person",
        relations: { team: { to: "teams", local: "teamId", foreign: "_id", many: false } },
      },
      todos: {
        idType: "string",
        relations: { tags: { to: "tags", local: "tagIds", foreign: "_id", many: true } },
      },
    })
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          collections: {
            people: { typeName: "not valid", relations: { team: { local: "teamId" } as never } },
          },
        }),
      ).map((problem) => problem.path),
    ).toEqual(["collections.people.typeName", "collections.people.relations.team"])
  })
})

describe("rateLimits", () => {
  const DEFAULTS = {
    requests: { perSecond: 50, burst: 200 },
    messages: { perSecond: 20, burst: 100 },
    anonymousConnectionsPerAddress: 50,
    failedAuthentications: { perSecond: 1, burst: 30 },
    exemptService: true,
  }

  it("is on by default, with limits ordinary apps do not reach", () => {
    expect(resolve({ mongodb: { uri: URI } }).config.rateLimits).toEqual(DEFAULTS)
    expect(resolve({ mongodb: { uri: URI }, rateLimits: true }).config.rateLimits).toEqual(DEFAULTS)
  })

  it("takes overrides from the file and from variables", () => {
    const { config, sources } = resolve(
      { mongodb: { uri: URI }, rateLimits: { requests: { perSecond: 5 } } },
      {
        CANOPY_RATE_LIMIT_REQUEST_BURST: "9",
        CANOPY_RATE_LIMIT_MESSAGES: "3",
        CANOPY_RATE_LIMIT_MESSAGE_BURST: "4",
        CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS: "7",
        CANOPY_RATE_LIMIT_FAILED_AUTH: "2",
        CANOPY_RATE_LIMIT_FAILED_AUTH_BURST: "6",
        CANOPY_RATE_LIMIT_EXEMPT_SERVICE: "false",
      },
    )
    expect(config.rateLimits).toEqual({
      requests: { perSecond: 5, burst: 9 },
      messages: { perSecond: 3, burst: 4 },
      anonymousConnectionsPerAddress: 7,
      failedAuthentications: { perSecond: 2, burst: 6 },
      exemptService: false,
    })
    expect(sources.get("rateLimits.requests.burst")).toMatchObject({
      kind: "env",
      name: "CANOPY_RATE_LIMIT_REQUEST_BURST",
    })
  })

  it("turns off with false in the file or with CANOPY_RATE_LIMITS=false", () => {
    expect(resolve({ mongodb: { uri: URI }, rateLimits: false }).config.rateLimits).toBe(false)
    expect(
      resolve({ mongodb: { uri: URI } }, { CANOPY_RATE_LIMITS: "false" }).config.rateLimits,
    ).toBe(false)
    expect(
      resolve({ mongodb: { uri: URI }, rateLimits: { enabled: false } }).config.rateLimits,
    ).toBe(false)
  })

  it("refuses a bucket that could never hold a token, and a variable against a disabled file", () => {
    expect(
      problems(() =>
        resolve({ mongodb: { uri: URI }, rateLimits: { requests: { perSecond: 0, burst: 0 } } }),
      ).map((problem) => problem.path),
    ).toEqual(["rateLimits.requests.perSecond", "rateLimits.requests.burst"])
    expect(
      problems(() =>
        resolve({ mongodb: { uri: URI }, rateLimits: false }, { CANOPY_RATE_LIMIT_REQUESTS: "5" }),
      )[0]?.path,
    ).toBe("rateLimits.requests.perSecond")
  })
})

describe("webhooks", () => {
  const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"

  it("defaults to no hooks, eight attempts and a ten second timeout", () => {
    expect(resolve({ mongodb: { uri: URI } }).config.webhooks).toEqual({
      secret: undefined,
      maxAttempts: 8,
      timeoutMs: 10_000,
      triggers: {},
      schedules: {},
    })
  })

  it("resolves triggers and schedules, with every operation by default and the secret from the environment", () => {
    const resolution = resolve(
      {
        mongodb: { uri: URI },
        webhooks: {
          timeout: "3s",
          triggers: {
            placed: { collection: "orders", filter: { status: "placed" }, url: env("HOOK_URL") },
          },
          schedules: {
            nightly: { cron: "@daily", url: "https://fn.example.com/n", body: { a: 1 } },
          },
        },
      },
      { CANOPY_WEBHOOK_SECRET: SECRET, HOOK_URL: "https://hooks.example.com/placed" },
    )
    expect(resolution.config.webhooks).toEqual({
      secret: SECRET,
      maxAttempts: 8,
      timeoutMs: 3000,
      triggers: {
        placed: {
          collection: "orders",
          operations: ["insert", "update", "replace", "delete"],
          filter: { status: "placed" },
          url: "https://hooks.example.com/placed",
        },
      },
      schedules: { nightly: { cron: "@daily", url: "https://fn.example.com/n", body: { a: 1 } } },
    })
    expect(formatConfig(resolution)).not.toContain(SECRET)
  })

  it("reports missing secrets, bad names, cron expressions, URLs and shared names together", () => {
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          webhooks: {
            maxAttempts: 0,
            triggers: {
              "1bad": { collection: "orders", url: "https://a.example.com" },
              noCollection: { collection: "system.views", url: "https://a.example.com" },
              ftp: { collection: "orders", url: "ftp://a.example.com" },
              shared: {
                collection: "orders",
                operations: ["insert"],
                url: "https://a.example.com",
              },
            },
            schedules: {
              never: { cron: "0 0 30 2 *", url: "https://a.example.com" },
              shared: { cron: "@hourly", url: "https://a.example.com" },
              typo: { cron: "61 * * * *", url: "https://a.example.com" },
            },
          },
        }),
      ).map((problem) => problem.path),
    ).toEqual([
      "webhooks.maxAttempts",
      "webhooks.triggers.1bad",
      "webhooks.triggers.noCollection.collection",
      "webhooks.triggers.ftp.url",
      "webhooks.schedules.never.cron",
      "webhooks.schedules.shared",
      "webhooks.schedules.typo.cron",
      "webhooks.secret",
    ])
  })

  it("refuses a short secret and an operation that is not a change", () => {
    const found = problems(() =>
      resolve({
        mongodb: { uri: URI },
        webhooks: {
          secret: "short",
          triggers: {
            a: {
              collection: "orders",
              operations: ["insert", "drop" as never],
              url: "https://a.example.com",
            },
          },
        },
      }),
    )
    expect(found.map((problem) => problem.path)).toEqual([
      "webhooks.triggers.a.operations",
      "webhooks.secret",
    ])
    expect(found[1]?.message).toMatch(/at least 16/)
  })
})

describe("storage", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef"
  const buckets = { avatars: { public: true } }

  it("is off without buckets and on local disk next to the config file by default", () => {
    expect(resolve({ mongodb: { uri: URI } }).config.storage).toBe(false)
    expect(resolve({ mongodb: { uri: URI }, storage: { buckets } }).config.storage).toEqual({
      backend: { kind: "local", root: "/project/canopy/storage" },
      maxUploadSize: 5 * 1024 * 1024 * 1024,
      images: { enabled: true, maxDimension: 2500, maxSourceSize: 25 * 1024 * 1024 },
      buckets: { avatars: { public: true, maxFileSize: 50 * 1024 * 1024, allowedTypes: [] } },
    })
  })

  it("resolves a local root against the config folder, or the working directory from the environment", () => {
    const local = (
      root: string | ReturnType<typeof env>,
      variables: Record<string, string> = {},
    ) => {
      const storage = resolve(
        { mongodb: { uri: URI }, storage: { backend: { kind: "local", root }, buckets } },
        variables,
      ).config.storage
      return storage === false ? undefined : storage.backend
    }
    expect(local("../data/files")).toEqual({ kind: "local", root: "/project/data/files" })
    expect(local("/srv/canopy")).toEqual({ kind: "local", root: "/srv/canopy" })
    expect(local("D:\\files")).toEqual({ kind: "local", root: "D:\\files" })
    expect(local(env("FILES_ROOT"), { FILES_ROOT: "uploads" })).toEqual({
      kind: "local",
      root: "/project/uploads",
    })
  })

  it("builds R2 and S3 backends and masks their secrets", () => {
    const r2 = resolve(
      {
        mongodb: { uri: URI },
        storage: {
          backend: {
            kind: "r2",
            accountId: ACCOUNT,
            bucket: "files",
            accessKeyId: "AK",
            secretAccessKey: env("R2_SECRET"),
            jurisdiction: "eu",
          },
          buckets,
        },
      },
      { R2_SECRET: "r2-secret-value" },
    )
    expect(r2.config.storage === false ? undefined : r2.config.storage.backend).toEqual({
      kind: "r2",
      accountId: ACCOUNT,
      bucket: "files",
      accessKeyId: "AK",
      secretAccessKey: "r2-secret-value",
      jurisdiction: "eu",
      prefix: "",
    })
    expect(formatConfig(r2)).not.toContain("r2-secret-value")
    const s3 = (backend: Record<string, unknown>) => {
      const storage = resolve({
        mongodb: { uri: URI },
        storage: {
          backend: {
            kind: "s3",
            region: "eu-west-1",
            bucket: "files",
            accessKeyId: "AK",
            secretAccessKey: "SK",
            ...backend,
          } as never,
          buckets,
        },
      }).config.storage
      return storage === false ? undefined : storage.backend
    }
    expect(s3({})).toMatchObject({ kind: "s3", endpoint: undefined, forcePathStyle: false })
    expect(s3({ endpoint: "http://localhost:9000" })).toMatchObject({
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
    })
    expect(s3({ endpoint: "http://localhost:9000", forcePathStyle: false })).toMatchObject({
      forcePathStyle: false,
    })
  })

  it("reports missing and malformed backend settings, an unknown kind and image limits", () => {
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          storage: { backend: { kind: "r2", accountId: "not-hex", bucket: "b" } as never, buckets },
        }),
      ).map((problem) => problem.path),
    ).toEqual([
      "storage.backend.accessKeyId",
      "storage.backend.secretAccessKey",
      "storage.backend.accountId",
    ])
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          storage: { backend: { kind: "s3", bucket: "b" } as never, buckets },
        }),
      ).map((problem) => problem.path),
    ).toEqual([
      "storage.backend.region",
      "storage.backend.accessKeyId",
      "storage.backend.secretAccessKey",
    ])
    const gridfs = problems(() =>
      resolve({
        mongodb: { uri: URI },
        storage: { backend: { kind: "gridfs" } as never, buckets },
      }),
    )
    expect(gridfs.map((problem) => problem.path)).toEqual(["storage.backend.kind"])
    expect(gridfs[0]?.message).toContain('{ kind: "local", root }')
    expect(
      problems(() =>
        resolve({
          mongodb: { uri: URI },
          storage: { images: { maxDimension: 0, maxSourceSize: 0 }, buckets },
        }),
      ).map((problem) => problem.path),
    ).toEqual(["storage.images.maxDimension", "storage.images.maxSourceSize"])
  })

  it("turns image transformations off from the environment", () => {
    const storage = resolve(
      { mongodb: { uri: URI }, storage: { buckets } },
      { CANOPY_STORAGE_IMAGES: "false" },
    ).config.storage
    expect(storage === false ? undefined : storage.images.enabled).toBe(false)
  })
})
