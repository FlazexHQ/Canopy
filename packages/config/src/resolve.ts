import { CanopyError, ErrorCode } from "@canopy/protocol"
import { isEnvMarker, parseDuration } from "./env.ts"
import type {
  Command,
  Environment,
  FullDocumentMode,
  IdType,
  LogLevel,
  ResolvedBuiltinAuth,
  ResolvedConfig,
  ResolvedEmailTransport,
  ResolvedExternalAuth,
  Transport,
} from "./types.ts"

const RESOLVED: unique symbol = Symbol.for("canopy.config.resolved")

/** Whether a value is a config returned by {@link resolveConfig} (or `loadConfig`). */
export function isResolvedConfig(value: unknown): value is ResolvedConfig {
  return typeof value === "object" && value !== null && Object.hasOwn(value, RESOLVED)
}

/** Where a resolved value came from. */
export type Source =
  | { readonly kind: "default" }
  | { readonly kind: "file" }
  | {
      readonly kind: "env"
      readonly name: string
      /** The env file the variable was read from, or `undefined` for the process environment. */
      readonly envFile: string | undefined
    }

/** One reason a config does not validate. */
export interface ConfigProblem {
  /** The dotted setting path, for example `mongodb.uri`. */
  readonly path: string
  readonly message: string
  /** True when only an unset variable is missing; such problems are ignored by commands that do not need the section. */
  readonly missing: boolean
}

/** Thrown when a config does not validate. Lists every problem at once. */
export class ConfigError extends CanopyError {
  readonly problems: readonly ConfigProblem[]

