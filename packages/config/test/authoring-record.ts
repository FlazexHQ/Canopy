import { readFile } from "node:fs/promises"
import { decode, toCanonical } from "@canopy/protocol"
import { Ajv2020 } from "ajv/dist/2020.js"
import { builtin, defineConfig, email, env, external, isEnvMarker } from "canopy.js/config"
import ts from "typescript"
import { parseEnvFile } from "../src/load.ts"
import { ConfigError } from "../src/resolution.ts"
import { formatConfig, resolveConfig } from "../src/resolve.ts"
import type { ConfigContext } from "../src/types.ts"

const repo = new URL("../../../", import.meta.url)
const mongo = "mongodb://127.0.0.1:27017/authoring?replicaSet=rs0"
const canary = "fixture-only-secret-that-must-stay-out-of-the-bundle"
const file = "/project/canopy.config.ts"
const contexts = (["development", "production"] as const).flatMap((mode) =>
  (["start", "dev", "realtime", "gen", "policies", "doctor", "print"] as const).map((command) => ({
    mode,
    command,
  })),
)
const standardContext: ConfigContext = { mode: "development", command: "start" }

interface Fixture {
  name: string
  source: string
  origin?: string
  bindings?: Record<string, unknown>
  environment?: Record<string, string>
  envText?: string
  context?: ConfigContext
  futureClaims?: true
}

