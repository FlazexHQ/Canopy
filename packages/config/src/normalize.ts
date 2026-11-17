import { normalizeBuiltin } from "./builtin.ts"
import type { ResolveOptions } from "./resolution.ts"
import { get, isLocalHost, isPlainObject, quoted, type Resolver } from "./resolver.ts"
import { isDevelopmentKey, ROOT_FIELDS } from "./spec.ts"
import type {
  Environment,
  FullDocumentMode,
  GraphqlIntrospection,
  IdType,
  LogLevel,
  ResolvedBuiltinAuth,
  ResolvedCollection,
  ResolvedConfig,
  ResolvedExternalAuth,
  ResolvedRelation,
  Transport,
} from "./types.ts"

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

/** Turns a resolved tree into the {@link ResolvedConfig}, checking the rules that span settings. */
export function normalize(
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
    const keys = isPlainObject(jwks) ? jwks["keys"] : undefined
    const jwkList =
      Array.isArray(keys) && keys.every(isPlainObject) ? keys.filter(isPlainObject) : undefined
    if (jwks !== undefined && jwkList === undefined)
      resolver.problem("auth.jwks", "A key set needs a keys array of JSON Web Keys.", true)
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
        ...(jwkList === undefined ? {} : { jwks: { keys: jwkList } }),
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

  const rateLimits: ResolvedConfig["rateLimits"] =
    tree["rateLimits"] === false || get(tree, "rateLimits.enabled") === false
      ? false
      : {
          requests: {
            perSecond: at<number>("rateLimits.requests.perSecond"),
            burst: at<number>("rateLimits.requests.burst"),
          },
          messages: {
            perSecond: at<number>("rateLimits.messages.perSecond"),
            burst: at<number>("rateLimits.messages.burst"),
          },
          anonymousConnectionsPerAddress: at<number>("rateLimits.anonymousConnectionsPerAddress"),
          failedAuthentications: {
            perSecond: at<number>("rateLimits.failedAuthentications.perSecond"),
            burst: at<number>("rateLimits.failedAuthentications.burst"),
          },
          exemptService: at<boolean>("rateLimits.exemptService"),
        }

  const graphqlTree = tree["graphql"]
  const persistedFile = get(tree, "graphql.persisted.file")
  const persistedOnly = get(tree, "graphql.persisted.only") === true
  if (typeof persistedFile !== "string" && persistedOnly)
    resolver.problem(
      "graphql.persisted.file",
      "Allowing only persisted operations needs a file of them.",
    )
  const graphql: ResolvedConfig["graphql"] =
    graphqlTree === false || rest === false
      ? false
      : {
          maxDepth: at<number>("graphql.maxDepth"),
          maxComplexity: at<number>("graphql.maxComplexity"),
          maxAliases: at<number>("graphql.maxAliases"),
          maxBatch: at<number>("graphql.maxBatch"),
          introspection:
            (get(tree, "graphql.introspection") as GraphqlIntrospection | undefined) ??
            (production ? "authenticated" : "always"),
          persisted:
            typeof persistedFile === "string"
              ? { file: joinPath(options.baseDir, persistedFile), only: persistedOnly }
              : undefined,
        }

  const collections: Record<string, ResolvedCollection> = {}
  const rawCollections = tree["collections"]
  if (isPlainObject(rawCollections)) {
    for (const [name, value] of Object.entries(rawCollections)) {
      const entry = isPlainObject(value) ? value : {}
      const idType = entry["idType"]
      const typeName = entry["typeName"]
      if (typeof typeName === "string" && !/^[_A-Za-z][_0-9A-Za-z]*$/.test(typeName))
        resolver.problem(`collections.${name}.typeName`, "Must be a valid GraphQL name.")
      const relations: Record<string, ResolvedRelation> = {}
      const rawRelations = entry["relations"]
      if (isPlainObject(rawRelations)) {
        for (const [field, relation] of Object.entries(rawRelations)) {
          if (!isPlainObject(relation)) continue
          const { to, local, foreign, many } = relation
          if (typeof to !== "string" || typeof local !== "string") {
            resolver.problem(
              `collections.${name}.relations.${field}`,
              "A relation needs to (the target collection) and local (the field holding the key).",
            )
            continue
          }
          relations[field] = {
            to,
            local,
            foreign: typeof foreign === "string" ? foreign : "_id",
            many: many === true,
          }
        }
      }
      collections[name] = {
        idType: (typeof idType === "string" ? idType : "auto") as IdType,
        ...(typeof typeName === "string" ? { typeName } : {}),
        ...(Object.keys(relations).length === 0 ? {} : { relations }),
      }
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
  if (production)
    for (const kind of ["publishable", "secret"] as const) {
      const keys = (get(tree, `keys.${kind}`) as readonly string[] | undefined) ?? []
      if (keys.some(isDevelopmentKey))
        resolver.problem(
          `keys.${kind}`,
          "Development API keys (such as pk_dev or sk_dev_change_me from the compose file, or keys made by canopy dev) are refused in production. Generate new keys.",
        )
    }
  const metricsToken = get(tree, "server.metricsToken")
  if (typeof metricsToken === "string" && metricsToken.length < 16)
    resolver.problem("server.metricsToken", "The metrics token must have at least 16 characters.")
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
    graphql,
    realtime,
    rateLimits,
    collections,
    cors,
    audit: { dataWrites: at<boolean>("audit.dataWrites") },
    telemetry: { tracing: at<boolean>("telemetry.tracing") },
    server: {
      port: at<number>("server.port"),
      metricsPort: at<number>("server.metricsPort"),
      metricsHost: at<string>("server.metricsHost"),
      metricsToken: at<string | undefined>("server.metricsToken"),
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