  constructor(file: string | undefined, problems: readonly ConfigProblem[]) {
    const where = file ?? "the environment"
    const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`
    const body = problems
      .map((problem) => `  ${problem.path}\n${indent(problem.message, "    ")}`)
      .join("\n\n")
    super(
      ErrorCode.ConfigInvalid,
      `canopy: ${where} has ${count}\n\n${body}\n\nRun canopy config print --sources to see the resolved values and where they came from.`,
      { details: { problems: problems.map(({ path, message }) => ({ path, message })) } },
    )
    this.name = "ConfigError"
    this.problems = problems
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")
}

/** Options of {@link resolveConfig}. */
export interface ResolveOptions {
  /** The variables, after env files were merged in (the process environment wins). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** For variables that came from an env file: the file. */
  readonly envFiles?: ReadonlyMap<string, string>
  /** The config file, or `undefined` in zero config mode. */
  readonly file?: string
  /** The directory paths in the config file are relative to. */
  readonly baseDir: string
  /** The working directory, which paths from variables are relative to. */
  readonly cwd: string
  readonly command: Command
}

/** A resolved config with the source of every value. */
export interface Resolution {
  readonly config: ResolvedConfig
  readonly sources: ReadonlyMap<string, Source>
  /** Paths whose values must never be printed. */
  readonly secrets: ReadonlySet<string>
}

/** A numeric bound of a setting, checked after defaults are applied. */
interface Range {
  readonly min?: number
  readonly max?: number
  readonly message: (value: number) => string
}

/** What a setting may add to its type: a default for when it is unset, and a numeric range. */
interface Constraints {
  readonly def?: unknown
  readonly range?: Range
}

type Spec = (
  | { readonly t: "string" | "url" | "int" | "bool" | "list" | "duration" | "raw" }
  | { readonly t: "enum"; readonly values: readonly string[] }
  | { readonly t: "enums"; readonly values: readonly string[] }
  | { readonly t: "object"; readonly fields: Readonly<Record<string, Spec>> }
  | { readonly t: "record"; readonly of: Spec }
  | { readonly t: "toggle"; readonly of: Spec }
  | { readonly t: "origins" }
  | { readonly t: "auth" }
  | { readonly t: "policies" }
  | { readonly t: "function" }
  | { readonly t: "objects"; readonly of: Spec }
  | {
      readonly t: "tagged"
      readonly kinds: Readonly<Record<string, Readonly<Record<string, Spec>>>>
      readonly hint: string
    }
) &
  Constraints

const str: Spec = { t: "string" }
const url: Spec = { t: "url" }
const int: Spec = { t: "int" }
const bool: Spec = { t: "bool" }
const list: Spec = { t: "list" }
const duration: Spec = { t: "duration" }
const oneOf = (...values: string[]): Spec => ({ t: "enum", values })
const obj = (fields: Record<string, Spec>): Spec => ({ t: "object", fields })
/** A setting with a default, applied when it is unset and recorded with a `default` source. */
const withDefault = (spec: Spec, def: unknown, range?: Range): Spec => ({
  ...spec,
  def,
  ...(range === undefined ? {} : { range }),
})

const MINUTE = 60_000
const DAY = 86_400_000
const PORT: Range = {
  min: 0,
  max: 65_535,
  message: (value) => `Received ${value}.\nExpected a port between 0 and 65535.`,
}

const ENVIRONMENTS = ["development", "production"] as const
const FULL_DOCUMENT = ["auto", "updateLookup", "images"] as const
const TRANSPORTS = ["websocket", "sse", "long-poll"] as const
const ID_TYPES = ["auto", "objectId", "string", "uuid", "number"] as const
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const

const OAUTH_CLIENT = { clientId: str, clientSecret: str }

const EMAIL_TRANSPORTS: Readonly<Record<string, Readonly<Record<string, Spec>>>> = {
  smtp: { kind: str, host: str, port: int, secure: bool, requireTls: bool, user: str, pass: str },
  resend: { kind: str, apiKey: str },
  postmark: { kind: str, serverToken: str, messageStream: str },
  ses: { kind: str, region: str, accessKeyId: str, secretAccessKey: str, sessionToken: str },
  log: { kind: str },
}

const AUTH_KINDS: Readonly<Record<string, Readonly<Record<string, Spec>>>> = {
  builtin: {
    kind: str,
    secret: str,
    appName: withDefault(str, "Canopy"),
    accessTokenTtl: withDefault(duration, 10 * MINUTE, {
      min: 5 * MINUTE,
      max: 60 * MINUTE,
      message: () => "Access tokens live between 5 and 60 minutes.",
    }),
    algorithm: withDefault(oneOf("EdDSA", "ES256"), "EdDSA"),
    keyRotation: obj({
      interval: withDefault(duration, 30 * DAY, {
        min: 60 * MINUTE,
        message: () => "Keys sign for at least an hour.",
      }),
      grace: withDefault(duration, 30 * DAY),
    }),
    redirectUrls: list,
    emailPassword: {
      t: "toggle",
      of: obj({
        minPasswordLength: withDefault(int, 10, {
          min: 10,
          max: 128,
          message: () => "Use 10 to 128 characters.",
        }),
        requireEmailVerification: withDefault(bool, true),
      }),
    },
    magicLink: withDefault(bool, true),
    emailOtp: withDefault(bool, true),
    anonymous: withDefault(bool, false),
    providers: obj({
      google: obj(OAUTH_CLIENT),
      github: obj(OAUTH_CLIENT),
      apple: obj(OAUTH_CLIENT),
      microsoft: obj({ ...OAUTH_CLIENT, tenantId: str }),
      discord: obj(OAUTH_CLIENT),
    }),
    oidc: {
      t: "objects",
      of: obj({ id: str, discoveryUrl: url, clientId: str, clientSecret: str, scopes: list }),
    },
    claims: { t: "function" },
    email: obj({
      from: str,
      transport: {
        t: "tagged",
        kinds: EMAIL_TRANSPORTS,
        hint: "Use email.smtp(), email.resend(), email.postmark(), email.ses() or email.log().",
      },
    }),
    trustedProxies: withDefault(list, []),
    identifierLimit: obj({ max: withDefault(int, 10), window: withDefault(duration, MINUTE) }),
    session: obj({
      expiresIn: withDefault(duration, 7 * DAY),
      updateAge: withDefault(duration, DAY),
    }),
  },
  external: {
    kind: str,
    jwksUrl: url,
    jwks: { t: "raw" },
    issuer: str,
    audience: str,
    algorithms: list,
    rolesClaim: str,
    allowServiceRoleFromJwt: bool,
    clockToleranceSeconds: int,
  },
  auth0: { kind: str, domain: str, audience: str, rolesClaim: str },
  clerk: { kind: str, frontendApi: str, audience: str, rolesClaim: str },
  firebase: { kind: str, projectId: str, rolesClaim: str },
  supabase: { kind: str, projectRef: str, rolesClaim: str },
}

const ROOT_FIELDS: Readonly<Record<string, Spec>> = {
  mongodb: obj({
    uri: str,
    database: str,
    metaDatabase: withDefault(str, "canopy"),
    authDatabase: withDefault(str, "canopy_auth"),
  }),
  environment: withDefault(oneOf(...ENVIRONMENTS), "development"),
  publicUrl: url,
  masterKey: str,
  previousMasterKeys: list,
  auth: { t: "auth" },
  keys: obj({ publishable: withDefault(list, []), secret: withDefault(list, []) }),
  policies: { t: "policies" },
  rest: {
    t: "toggle",
    of: obj({
      defaultLimit: withDefault(int, 100),
      maxLimit: withDefault(int, 1000),
      maxBodyBytes: withDefault(int, 1024 * 1024),
      mutationTtl: withDefault(duration, DAY),
    }),
  },
  realtime: {
    t: "toggle",
    of: obj({
      fullDocument: withDefault(oneOf(...FULL_DOCUMENT), "auto"),
      transports: withDefault({ t: "enums", values: TRANSPORTS }, TRANSPORTS),
      resumeWindow: withDefault(duration, 120_000),
      checkpoints: withDefault(oneOf("meta", "off"), "meta"),
      drainWindow: withDefault(duration, 30_000),
    }),
  },
  collections: { t: "record", of: obj({ idType: oneOf(...ID_TYPES) }) },
  cors: obj({ origins: { t: "origins" } }),
  server: obj({
    port: withDefault(int, 8080, PORT),
    metricsPort: withDefault(int, 9464, PORT),
    adminListen: str,
    nodeId: withDefault(str, "n1"),
    trustedProxies: withDefault(list, []),
  }),
  log: obj({ level: withDefault(oneOf(...LOG_LEVELS), "info") }),
  types: obj({ out: str, role: str }),
  dev: obj({ insecure: withDefault(bool, false) }),
}

const ROOT: Spec = obj(ROOT_FIELDS)

/** Variables that configure Canopy without a config file. A config file may not contradict them. */
const WELL_KNOWN: readonly (readonly [string, string, Spec])[] = [
  ["MONGODB_URI", "mongodb.uri", str],
  ["CANOPY_DB", "mongodb.database", str],
  ["CANOPY_META_DB", "mongodb.metaDatabase", str],
  ["CANOPY_AUTH_DB", "mongodb.authDatabase", str],
  ["CANOPY_ENV", "environment", oneOf(...ENVIRONMENTS)],
  ["CANOPY_PUBLIC_URL", "publicUrl", url],
  ["CANOPY_MASTER_KEY", "masterKey", str],
  ["CANOPY_MASTER_KEY_PREVIOUS", "previousMasterKeys", list],
  ["CANOPY_JWT_JWKS_URL", "auth.jwksUrl", url],
  ["CANOPY_JWT_ISSUER", "auth.issuer", str],
  ["CANOPY_JWT_AUDIENCE", "auth.audience", str],
  ["CANOPY_JWT_ALGORITHMS", "auth.algorithms", list],
  ["CANOPY_JWT_ROLES_CLAIM", "auth.rolesClaim", str],
  ["CANOPY_PUBLISHABLE_KEYS", "keys.publishable", list],
  ["CANOPY_SECRET_KEYS", "keys.secret", list],
  ["CANOPY_POLICIES", "policies.dir", str],
  ["CANOPY_MUTATION_TTL", "rest.mutationTtl", duration],
  ["CANOPY_REALTIME_FULL_DOCUMENT", "realtime.fullDocument", oneOf(...FULL_DOCUMENT)],
  ["CANOPY_RESUME_WINDOW", "realtime.resumeWindow", duration],
  ["CANOPY_CHECKPOINTS", "realtime.checkpoints", oneOf("meta", "off")],
  ["CANOPY_DRAIN_WINDOW", "realtime.drainWindow", duration],
  ["CANOPY_CORS_ORIGINS", "cors.origins", { t: "origins" }],
  ["PORT", "server.port", int],
  ["METRICS_PORT", "server.metricsPort", int],
  ["CANOPY_ADMIN_LISTEN", "server.adminListen", str],
  ["CANOPY_NODE_ID", "server.nodeId", str],
  ["CANOPY_TRUSTED_PROXIES", "server.trustedProxies", list],
  ["CANOPY_LOG_LEVEL", "log.level", oneOf(...LOG_LEVELS)],
  ["CANOPY_DEV_INSECURE", "dev.insecure", bool],
]

const SECRET_PATHS = new Set(["masterKey", "previousMasterKeys", "keys.secret"])

/** The sections each command needs. Unset variables elsewhere are not reported. */
const NEEDS: Readonly<Record<Command, ReadonlySet<string> | "all">> = {
  start: "all",
  dev: "all",
  print: "all",
  realtime: new Set([
    "mongodb",
    "environment",
    "auth",
    "keys",
    "policies",
    "realtime",
    "cors",
    "server",
    "log",
    "dev",
    "collections",
  ]),
  gen: new Set(["mongodb", "policies", "collections", "types", "environment"]),
  policies: new Set(["policies", "environment"]),
  doctor: new Set(["mongodb", "auth", "policies", "realtime", "environment", "publicUrl", "cors"]),
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] ?? 0
}

/** The closest candidate within a small edit distance, for "did you mean" hints. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(input.length / 3)) + 1
  for (const candidate of candidates) {
    const d = distance(input, candidate)
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "a list"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "object") return "an object"
  return String(value)
}

function quoted(values: readonly string[]): string {
  const parts = values.map((value) => JSON.stringify(value))
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} or ${parts.at(-1) ?? ""}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

class Resolver {
  readonly problems: ConfigProblem[] = []
  readonly sources = new Map<string, Source>()
  readonly secrets = new Set<string>(SECRET_PATHS)
  private readonly options: ResolveOptions

  constructor(options: ResolveOptions) {
    this.options = options
  }

  problem(path: string, message: string, missing = false): void {
    this.problems.push({ path, message, missing })
  }

  /** Parses text (from a variable) for a spec. */
  parseText(spec: Spec, text: string, path: string, label: string): unknown {
    const fail = (expected: string): undefined => {
      this.problem(
        path,
        `${label} is ${JSON.stringify(text)}.\nExpected ${expected}${expected.endsWith("?") ? "" : "."}`,
      )
      return undefined
    }
    switch (spec.t) {
      case "string":
        return text
      case "url":
        return URL.canParse(text.trim()) ? text.trim() : fail("an absolute URL")
      case "int":
        return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : fail("an integer")
      case "bool": {
        const value = text.trim().toLowerCase()
        if (value === "true" || value === "1") return true
        if (value === "false" || value === "0") return false
        return fail("true, false, 1 or 0")
      }
      case "list":
        return text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      case "duration": {
        const value = parseDuration(text)
        return value === undefined ? fail("a duration such as 500ms, 30s, 5m, 24h or 7d") : value
      }
      case "enum": {
        if (spec.values.includes(text.trim())) return text.trim()
        const near = suggest(text.trim(), spec.values)
        return fail(
          `${quoted(spec.values)}${near === undefined ? "" : `. Did you mean "${near}"?`}`,
        )
      }
      case "origins": {
        const items = text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
        return items.includes("*") ? "*" : items
      }
      default:
        return fail("a value that can be given as text")
    }
  }

  /** Validates a literal from the config file. */
  checkLiteral(spec: Spec, value: unknown, path: string): unknown {
    const wrong = (expected: string): undefined => {
      this.problem(
        path,
        `Received ${describe(value)}.\nExpected ${expected}${expected.endsWith("?") ? "" : "."}`,
      )
      return undefined
    }
    switch (spec.t) {
      case "string":
        return typeof value === "string" ? value : wrong("a string")
      case "url":
        return typeof value === "string" && URL.canParse(value) ? value : wrong("an absolute URL")
      case "int":
        return typeof value === "number" && Number.isSafeInteger(value)
          ? value
          : wrong("an integer")
      case "bool":
        return typeof value === "boolean" ? value : wrong("true or false")
      case "list":
        return Array.isArray(value) && value.every((item) => typeof item === "string")
          ? [...value]
          : wrong("a list of strings")
      case "duration":
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
        if (typeof value === "string") {
          const parsed = parseDuration(value)
          if (parsed !== undefined) return parsed
        }
        return wrong("milliseconds or a duration such as 500ms, 30s, 5m, 24h or 7d")
      case "enum": {
        if (typeof value === "string" && spec.values.includes(value)) return value
        const near = typeof value === "string" ? suggest(value, spec.values) : undefined
        return wrong(
          `${quoted(spec.values)}${near === undefined ? "" : `. Did you mean "${near}"?`}`,
        )
      }
      case "enums":
        if (
          Array.isArray(value) &&
          value.every((item) => typeof item === "string" && spec.values.includes(item))
        )
          return [...value]
        return wrong(`a list of ${quoted(spec.values)}`)
      case "origins":
        if (value === "*") return "*"
        return Array.isArray(value) && value.every((item) => typeof item === "string")
          ? [...value]
          : wrong('"*" or a list of origins')
      case "raw":
        return isPlainObject(value) ? value : wrong("an object")
      case "function":
        return typeof value === "function" ? value : wrong("a function")
      default:
        return wrong("a value")
    }
  }

  /** Walks the config file against the spec, resolving `env()` markers. */
  walk(spec: Spec, value: unknown, path: string): unknown {
    if (isEnvMarker(value)) {
      if (
        spec.t === "object" ||
        spec.t === "record" ||
        spec.t === "auth" ||
        spec.t === "policies" ||
        spec.t === "objects" ||
        spec.t === "tagged" ||
        spec.t === "function"
      )
        return this.checkLiteral(spec, value, path)
      const text = this.options.env[value.name]
      if (value.secret) this.secrets.add(path)
      if (text === undefined || text === "") {
        if (value.fallback !== undefined) {
          this.sources.set(path, { kind: "file" })
          return this.checkLiteral(spec, value.fallback, path)
        }
        if (!value.optional)
          this.problem(
            path,
            `${value.name} is not set.\nSet it in the environment${this.options.file === undefined ? "" : " or in an env file next to the config"}.`,
            true,
          )
        return undefined
      }
      this.sources.set(path, {
        kind: "env",
        name: value.name,
        envFile: this.options.envFiles?.get(value.name),
      })
      return this.parseText(spec, text, path, value.name)
    }
    if (value === undefined) return undefined
    switch (spec.t) {
      case "object":
        return this.walkObject(spec.fields, value, path)
      case "record": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
          const resolved = this.walk(spec.of, item, `${path}.${key}`)
          if (resolved !== undefined) out[key] = resolved
        }
        return out
      }
      case "toggle":
        if (value === true) return {}
        if (value === false) {
          this.sources.set(path, { kind: "file" })
          return false
        }
        return this.walk(spec.of, value, path)
      case "auth": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const kind = value["kind"]
        const fields = typeof kind === "string" ? AUTH_KINDS[kind] : undefined
        if (fields === undefined) {
          this.problem(
            `${path}.kind`,
            `Received ${describe(kind)}.\nUse builtin(), external(), external.auth0(), external.clerk(), external.firebase() or external.supabase().`,
          )
          return undefined
        }
        return this.walkObject(fields, value, path)
      }
      case "tagged": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const kind = value["kind"]
        const fields = typeof kind === "string" ? spec.kinds[kind] : undefined
        if (fields === undefined) {
          this.problem(`${path}.kind`, `Received ${describe(kind)}.\n${spec.hint}`)
          return undefined
        }
        return this.walkObject(fields, value, path)
      }
      case "objects": {
        if (!Array.isArray(value)) {
          this.problem(path, `Received ${describe(value)}.\nExpected a list.`)
          return undefined
        }
        return value.map((item, index) => this.walk(spec.of, item, `${path}.${index}`))
      }
      case "function": {
        const checked = this.checkLiteral(spec, value, path)
        if (checked !== undefined) this.sources.set(path, { kind: "file" })
        return checked
      }
      case "policies": {
        if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
        const fields: Record<string, Spec> = { dir: str, source: oneOf("database"), watch: bool }
        const out = this.walkObject(fields, value, path)
        if (isPlainObject(out)) {
          const hasDir = out["dir"] !== undefined
          const hasSource = out["source"] !== undefined
          if (hasDir === hasSource)
            this.problem(
              path,
              'Set either dir (a directory of policy files) or source: "database".',
            )
        }
        return out
      }
      default: {
        const checked = this.checkLiteral(spec, value, path)
        if (checked !== undefined) this.sources.set(path, { kind: "file" })
        return checked
      }
    }
  }

  private walkObject(
    fields: Readonly<Record<string, Spec>>,
    value: unknown,
    path: string,
  ): unknown {
    if (!isPlainObject(value)) return this.checkLiteral({ t: "raw" }, value, path)
    const out: Record<string, unknown> = {}
    const prefix = path === "" ? "" : `${path}.`
    for (const [key, item] of Object.entries(value)) {
      const spec = fields[key]
      if (spec === undefined) {
        const near = suggest(key, Object.keys(fields))
        this.problem(
          `${prefix}${key}`,
          `Unknown setting.${near === undefined ? "" : ` Did you mean ${prefix}${near}?`}`,
        )
        continue
      }
      const resolved = this.walk(spec, item, `${prefix}${key}`)
      if (resolved !== undefined) out[key] = resolved
    }
    return out
  }

  /**
   * Fills every unset setting that has a default and checks numeric ranges. Sections turned off (`false`)
   * are skipped, and so is auth other than built in auth.
   */
  fillDefaults(
    fields: Readonly<Record<string, Spec>>,
    node: Record<string, unknown>,
    prefix: string,
  ): void {
    for (const [key, spec] of Object.entries(fields)) {
      const path = `${prefix}${key}`
      const value = node[key]
      const nested =
        spec.t === "object"
          ? spec.fields
          : spec.t === "toggle" && spec.of.t === "object"
            ? spec.of.fields
            : spec.t === "auth" && isPlainObject(value) && value["kind"] === "builtin"
              ? AUTH_KINDS["builtin"]
              : undefined
      if (nested !== undefined) {
        if (value === false) continue
        if (value !== undefined && !isPlainObject(value)) continue
        const child: Record<string, unknown> = isPlainObject(value) ? value : {}
        this.fillDefaults(nested, child, `${path}.`)
        if (value === undefined && Object.keys(child).length > 0) node[key] = child
        continue
      }
      if (value === undefined && spec.def !== undefined) {
        node[key] = Array.isArray(spec.def) ? [...spec.def] : spec.def
        this.sources.set(path, { kind: "default" })
      }
      const current = node[key]
      const range = spec.range
      if (range !== undefined && typeof current === "number") {
        if (
          (range.min !== undefined && current < range.min) ||
          (range.max !== undefined && current > range.max)
        )
          this.problem(path, range.message(current))
      }
    }
  }

  /** Applies a well known variable on top of the file, refusing contradictions. */
  overlay(tree: Record<string, unknown>, name: string, path: string, spec: Spec): void {
    const text = this.options.env[name]
    if (text === undefined || text === "") return
    const parsed = this.parseText(spec, text, path, name)
    if (parsed === undefined) return
    if (SECRET_PATHS.has(path)) this.secrets.add(path)
    const keys = path.split(".")
    const last = keys.pop() ?? ""
    let parent: Record<string, unknown> = tree
    for (const key of keys) {
      const next = parent[key]
      if (next === false) {
        this.problem(
          path,
          `${name} is set, but ${keys.join(".")} is turned off in the config file.\nUnset ${name} or turn ${keys.join(".")} on.`,
        )
        return
      }
      if (!isPlainObject(next)) {
        const created: Record<string, unknown> = key === "auth" ? { kind: "external" } : {}
        parent[key] = created
        parent = created
      } else {
        parent = next
      }
    }
    const source = this.sources.get(path)
    const envSource: Source = { kind: "env", name, envFile: this.options.envFiles?.get(name) }
    if (parent[last] === undefined || source === undefined) {
      parent[last] = parsed
      this.sources.set(path, envSource)
      return
    }
    if (source.kind === "env" && source.name === name) return
    if (same(parent[last], parsed)) return
    const from =
      source.kind === "env" ? `the config file (through ${source.name})` : "the config file"
    this.problem(
      path,
      `${path} is set in ${from} and by ${name}, with different values.\nRemove one of them: the config file and the environment must not disagree.`,
    )
  }
}

function get(tree: Record<string, unknown>, path: string): unknown {
  let value: unknown = tree
  for (const key of path.split(".")) {
    if (!isPlainObject(value)) return undefined
    value = value[key]
  }
  return value
}

function section(path: string): string {
  return path.split(".")[0] ?? path
}

/** Expands provider presets into plain external auth, keeping the source of what they were derived from. */
function expandAuth(resolver: Resolver, tree: Record<string, unknown>): void {
  const auth = tree["auth"]
  if (!isPlainObject(auth)) return
  const text = (key: string): string | undefined =>
    typeof auth[key] === "string" ? (auth[key] as string) : undefined
  const derive = (from: string, fields: Record<string, unknown>): void => {
    const source = resolver.sources.get(`auth.${from}`) ?? { kind: "file" as const }
    const roles = text("rolesClaim")
    const next: Record<string, unknown> = { kind: "external", ...fields }
    if (roles !== undefined) next["rolesClaim"] = roles
    for (const key of Object.keys(fields)) resolver.sources.set(`auth.${key}`, source)
    tree["auth"] = next
  }
  const host = (value: string): string => value.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  switch (auth["kind"]) {
    case "auth0": {
      const domain = text("domain")
      if (domain === undefined) return
      derive("domain", {
        jwksUrl: `https://${host(domain)}/.well-known/jwks.json`,
        issuer: `https://${host(domain)}/`,
        audience: auth["audience"],
        algorithms: ["RS256"],
      })
      return
    }
    case "clerk": {
      const api = text("frontendApi")
      if (api === undefined) return
      derive("frontendApi", {
        jwksUrl: `https://${host(api)}/.well-known/jwks.json`,
        issuer: `https://${host(api)}`,
        audience: auth["audience"],
        algorithms: ["RS256"],
      })
      return
    }
    case "firebase": {
      const project = text("projectId")
      if (project === undefined) return
      derive("projectId", {
        jwksUrl:
          "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        issuer: `https://securetoken.google.com/${project}`,
        audience: project,
        algorithms: ["RS256"],
      })
      return
    }
    case "supabase": {
      const ref = text("projectRef")
      if (ref === undefined) return
      derive("projectRef", {
        jwksUrl: `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json`,
        issuer: `https://${ref}.supabase.co/auth/v1`,
        audience: "authenticated",
        algorithms: ["ES256", "RS256"],
      })
      return
    }
    default:
      return
  }
}

