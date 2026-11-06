/** Tokens come from an Auth0 tenant. */
export interface Auth0Identity {
  readonly kind: 'auth0'
  /** The tenant domain, for example `your-tenant.us.auth0.com`. */
  readonly domain: string
  /** The API identifier configured in Auth0, used as the token audience. */
  readonly audience: string
  /** The client ID of the single page application in Auth0. */
  readonly clientId: string
}

/** Tokens come from the built in development issuer, so the example runs without an Auth0 tenant. */
export interface DevIdentity {
  readonly kind: 'dev'
  readonly issuer: string
  readonly audience: string
}

/** Everything the helpdesk app needs to start. */
export interface AppConfig {
  readonly port: number
  readonly mongodbUri: string
  /** The app database. Defaults to the database in the URI path. */
  readonly database?: string
  readonly identity: Auth0Identity | DevIdentity
  /** The token claim that lists the user's roles. */
  readonly rolesClaim: string
  /** Where browsers reach the canopy-realtime sidecar. */
  readonly canopyUrl: string
  readonly publishableKey: string
  readonly production: boolean
}

type Env = Readonly<Record<string, string | undefined>>

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function required(env: Env, name: string): string {
  const value = read(env, name)
  if (value === undefined) throw new TypeError(`${name} is required (see .env.example)`)
  return value
}

/** Reads the configuration from environment variables. Without `AUTH0_DOMAIN` the development issuer is used. */
export function configFromEnv(env: Env): AppConfig {
  const port = Number(read(env, 'PORT') ?? '3000')
  if (!Number.isInteger(port) || port <= 0) throw new TypeError('PORT must be a port number')
  const production = env['NODE_ENV'] === 'production'
  const domain = read(env, 'AUTH0_DOMAIN')
  const audience = read(env, 'AUTH0_AUDIENCE') ?? 'https://helpdesk.example/api'
  if (domain === undefined && production) {
    throw new TypeError(
      'AUTH0_DOMAIN is required in production; the development issuer is for local use only',
    )
  }
  const database = read(env, 'MONGODB_DB')
  return {
    port,
    mongodbUri: required(env, 'MONGODB_URI'),
    ...(database === undefined ? {} : { database }),
    identity:
      domain === undefined
        ? { kind: 'dev', issuer: `http://localhost:${port}/`, audience }
        : {
            kind: 'auth0',
            domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
            audience: required(env, 'AUTH0_AUDIENCE'),
            clientId: required(env, 'AUTH0_CLIENT_ID'),
          },
    rolesClaim: read(env, 'ROLES_CLAIM') ?? 'https://helpdesk.example/roles',
    canopyUrl: read(env, 'CANOPY_URL') ?? 'http://localhost:8080',
    publishableKey: required(env, 'CANOPY_PUBLISHABLE_KEY'),
    production,
  }
}