class EmissionError extends TypeError {
  readonly code = "CANOPY_CONFIG_INVALID"
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path || "/"}: ${message}`)
    this.path = path
  }
}

function pointer(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function convert(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
  raw = false,
): unknown {
  if (typeof value === "function")
    throw new EmissionError(
      path,
      path === "/config/auth/claims"
        ? "Use an HTTPS claims hook with a secret reference"
        : "Functions cannot be emitted",
    )
  if (typeof value === "symbol") throw new EmissionError(path, "Symbols cannot be emitted")
  if (isEnvMarker(value)) {
    if (raw) throw new EmissionError(path, "Environment references belong at config settings")
    const { name, kind, secret, optional, fallback } = value
    return {
      $env: {
        name,
        type: kind,
        secret,
        optional,
        ...(fallback === undefined
          ? {}
          : { default: convert(fallback, pointer(pointer(path, "$env"), "default")) }),
      },
    }
  }

  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) throw new EmissionError(path, "Cycles cannot be emitted")
    ancestors.add(value)
    try {
      if (Array.isArray(value))
        return Array.from(value, (item, index) => {
          const child = pointer(path, String(index))
          if (item === undefined && !raw)
            throw new EmissionError(child, "Array elements must have values")
          return convert(item, child, ancestors, raw)
        })
      if (plain(value)) {
        if (!raw && (Object.hasOwn(value, "$env") || Object.hasOwn(value, "$ejson")))
          throw new EmissionError(path, "Reserved authoring key")
        const fields = Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => {
              const child = pointer(path, key)
              const ejson =
                !raw &&
                (child === "/config/auth/jwks" ||
                  /^\/config\/webhooks\/(?:triggers\/[^/]+\/filter|schedules\/[^/]+\/body)$/.test(
                    child,
                  ))
              const converted = convert(item, child, ancestors, raw || ejson)
              return [key, ejson ? { $ejson: converted } : converted]
            }),
        )
        return raw && Object.keys(fields).some((key) => key.startsWith("$"))
          ? { $literal: fields }
          : fields
      }
      if (!raw) throw new EmissionError(path, "Expected a plain config object")
    } finally {
      ancestors.delete(value)
    }
  }
  if (raw) {
    try {
      return toCanonical(value)
    } catch (error: unknown) {
      throw new EmissionError(
        path,
        error instanceof Error ? error.message : "Expected a BSON value",
      )
    }
  }
  if (typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value)))
    throw new EmissionError(path, "Expected a JSON value")
  return value
}

function restoreRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreRaw)
  if (!plain(value)) return value
  const literal = value["$literal"]
  if (plain(literal))
    return Object.fromEntries(Object.entries(literal).map(([key, item]) => [key, restoreRaw(item)]))
  if (Object.keys(value).some((key) => key.startsWith("$"))) return decode(value)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreRaw(item)]))
}

function restore(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restore)
  if (!plain(value)) return value
  const bson = value["$ejson"]
  if (bson !== undefined) return restoreRaw(bson)
  const marker = value["$env"]
  if (plain(marker)) {
    const { name, type, optional, secret, default: fallback } = marker
    if (typeof name !== "string") throw new Error("Expected an environment variable name")
    switch (type) {
      case "string":
        if (secret === true) return optional === true ? env.secret.optional(name) : env.secret(name)
        return optional === true
          ? env.optional(name)
          : env(name, fallback === undefined ? {} : { default: fallback as string })
      case "int":
        return optional === true
          ? env.int.optional(name)
          : env.int(name, fallback === undefined ? {} : { default: fallback as number })
      case "bool":
        return optional === true
          ? env.bool.optional(name)
          : env.bool(name, fallback === undefined ? {} : { default: fallback as boolean })
      case "list":
        return optional === true
          ? env.list.optional(name)
          : env.list(name, fallback === undefined ? {} : { default: fallback as string[] })
      case "url":
        return optional === true
          ? env.url.optional(name)
          : env.url(name, fallback === undefined ? {} : { default: fallback as string })
      case "duration":
        return optional === true
          ? env.duration.optional(name)
          : env.duration(name, fallback === undefined ? {} : { default: fallback as number })
      default:
        throw new Error("Expected an environment variable type")
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)]))
}

function resolution(input: unknown, fixture: Fixture, context: ConfigContext) {
  const fromFile = parseEnvFile(fixture.envText ?? "")
  const envFiles = new Map(
    [...fromFile.keys()]
      .filter((name) => !Object.hasOwn(fixture.environment ?? {}, name))
      .map((name) => [name, "/project/.env.local"]),
  )
  try {
    const resolved = resolveConfig(input, {
      env: { ...Object.fromEntries(fromFile), ...fixture.environment },
      envFiles,
      command: context.command,
      file,
      baseDir: "/project",
      cwd: "/working",
    })
    return {
      config: resolved.config,
      sources: Object.fromEntries(resolved.sources),
      secrets: [...resolved.secrets],
      printWithSources: formatConfig(resolved, { sources: true }),
    }
  } catch (error: unknown) {
    if (!(error instanceof ConfigError)) throw error
    return {
      code: error.code,
      problems: error.problems.map(({ path, ...problem }) => ({
        path: path === "" ? "/config" : path.split(".").reduce(pointer, "/config"),
        resolverPath: path,
        ...problem,
      })),
    }
  }
}

function evaluate(fixture: Fixture) {
  const bindings = { defineConfig, env, builtin, email, external, mongo, ...fixture.bindings }
  const context = fixture.context ?? standardContext
  const metadata = { ...fixture, context }
  const exported: unknown = new Function(...Object.keys(bindings), `return (${fixture.source})`)(
    ...Object.values(bindings),
  )
  const input: unknown = typeof exported === "function" ? exported(context) : exported
  let config: unknown
  try {
    config = convert(input, "/config")
  } catch (error: unknown) {
    if (!(error instanceof EmissionError)) throw error
    return {
      ...metadata,
      emissionError: { code: error.code, path: error.path, message: error.message },
    }
  }
  const document = { version: 1, config }
  const expected = resolution(input, fixture, context)
  const replay = resolution(restore(config), fixture, context)
  if (JSON.stringify(expected) !== JSON.stringify(replay))
    throw new Error(`Config round trip differs for ${fixture.name}`)
  if (
    fixture.name === "secret-canary" &&
    (JSON.stringify(document).includes(canary) ||
      !("config" in expected) ||
      expected.config.server.metricsToken !== canary ||
      expected.printWithSources?.includes(canary))
  )
    throw new Error("Secret canary failed")
  return { ...metadata, document, expected }
}

async function projectFixture(
  origin: string,
  bindings?: Record<string, unknown>,
): Promise<Fixture> {
  const text = (await readFile(new URL(origin, repo), "utf8")).replaceAll("\r\n", "\n")
  const parsed = ts.createSourceFile(origin, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const matches: ts.CallExpression[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig"
    )
      matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  const [match] = matches
  if (matches.length !== 1 || match === undefined)
    throw new Error(`Expected one defineConfig call in ${origin}`)
  return {
    name: origin,
    origin,
    source: match.getText(parsed),
    ...(bindings === undefined ? {} : { bindings }),
  }
}

const full = `defineConfig({
  mongodb: { uri: env("APP_URI", { default: mongo }), database: env("APP_DB", { default: "authoring" }), metaDatabase: "meta", authDatabase: "identity" },
  environment: "development", publicUrl: env.url("APP_URL"),
  masterKey: env.secret("MASTER"), previousMasterKeys: env.list.optional("OLD_KEYS"),
  keys: { publishable: env.list("PUBLIC_KEYS", { default: ["pk_authoring"] }), secret: ["sk_authoring"] },
  policies: { dir: "./policies", watch: false },
  rest: { defaultLimit: 10, maxLimit: 200, maxBodyBytes: 10000, mutationTtl: "2h" },
  graphql: { maxDepth: 6, maxComplexity: 300, maxAliases: 2, maxBatch: 3, introspection: "authenticated", persisted: { file: "queries.json", only: true } },
  realtime: { fullDocument: "images", transports: ["websocket", "sse"], resumeWindow: env.duration("RESUME", { default: 1500 }), checkpoints: "off", drainWindow: 500, echoTimeout: "2.5s", server: "gateway" },
  rateLimits: { enabled: true, requests: { perSecond: 3, burst: 4 }, messages: { perSecond: 5, burst: 6 }, failedAuthentications: { perSecond: 2, burst: 8 }, anonymousConnectionsPerAddress: 9, exemptService: false },
  collections: { notes: { idType: "string", typeName: "Note", search: true, relations: { author: { to: "users", local: "authorId", foreign: "_id", many: false } } } },
  cors: { origins: env.list("ORIGINS") }, audit: { dataWrites: true },
  storage: { backend: { kind: "local", root: env("STORAGE_ROOT") }, maxFileSize: 1024, maxUploadSize: 2048, images: { enabled: false, maxDimension: 20, maxSourceSize: 512 }, buckets: { photos: { public: true, maxFileSize: 1024, allowedTypes: ["image/png"] } } },
  webhooks: { secret: env.secret("HOOK_KEY"), maxAttempts: 2, timeout: "800ms", triggers: { note: { collection: "notes", operations: ["insert", "update", "replace", "delete"], filter: { active: true, amount: { $gt: 2 } }, url: "https://hooks.example.test/note" } }, schedules: { daily: { cron: "0 0 * * *", body: { reason: "daily", at: new Date("2026-11-25T00:00:00Z"), literal: { $date: "text" } }, url: "https://hooks.example.test/daily" } } },
  telemetry: { tracing: true },
  server: { port: env.int("APP_PORT", { default: 7000 }), metricsPort: env.int.optional("STATS_PORT"), metricsHost: "127.0.0.1", metricsToken: env.secret.optional("STATS_TOKEN"), adminListen: "127.0.0.1:8888", nodeId: "fixture", trustedProxies: ["127.0.0.1/32"], engine: "auto" },
  log: { level: "debug" }, types: { out: "./types.ts", role: "viewer" }, dev: { insecure: env.bool("INSECURE", { default: false }) }
})`

const auths = [
  'external({ jwksUrl: env.url("JWKS_URL", { default: "https://id.example.test/jwks" }), issuer: "https://id.example.test/", audience: "notes", algorithms: ["ES256"], rolesClaim: "roles", allowServiceRoleFromJwt: false, clockToleranceSeconds: 5 })',
  'external.auth0({ domain: "tenant.auth0.com", audience: "notes", rolesClaim: "roles" })',
  'external.clerk({ frontendApi: "tenant.clerk.accounts.dev", audience: "notes", rolesClaim: "roles" })',
  'external.firebase({ projectId: "fixture-app", rolesClaim: "roles" })',
  'external.supabase({ projectRef: "abcdefghijklmnopqrst", rolesClaim: "roles" })',
]
const transports = [
  "email.log()",
  'email.smtp({ host: "smtp.example.test", port: 587, secure: false, requireTls: true, user: "fixture", pass: env.secret("MAIL_KEY") })',
  'email.resend({ apiKey: env.secret("MAIL_KEY") })',
  'email.postmark({ serverToken: env.secret("MAIL_KEY"), messageStream: "outbound" })',
  'email.ses({ region: "us-east-1", accessKeyId: "fixture", secretAccessKey: env.secret("MAIL_KEY"), sessionToken: env.secret.optional("MAIL_SESSION") })',
]
const functionSource = `(() => {
  let calls = 0
  return defineConfig(({ mode, command }) => {
    if (++calls !== 1) throw new Error("Config function was evaluated more than once")
    return {
      mongodb: { uri: mongo },
      environment: mode,
      masterKey: env.secret("MASTER"),
      log: { level: command === "dev" ? "debug" : "info" },
    }
  })
})()`

/** Records config authoring and TypeScript resolution for explicitly supplied fixture environments. */
export async function recordConfigAuthoring() {
  const options = {
    mongoUri: mongo,
    database: "example",
    publicUrl: "http://localhost:3000",
    publishableKey: "pk_example",
  }
  const fixtures: Fixture[] = [
    await projectFixture("deploy/dev/canopy.config.ts"),
    await projectFixture("examples/next-ssr/canopy/server.ts", { env: {}, database: "next_ssr" }),
    ...(await Promise.all(
      ["auth-notes", "graphql-vue"].map((name) =>
        projectFixture(`examples/${name}/src/app.ts`, { options, masterKey: "a".repeat(48) }),
      ),
    )),
    {
      name: "express-dropin-sidecar",
      origin: "examples/express-dropin/canopy.env.example",
      source: "defineConfig({})",
      envText: (
        await readFile(new URL("examples/express-dropin/canopy.env.example", repo), "utf8")
      ).replaceAll("\r\n", "\n"),
      context: { mode: "development", command: "realtime" },
    },
    {
      name: "todo-react-embedded-equivalent",
      origin: "examples/todo-react/src/app.ts",
      source:
        'defineConfig({ mongodb: { uri: mongo, database: "todo", metaDatabase: "todo_meta" }, keys: { publishable: ["pk_todo_local"] }, realtime: { checkpoints: "off" } })',
    },
    ...(await Promise.all(
      ["rest", "rest-writes", "split-roles", "sharded", "auth"].map((name) =>
        projectFixture(`packages/sdk-e2e/test/${name}.e2e.test.ts`, {
          MONGODB_URI: mongo,
          SHARDED_URI: mongo,
          name: "sdk_fixture",
          names: { database: "sdk_fixture", metaDatabase: "sdk_meta", authDatabase: "sdk_auth" },
          url: "http://localhost:3000",
          KEY: "pk_sdk",
          ISSUER: "https://issuer.example.test/",
          AUDIENCE: "https://api.example.test",
          jwk: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
        }),
      ),
    )),
    ...["e2e", "mutations.e2e", "offline.e2e", "fallback.e2e"].map((name) => ({
      name: `sdk-embedded-${name}`,
      origin: `packages/sdk-e2e/test/${name}.test.ts`,
      source: `defineConfig({
        mongodb: { uri: mongo, database: "sdk_fixture", metaDatabase: "sdk_fixture_meta" },
        auth: external({ jwks: { keys: [jwk] }, issuer: "iss", audience: "aud" }),
        keys: { publishable: ${name === "fallback.e2e" ? '["pk"]' : "[]"} },
        realtime: { checkpoints: "off" },
      })`,
      bindings: {
        jwk: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
      },
      environment: { CANOPY_ENGINE: "ts" },
    })),
    {
      name: "all-sections",
      source: full,
      envText: "APP_PORT=7001\nAPP_URL=https://from-file.example.test\nSTORAGE_ROOT=./images\n",
      environment: {
        APP_URL: "https://app.example.test",
        MASTER: "m".repeat(48),
        HOOK_KEY: "h".repeat(48),
        ORIGINS: "https://app.example.test,https://other.example.test",
      },
    },
    {
      name: "secret-canary",
      source:
        'defineConfig({ mongodb: { uri: mongo }, server: { metricsToken: env.secret("TOKEN") } })',
      environment: { TOKEN: canary },
    },
    {
      name: "https-claims",
      source:
        'defineConfig({ auth: { kind: "builtin", claims: { url: "https://hooks.example.test/claims", secret: env.secret("CLAIMS_KEY") } } })',
      futureClaims: true,
    },
    {
      name: "function-in-array",
      source:
        'defineConfig({ webhooks: { schedules: { "a/b~c": { body: { values: [() => 1] } } } } })',
    },
    {
      name: "missing-env",
      source: 'defineConfig({ mongodb: { uri: mongo }, server: { port: env.int("UNSET") } })',
    },
    {
      name: "missing-env-irrelevant",
      source: 'defineConfig({ mongodb: { uri: mongo }, server: { port: env.int("UNSET") } })',
      context: { mode: "development", command: "gen" },
    },
    {
      name: "env-conflict",
      source: "defineConfig({ mongodb: { uri: mongo }, server: { port: 9000 } })",
      environment: { PORT: "9001" },
    },
    {
      name: "invalid-duration",
      source:
        'defineConfig({ mongodb: { uri: mongo }, realtime: { resumeWindow: env.duration("RESUME") } })',
      environment: { RESUME: "tomorrow" },
    },
    {
      name: "out-of-range",
      source: "defineConfig({ mongodb: { uri: mongo }, server: { port: 65536 } })",
    },
    {
      name: "toggles-and-database-source",
      source:
        'defineConfig({ mongodb: { uri: mongo }, rest: false, graphql: false, realtime: true, rateLimits: false, policies: { source: "database" }, cors: { origins: "*" } })',
    },
    ...auths.map((auth, index) => ({
      name: `auth-${index}`,
      source: `defineConfig({ mongodb: { uri: mongo }, auth: ${auth} })`,
    })),
    ...transports.map((transport, index) => ({
      name: `email-${index}`,
      source: `defineConfig({ mongodb: { uri: mongo }, publicUrl: "http://localhost:3000", auth: builtin({
      secret: env.secret("AUTH_KEY"), appName: "Notes", accessTokenTtl: "10m", algorithm: "ES256",
      keyRotation: { interval: "14d", grace: "2d" }, redirectUrls: ["http://localhost:3000/done"],
      emailPassword: { minPasswordLength: 12, requireEmailVerification: false }, magicLink: false, emailOtp: false,
      anonymous: env.bool.optional("ANONYMOUS"), passkeys: false, twoFactor: false,
      providers: {
        google: { clientId: "fixture", clientSecret: env.secret("OAUTH_KEY") },
        github: { clientId: "fixture", clientSecret: env.secret("OAUTH_KEY") },
        apple: { clientId: "fixture", clientSecret: env.secret("OAUTH_KEY") },
        discord: { clientId: "fixture", clientSecret: env.secret("OAUTH_KEY") },
        microsoft: { clientId: "fixture", clientSecret: env.secret("OAUTH_KEY"), tenantId: "common" },
      },
      oidc: [{ id: "example", discoveryUrl: "https://issuer.example.test/.well-known/openid-configuration", clientId: "fixture", clientSecret: env.secret("OAUTH_KEY"), scopes: ["openid", "email"] }],
      trustedProxies: ["::1"], identifierLimit: { max: 5, window: "2m" }, session: { expiresIn: "8d", updateAge: "2d" },
      email: { from: "notes@example.test", transport: ${transport} },
    }) })`,
      environment: {
        AUTH_KEY: "a".repeat(48),
        MAIL_KEY: "fixture-mail",
        OAUTH_KEY: "fixture-oauth",
      },
    })),
    ...["r2", "s3"].map((kind) => ({
      name: `storage-${kind}`,
      source: `defineConfig({ mongodb: { uri: mongo }, storage: { backend: {
      kind: "${kind}", bucket: "fixture", accessKeyId: "access", secretAccessKey: env.secret("STORAGE_KEY"), prefix: "media/",
      ${kind === "r2" ? 'accountId: "0123456789abcdef0123456789abcdef", jurisdiction: "eu"' : 'region: "us-east-1", endpoint: "https://storage.example.test", sessionToken: env.secret.optional("SESSION_TOKEN"), forcePathStyle: true'}
    } } })`,
      environment: { STORAGE_KEY: "fixture-storage-key" },
    })),
    ...contexts.map((context) => ({
      name: `function-${context.mode}-${context.command}`,
      source: functionSource,
      context,
      environment: { CANOPY_ENV: context.mode, MASTER: "m".repeat(48) },
    })),
  ]
  const validate = new Ajv2020({
    strict: true,
    strictRequired: false,
    ownProperties: true,
  }).compile(
    JSON.parse(await readFile(new URL("conformance/authoring/config.schema.json", repo), "utf8")),
  )
  const vectors = fixtures.map(evaluate)
  for (const vector of vectors) {
    if ("document" in vector && !validate(vector.document))
      throw new Error(`${vector.name}: ${JSON.stringify(validate.errors)}`)
  }
  return vectors
}