/** The database in the path of a MongoDB connection string, if there is one. */
export function databaseFromUri(uri: string): string | undefined {
  try {
    const path = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.replace(/^\//, "")
    return path === "" ? undefined : decodeURIComponent(path)
  } catch {
    return undefined
  }
}

const FORBIDDEN_ALGORITHMS = new Set(["none", "HS256", "HS384", "HS512"])

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

/**
 * Validates a config (the default export of a config file, already called if it is a function) and the
 * environment, and applies every default. Settings from the file and the well known `CANOPY_*`
 * variables are combined: a variable fills a setting the file leaves out, and a variable that contradicts
 * the file is an error. Throws a {@link ConfigError} listing every problem the command cares about.
 */
export function resolveConfig(input: unknown, options: ResolveOptions): Resolution {
  const resolver = new Resolver(options)
  const walked = resolver.walk(ROOT, input ?? {}, "")
  const tree: Record<string, unknown> = isPlainObject(walked) ? walked : {}
  expandAuth(resolver, tree)
  for (const [name, path, spec] of WELL_KNOWN) resolver.overlay(tree, name, path, spec)
  const config = normalize(resolver, tree, options)
  const needs = NEEDS[options.command]
  const problems = resolver.problems.filter(
    (problem) => !problem.missing || needs === "all" || needs.has(section(problem.path)),
  )
  if (problems.length > 0) throw new ConfigError(options.file, problems)
  Object.defineProperty(config, RESOLVED, { value: true })
  return { config, sources: resolver.sources, secrets: resolver.secrets }
}

function normalize(
  resolver: Resolver,
  tree: Record<string, unknown>,
  options: ResolveOptions,
): ResolvedConfig {
  resolver.fillDefaults(ROOT_FIELDS, tree, "")
  const at = <T>(path: string): T => get(tree, path) as T
  const environment = at<Environment>("environment")
  const production = environment === "production"

  const uri = get(tree, "mongodb.uri")
  let mongodb: ResolvedConfig["mongodb"] = {
    uri: "",
    database: "",
    metaDatabase: "canopy",
    authDatabase: "canopy_auth",
  }
  if (typeof uri !== "string") {
    if (!resolver.problems.some((problem) => problem.path === "mongodb.uri"))
      resolver.problem(
        "mongodb.uri",
        "No MongoDB connection string.\nSet MONGODB_URI, or mongodb.uri in the config file.",
        true,
      )
  } else if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    resolver.problem(
      "mongodb.uri",
      'Expected a connection string starting with "mongodb://" or "mongodb+srv://".',
    )
  } else {
    const database = (get(tree, "mongodb.database") as string | undefined) ?? databaseFromUri(uri)
    if (database === undefined)
      resolver.problem(
        "mongodb.database",
        "No app database.\nSet CANOPY_DB or mongodb.database, or put the database in the URI path.",
      )
    mongodb = {
      uri,
      database: database ?? "",
      metaDatabase: at<string>("mongodb.metaDatabase"),
      authDatabase: at<string>("mongodb.authDatabase"),
    }
    const names = [mongodb.database, mongodb.metaDatabase, mongodb.authDatabase]
    if (database !== undefined && new Set(names).size !== names.length)
      resolver.problem(
        "mongodb",
        `The app, meta and auth databases must differ; received ${quoted(names)}.`,
      )
  }

  let auth: ResolvedExternalAuth | ResolvedBuiltinAuth | undefined
  const rawAuth = tree["auth"]
  if (isPlainObject(rawAuth) && rawAuth["kind"] !== "builtin") {
    const issuer = rawAuth["issuer"]
    const audience = rawAuth["audience"]
    const jwksUrl = rawAuth["jwksUrl"]
    const jwks = rawAuth["jwks"]
    if (typeof issuer !== "string")
      resolver.problem("auth.issuer", "The token issuer is required (CANOPY_JWT_ISSUER).", true)
    if (typeof audience !== "string")
      resolver.problem(
        "auth.audience",
        "The token audience is required (CANOPY_JWT_AUDIENCE), so tokens minted for other APIs are refused.",
        true,
      )
    if (jwksUrl === undefined && jwks === undefined)
      resolver.problem(
        "auth.jwksUrl",
        "Set the JWKS URL of the identity provider (CANOPY_JWT_JWKS_URL).",
        true,
      )
    if (typeof jwksUrl === "string" && URL.canParse(jwksUrl)) {
      const parsed = new URL(jwksUrl)
      if (parsed.protocol !== "https:" && !isLocalHost(parsed.hostname))
        resolver.problem("auth.jwksUrl", "The JWKS URL must use HTTPS outside localhost.")
    }
    const algorithms = rawAuth["algorithms"]
    if (Array.isArray(algorithms)) {
      for (const algorithm of algorithms)
        if (FORBIDDEN_ALGORITHMS.has(String(algorithm)))
          resolver.problem(
            "auth.algorithms",
            `The algorithm ${String(algorithm)} is never accepted.`,
          )
    }
    if (typeof issuer === "string" && typeof audience === "string") {
      auth = {
        issuer,
        audience,
        ...(typeof jwksUrl === "string" ? { jwksUrl } : {}),
        ...(isPlainObject(jwks) ? { jwks: jwks as ResolvedExternalAuth["jwks"] & object } : {}),
        ...(Array.isArray(algorithms) ? { algorithms: algorithms as string[] } : {}),
        ...(typeof rawAuth["rolesClaim"] === "string" ? { rolesClaim: rawAuth["rolesClaim"] } : {}),
        ...(rawAuth["allowServiceRoleFromJwt"] === true ? { allowServiceRoleFromJwt: true } : {}),
        ...(typeof rawAuth["clockToleranceSeconds"] === "number"
          ? { clockToleranceSeconds: rawAuth["clockToleranceSeconds"] }
          : {}),
      }
    }
  }

  const policiesTree = tree["policies"]
  let policies: ResolvedConfig["policies"] = { source: "database", watch: true }
  if (isPlainObject(policiesTree) && typeof policiesTree["dir"] === "string") {
    const source = resolver.sources.get("policies.dir")
    const base = source?.kind === "env" ? options.cwd : options.baseDir
    policies = { dir: joinPath(base, policiesTree["dir"]), watch: policiesTree["watch"] !== false }
  } else {
    if (policiesTree === undefined) resolver.sources.set("policies.source", { kind: "default" })
    policies = {
      source: "database",
      watch: !(isPlainObject(policiesTree) && policiesTree["watch"] === false),
    }
  }

  const rest: ResolvedConfig["rest"] =
    tree["rest"] === false
      ? false
      : {
          defaultLimit: at<number>("rest.defaultLimit"),
          maxLimit: at<number>("rest.maxLimit"),
          maxBodyBytes: at<number>("rest.maxBodyBytes"),
          mutationTtlMs: at<number>("rest.mutationTtl"),
        }
  if (rest !== false && rest.defaultLimit > rest.maxLimit)
    resolver.problem("rest.defaultLimit", `Must not exceed rest.maxLimit (${rest.maxLimit}).`)

  const realtime: ResolvedConfig["realtime"] =
    tree["realtime"] === false
      ? false
      : {
          fullDocument: at<FullDocumentMode>("realtime.fullDocument"),
          transports: at<Transport[]>("realtime.transports"),
          resumeWindowMs: at<number>("realtime.resumeWindow"),
          checkpoints: at<"meta" | "off">("realtime.checkpoints"),
          drainWindowMs: at<number>("realtime.drainWindow"),
        }

  const collections: Record<string, { idType: IdType }> = {}
  const rawCollections = tree["collections"]
  if (isPlainObject(rawCollections)) {
    for (const [name, value] of Object.entries(rawCollections)) {
      const idType = isPlainObject(value) ? value["idType"] : undefined
      collections[name] = { idType: (typeof idType === "string" ? idType : "auto") as IdType }
    }
  }

  const publicUrl = get(tree, "publicUrl") as string | undefined
  const origins = get(tree, "cors.origins") as readonly string[] | "*" | undefined
  let cors: ResolvedConfig["cors"]
  if (origins !== undefined) cors = { origins }
  else if (publicUrl !== undefined) {
    cors = { origins: [new URL(publicUrl).origin] }
    resolver.sources.set("cors.origins", { kind: "default" })
  }
  if (production && origins === "*")
    resolver.problem(
      "cors.origins",
      'Any origin ("*") is refused in production. List the allowed origins.',
    )

  if (isPlainObject(rawAuth) && rawAuth["kind"] === "builtin")
    auth = normalizeBuiltin(resolver, rawAuth, {
      production,
      publicUrl,
      masterKey: get(tree, "masterKey") as string | undefined,
      rotatingMasterKey:
        ((get(tree, "previousMasterKeys") as string[] | undefined) ?? []).length > 0,
      cors,
    })

  const insecure = at<boolean>("dev.insecure")
  if (production && insecure)
    resolver.problem(
      "dev.insecure",
      "Development mode switches are refused when CANOPY_ENV is production.",
    )
  const masterKey = get(tree, "masterKey") as string | undefined
  if (
    production &&
    masterKey === undefined &&
    (options.command === "start" || options.command === "dev")
  )
    resolver.problem("masterKey", "CANOPY_MASTER_KEY is required in production.", true)

  const typesOut = get(tree, "types.out")
  return {
    file: options.file,
    environment,
    mongodb,
    publicUrl,
    masterKey,
    previousMasterKeys: (get(tree, "previousMasterKeys") as string[] | undefined) ?? [],
    auth,
    keys: {
      publishable: at<string[]>("keys.publishable"),
      secret: at<string[]>("keys.secret"),
    },
    policies,
    rest,
    realtime,
    collections,
    cors,
    server: {
      port: at<number>("server.port"),
      metricsPort: at<number>("server.metricsPort"),
      adminListen: at<string | undefined>("server.adminListen"),
      nodeId: at<string>("server.nodeId"),
      trustedProxies: at<string[]>("server.trustedProxies"),
    },
    log: { level: at<LogLevel>("log.level") },
    types: {
      out:
        typeof typesOut === "string"
          ? joinPath(options.baseDir, typesOut)
          : joinPath(options.cwd, "src/canopy.gen.ts"),
      role: get(tree, "types.role") as string | undefined,
    },
    dev: { insecure },
  }
}

