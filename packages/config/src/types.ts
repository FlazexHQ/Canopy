import type { EnvMarker } from "./env.ts"

/** A setting given directly or read from an environment variable with {@link env}. */
export type Value<T> = T | EnvMarker<T> | EnvMarker<T | undefined>

/** `development` (the default) or `production`, which turns on stricter checks. */
export type Environment = "development" | "production"

/** The command a config is loaded for. Each only needs some sections; the others may be incomplete. */
export type Command = "start" | "dev" | "realtime" | "gen" | "policies" | "doctor" | "print"

/** What a config function receives. */
export interface ConfigContext {
  /** From `CANOPY_ENV`. */
  readonly mode: Environment
  readonly command: Command
}

/** How full documents are obtained for change events. */
export type FullDocumentMode = "auto" | "updateLookup" | "images"

/** The realtime transports a server offers. */
export type Transport = "websocket" | "sse" | "long-poll"

/** How the `{id}` path segment of a collection is read. */
export type IdType = "auto" | "objectId" | "string" | "uuid" | "number"

/** Log levels. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/** Tokens from any OIDC or JWKS identity provider. */
export interface ExternalAuthInput {
  readonly kind: "external"
  /** The JWKS endpoint. Must use HTTPS outside `localhost`. */
  readonly jwksUrl?: Value<string>
  /** An inline JWKS, for tests and air gapped setups. */
  readonly jwks?: { readonly keys: readonly Readonly<Record<string, unknown>>[] }
  readonly issuer: Value<string>
  readonly audience: Value<string>
  /** Pinned algorithms. `none` and HMAC algorithms are refused. */
  readonly algorithms?: Value<readonly string[]>
  /** The claim holding custom roles, for example `https://example.com/roles`. */
  readonly rolesClaim?: Value<string>
  /** Lets a token claim the `service` role. Off by default. */
  readonly allowServiceRoleFromJwt?: boolean
  /** Clock skew tolerance in seconds. @default 60 */
  readonly clockToleranceSeconds?: number
}