const EXTERNAL_ONLY = [
  "jwksUrl",
  "jwks",
  "issuer",
  "audience",
  "algorithms",
  "rolesClaim",
  "allowServiceRoleFromJwt",
  "clockToleranceSeconds",
]
const PROVIDER_IDS = ["google", "github", "apple", "microsoft", "discord"]

function isHttps(value: string): boolean {
  const parsed = new URL(value)
  return parsed.protocol === "https:" || isLocalHost(parsed.hostname)
}

/** Validates built in auth, whose defaults are already applied. Durations arrive in milliseconds. */
function normalizeBuiltin(
  resolver: Resolver,
  raw: Record<string, unknown>,
  context: {
    readonly production: boolean
    readonly publicUrl: string | undefined
    readonly masterKey: string | undefined
    readonly rotatingMasterKey: boolean
    readonly cors: ResolvedConfig["cors"]
  },
): ResolvedBuiltinAuth {
  const { production } = context
  const at = <T>(path: string): T => get(raw, path) as T
  for (const key of EXTERNAL_ONLY)
    if (raw[key] !== undefined)
      resolver.problem(
        `auth.${key}`,
        "Applies to external identity providers only; built in auth issues its own tokens.\nRemove it (or the CANOPY_JWT_* variable that sets it).",
      )
  resolver.secrets.add("auth.secret")
  const secret = (raw["secret"] as string | undefined) ?? context.masterKey
  if (raw["secret"] === undefined && context.rotatingMasterKey)
    resolver.problem(
      "auth.secret",
      "Built in auth uses the master key as its secret, so rotating the master key would make its signing keys unreadable.\nSet auth.secret to the previous master key first.",
    )
  if (secret !== undefined && secret.length < 32)
    resolver.problem("auth.secret", "The auth secret needs at least 32 characters.")
  if (secret === undefined && production)
    resolver.problem(
      "auth.secret",
      "Built in auth needs a secret: set CANOPY_MASTER_KEY or auth.secret.",
      true,
    )
  if (context.publicUrl === undefined && production)
    resolver.problem(
      "publicUrl",
      "Built in auth needs the external URL for token issuers and links (CANOPY_PUBLIC_URL).",
      true,
    )
  else if (context.publicUrl !== undefined && production && !isHttps(context.publicUrl))
    resolver.problem("publicUrl", "Built in auth needs an https public URL in production.")

  const ttl = at<number>("accessTokenTtl")
  const interval = at<number>("keyRotation.interval")
  const grace = at<number>("keyRotation.grace")
  if (grace < ttl)
    resolver.problem(
      "auth.keyRotation.grace",
      "The grace period must cover the access token lifetime, or tokens stop verifying early.",
    )

  const corsOrigins =
    context.cors !== undefined && context.cors.origins !== "*" ? context.cors.origins : []
  const redirectUrls = (raw["redirectUrls"] as string[] | undefined) ?? [...corsOrigins]
  for (const entry of redirectUrls) {
    if (!URL.canParse(entry) || !/^https?:$/.test(new URL(entry).protocol))
      resolver.problem("auth.redirectUrls", `${JSON.stringify(entry)} is not an http(s) URL.`)
    else if (production && !isHttps(entry))
      resolver.problem(
        "auth.redirectUrls",
        `${JSON.stringify(entry)} must use https in production.`,
      )
  }

  const emailPassword: ResolvedBuiltinAuth["emailPassword"] =
    raw["emailPassword"] === false
      ? false
      : {
          minPasswordLength: at<number>("emailPassword.minPasswordLength"),
          requireEmailVerification: at<boolean>("emailPassword.requireEmailVerification"),
        }

  const providers: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> =
    {}
  const rawProviders = raw["providers"]
  if (isPlainObject(rawProviders)) {
    for (const id of PROVIDER_IDS) {
      const provider = rawProviders[id]
      if (!isPlainObject(provider)) continue
      resolver.secrets.add(`auth.providers.${id}.clientSecret`)
      const clientId = provider["clientId"]
      const clientSecret = provider["clientSecret"]
      if (typeof clientId !== "string" || typeof clientSecret !== "string") {
        resolver.problem(`auth.providers.${id}`, "Set clientId and clientSecret.", true)
        continue
      }
      providers[id] = {
        clientId,
        clientSecret,
        ...(typeof provider["tenantId"] === "string" ? { tenantId: provider["tenantId"] } : {}),
      }
    }
  }

  const oidc: ResolvedBuiltinAuth["oidc"][number][] = []
  const rawOidc = raw["oidc"]
  const ids = new Set<string>(PROVIDER_IDS)
  if (Array.isArray(rawOidc)) {
    rawOidc.forEach((item: unknown, index) => {
      const path = `auth.oidc.${index}`
      resolver.secrets.add(`${path}.clientSecret`)
      if (!isPlainObject(item)) return
      const { id, discoveryUrl, clientId, clientSecret, scopes } = item
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        resolver.problem(`${path}.id`, "Use lower case letters, digits, _ and -.")
        return
      }
      if (ids.has(id)) {
        resolver.problem(`${path}.id`, `The provider id ${JSON.stringify(id)} is used twice.`)
        return
      }
      ids.add(id)
      if (
        typeof discoveryUrl !== "string" ||
        typeof clientId !== "string" ||
        typeof clientSecret !== "string"
      ) {
        resolver.problem(path, "Set discoveryUrl, clientId and clientSecret.", true)
        return
      }
      if (production && !isHttps(discoveryUrl))
        resolver.problem(`${path}.discoveryUrl`, "Use https in production.")
      oidc.push({
        id,
        discoveryUrl,
        clientId,
        clientSecret,
        ...(Array.isArray(scopes) ? { scopes: scopes as string[] } : {}),
      })
    })
  }

  let email: ResolvedBuiltinAuth["email"] = {
    from: "Canopy <auth@localhost>",
    transport: { kind: "log" },
  }
  const rawEmail = raw["email"]
  for (const key of ["pass", "apiKey", "serverToken", "secretAccessKey", "sessionToken"])
    resolver.secrets.add(`auth.email.transport.${key}`)
  if (isPlainObject(rawEmail)) {
    const transport = rawEmail["transport"]
    if (typeof rawEmail["from"] !== "string")
      resolver.problem("auth.email.from", "Set the sender address.", true)
    if (!isPlainObject(transport)) {
      if (!resolver.problems.some((problem) => problem.path.startsWith("auth.email.transport")))
        resolver.problem("auth.email.transport", "Set a transport such as email.resend().", true)
    } else {
      if (transport["kind"] === "log" && production)
        resolver.problem("auth.email.transport", "email.log() is refused in production.")
      email = {
        from: typeof rawEmail["from"] === "string" ? rawEmail["from"] : email.from,
        transport: transport as unknown as ResolvedEmailTransport,
      }
    }
  } else if (production) {
    resolver.problem(
      "auth.email",
      "Built in auth sends verification, reset and sign in emails; configure auth.email.",
      true,
    )
  }

  const claims = raw["claims"]
  const appName = raw["appName"]
  if (typeof appName !== "string" || appName.trim() === "" || appName.length > 100)
    resolver.problem("auth.appName", "Use 1 to 100 characters.")
  return {
    kind: "builtin",
    appName: typeof appName === "string" ? appName : "Canopy",
    secret,
    accessTokenTtlSeconds: Math.round(ttl / 1000),
    algorithm: at<"EdDSA" | "ES256">("algorithm"),
    keyRotation: {
      intervalSeconds: Math.round(interval / 1000),
      graceSeconds: Math.round(grace / 1000),
    },
    redirectUrls,
    emailPassword,
    magicLink: at<boolean>("magicLink"),
    emailOtp: at<boolean>("emailOtp"),
    anonymous: at<boolean>("anonymous"),
    providers,
    oidc,
    claims: typeof claims === "function" ? (claims as ResolvedBuiltinAuth["claims"]) : undefined,
    email,
    trustedProxies: at<string[]>("trustedProxies"),
    identifierLimit: {
      max: at<number>("identifierLimit.max"),
      windowSeconds: Math.round(at<number>("identifierLimit.window") / 1000),
    },
    session: {
      expiresInSeconds: Math.round(at<number>("session.expiresIn") / 1000),
      updateAgeSeconds: Math.round(at<number>("session.updateAge") / 1000),
    },
  }
}

/** Joins a possibly relative POSIX or Windows path onto a base directory, without `node:path`. */
export function joinPath(base: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
  const parts = base.split(/[\\/]/)
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") parts.pop()
    else parts.push(segment)
  }
  return parts.join(separator)
}

/** Masks the password of a MongoDB connection string. */
export function redactUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^:/@]+:)[^@]*@/, "$1••••@")
}

/**
 * Renders a resolved config for `canopy config print`: one `path = value` line per setting, secrets
 * masked, and with `sources` the origin of each value.
 */
export function formatConfig(
  resolution: Resolution,
  options: { readonly sources?: boolean } = {},
): string {
  const lines: string[] = []
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
      for (const [index, item] of value.entries()) visit(item, `${path}.${index}`)
      return
    }
    if (isPlainObject(value) && !(path === "auth.jwks")) {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      if (entries.length === 0 && path !== "") lines.push(`${path} = {}`)
      for (const [key, item] of entries) visit(item, path === "" ? key : `${path}.${key}`)
      return
    }
    if (path === "file") return
    let shown: string
    if (
      resolution.secrets.has(path) ||
      [...resolution.secrets].some((secret) => path.startsWith(`${secret}.`))
    )
      shown = Array.isArray(value) ? `[${value.map(() => '"••••"').join(", ")}]` : '"••••"'
    else if (typeof value === "function") shown = "[function]"
    else if (path === "mongodb.uri" && typeof value === "string")
      shown = JSON.stringify(redactUri(value))
    else shown = JSON.stringify(value)
    const line = `${path} = ${shown}`
    if (options.sources !== true) {
      lines.push(line)
      return
    }
    const source = sourceOf(resolution.sources, path)
    lines.push(`${line}  (${source})`)
  }
  visit(resolution.config, "")
  return `${lines.join("\n")}\n`
}

function sourceOf(sources: ReadonlyMap<string, Source>, path: string): string {
  const key = [
    path,
    path.replace(/Ms$/, ""),
    path.replace(/Seconds$/, ""),
    path.replace(/^rest\.mutationTtlMs$/, "rest.mutationTtl"),
  ].find((candidate) => sources.has(candidate))
  const source = key === undefined ? undefined : sources.get(key)
  if (source === undefined) return "default"
  if (source.kind === "env")
    return source.envFile === undefined
      ? `env ${source.name}`
      : `${source.name} from ${source.envFile}`
  return source.kind === "file" ? "config file" : "default"
}