/** Auth0: tokens of the API whose identifier is `audience`. */
export interface Auth0Input {
  readonly kind: "auth0"
  /** The tenant domain, for example `example.eu.auth0.com`. */
  readonly domain: Value<string>
  readonly audience: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Clerk: session tokens from a JWT template that sets `aud`. */
export interface ClerkInput {
  readonly kind: "clerk"
  /** The Frontend API host, for example `clerk.example.com`. */
  readonly frontendApi: Value<string>
  readonly audience: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Firebase Authentication ID tokens of one project. */
export interface FirebaseInput {
  readonly kind: "firebase"
  readonly projectId: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Supabase Auth with asymmetric signing keys. */
export interface SupabaseInput {
  readonly kind: "supabase"
  /** The project reference, the subdomain of `<ref>.supabase.co`. */
  readonly projectRef: Value<string>
  readonly rolesClaim?: Value<string>
}

/** Where user tokens come from. */
export type AuthInput = ExternalAuthInput | Auth0Input | ClerkInput | FirebaseInput | SupabaseInput

/** Policies from a directory of files, or from the `canopy` meta database. */
export type PoliciesInput =
  | {
      /** Relative to the config file. */
      readonly dir: string
      /** Reload on change. @default true */
      readonly watch?: boolean
    }
  | { readonly source: "database"; readonly watch?: boolean }

/** Data API settings. */
export interface RestInput {
  /** @default 100 */
  readonly defaultLimit?: Value<number>
  /** @default 1000 */
  readonly maxLimit?: Value<number>
  /** @default 1048576 */
  readonly maxBodyBytes?: Value<number>
  /** How long idempotency records live. @default "24h" */
  readonly mutationTtl?: Value<number | string>
}

/** Realtime settings. */
export interface RealtimeInput {
  /** @default "auto" */
  readonly fullDocument?: Value<FullDocumentMode>
  /** @default ["websocket", "sse", "long-poll"] */
  readonly transports?: readonly Transport[]
  /** How long a session survives a disconnect. @default "2m" */
  readonly resumeWindow?: Value<number | string>
  /** Where the stream position is kept. @default "meta" */
  readonly checkpoints?: Value<"meta" | "off">
  /** How long shutdown waits for clients to move. @default "30s" */
  readonly drainWindow?: Value<number | string>
}

/** The input of {@link defineConfig}. Every setting may also be an {@link env} marker. */
export interface CanopyConfigInput {
  readonly mongodb?: {
    readonly uri: Value<string>
    /** @default the database in the URI path */
    readonly database?: Value<string>
    /** @default "canopy" */
    readonly metaDatabase?: Value<string>
    /** @default "canopy_auth" */
    readonly authDatabase?: Value<string>
  }
  /** @default "development" */
  readonly environment?: Value<Environment>
  /** The external base URL, used for JWT issuers, redirects and the default CORS origin. */
  readonly publicUrl?: Value<string>
  /** The key encryption key of stored secrets. Required in production for the `canopy` server. */
  readonly masterKey?: Value<string>
  readonly auth?: AuthInput
  readonly keys?: {
    readonly publishable?: Value<readonly string[]>
    readonly secret?: Value<readonly string[]>
  }
  readonly policies?: PoliciesInput
  /** `true` for the defaults, `false` to turn the Data API off. @default true */
  readonly rest?: boolean | RestInput
  /** `true` for the defaults, `false` to turn realtime off. @default true */
  readonly realtime?: boolean | RealtimeInput
  readonly collections?: Readonly<Record<string, { readonly idType?: IdType }>>
  readonly cors?: { readonly origins: Value<readonly string[]> | "*" }
  readonly server?: {
    /** @default 8080 */
    readonly port?: Value<number>
    /** @default 9464 */
    readonly metricsPort?: Value<number>
    /** Serves `/admin` and `/studio` only on this address, for example `127.0.0.1:8081`. */
    readonly adminListen?: Value<string>
    /** @default "n1" */
    readonly nodeId?: Value<string>
  }
  readonly log?: { readonly level?: Value<LogLevel> }
  /** Where `canopy gen types` writes, relative to the config file. */
  readonly types?: { readonly out?: string; readonly role?: string }
  /** Development only switches; refused in production. */
  readonly dev?: { readonly insecure?: Value<boolean> }
}

/** A config function, called with the mode and command. */
export type ConfigFunction = (context: ConfigContext) => CanopyConfigInput

/**
 * Declares a Canopy config with types and editor help. Takes the config object, or a function of
 * `{ mode, command }` returning it. Read variables with {@link env} rather than `process.env`, so missing
 * ones are reported together and secrets stay redacted.
 */
export function defineConfig(config: CanopyConfigInput): CanopyConfigInput
export function defineConfig(config: ConfigFunction): ConfigFunction
export function defineConfig(
  config: CanopyConfigInput | ConfigFunction,
): CanopyConfigInput | ConfigFunction {
  return config
}

/** Verified JWTs from an identity provider, ready for the authenticator. */
export interface ResolvedExternalAuth {
  readonly jwksUrl?: string
  readonly jwks?: { readonly keys: readonly Readonly<Record<string, unknown>>[] }
  readonly issuer: string
  readonly audience: string
  readonly algorithms?: readonly string[]
  readonly rolesClaim?: string
  readonly allowServiceRoleFromJwt?: boolean
  readonly clockToleranceSeconds?: number
}

/** A validated config with every default applied. */
export interface ResolvedConfig {
  /** The config file, or `undefined` in zero config mode. */
  readonly file: string | undefined
  readonly environment: Environment
  readonly mongodb: {
    readonly uri: string
    readonly database: string
    readonly metaDatabase: string
    readonly authDatabase: string
  }
  readonly publicUrl: string | undefined
  readonly masterKey: string | undefined
  readonly auth: ResolvedExternalAuth | undefined
  readonly keys: { readonly publishable: readonly string[]; readonly secret: readonly string[] }
  readonly policies:
    | { readonly dir: string; readonly watch: boolean }
    | { readonly source: "database"; readonly watch: boolean }
  readonly rest:
    | false
    | {
        readonly defaultLimit: number
        readonly maxLimit: number
        readonly maxBodyBytes: number
        readonly mutationTtlMs: number
      }
  readonly realtime:
    | false
    | {
        readonly fullDocument: FullDocumentMode
        readonly transports: readonly Transport[]
        readonly resumeWindowMs: number
        readonly checkpoints: "meta" | "off"
        readonly drainWindowMs: number
      }
  readonly collections: Readonly<Record<string, { readonly idType: IdType }>>
  readonly cors: { readonly origins: readonly string[] | "*" } | undefined
  readonly server: {
    readonly port: number
    readonly metricsPort: number
    readonly adminListen: string | undefined
    readonly nodeId: string
  }
  readonly log: { readonly level: LogLevel }
  readonly types: { readonly out: string; readonly role: string | undefined }
  readonly dev: { readonly insecure: boolean }
}
