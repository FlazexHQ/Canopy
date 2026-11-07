import { CanopyError, ErrorCode } from "@canopy/protocol"
import {
  deleteToken,
  isEnvironmentName,
  projectKey,
  saveEnvironment,
  saveToken,
  type ToolRunner,
} from "./credentials.ts"
import { messageOf, type Output } from "./output.ts"
import { AdminClient, type AdminIdentity, type Fetch } from "./remote.ts"

/** Options of `canopy login` and `canopy logout`. */
export interface LoginOptions {
  readonly url: string
  /** The token; otherwise `CANOPY_ADMIN_TOKEN`, otherwise read from the terminal or standard input. */
  readonly token?: string
  /** Also remember the project under this environment name, for `--env` on `policies` and `admin tokens`. */
  readonly environment?: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly run?: ToolRunner
  /** The `fetch` used to verify the token; injected by tests. */
  readonly fetch?: Fetch
}

/** Why a token was not accepted, in words for the terminal. */
function refusal(error: unknown, url: string): string {
  if (!(error instanceof CanopyError)) return `Could not verify the token: ${messageOf(error)}`
  switch (error.code) {
    case ErrorCode.Unauthorized:
      return `${url} refused the token: it is unknown, expired, revoked or ended. Create an admin API token with canopy admin tokens create, or POST /admin/v1/login with "transport": "bearer" for a session token.`
    case ErrorCode.Forbidden:
      return error.details?.["reason"] === "password_change_required"
        ? `${url} accepted the token, but the admin must change their password first.`
        : `${url} refused the token: ${error.message}`
    case ErrorCode.NotFound:
      return `${url} has no admin API at /admin/v1. With a private admin listener (CANOPY_ADMIN_LISTEN), log in to that address.`
    case ErrorCode.Unavailable:
      return `${url} did not answer, so the token could not be verified.`
    default:
      return `Could not verify the token: ${error.message}`
  }
}

/**
 * `canopy login <url>`: verifies an admin token with `GET /admin/v1/me`, then stores it for the project in
 * the OS keychain (macOS Keychain or the Linux Secret Service), falling back to a credentials file that only
 * the user can read (mode 0600, or the user profile on Windows). A
 * token the server refuses, or a server that does not answer, stores nothing. The token is never taken
 * from a prompt that echoes it. With `environment`, the project is also remembered under that name.
 */
export async function login(options: LoginOptions, out: Output): Promise<number> {
  let url: string
  try {
    url = projectKey(options.url)
  } catch (error: unknown) {
    out.error(`Not a project URL: ${messageOf(error)}`)
    return 1
  }
  if (url.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) {
    out.error("Admin tokens are only sent over HTTPS (http is allowed for localhost).")
    return 1
  }
  if (options.environment !== undefined && !isEnvironmentName(options.environment)) {
    out.error(
      `--env ${JSON.stringify(options.environment)} is not an environment name: a letter, then letters, digits, _ or -`,
    )
    return 1
  }
  const token =
    options.token ??
    options.env["CANOPY_ADMIN_TOKEN"] ??
    (await out.readSecret?.(`Admin token for ${url}: `))
  if (token === undefined || token.trim() === "") {
    out.error("No token: pass --token, set CANOPY_ADMIN_TOKEN, or pipe it on standard input.")
    return 1
  }
  let identity: AdminIdentity
  try {
    identity = await new AdminClient(url, token.trim(), options.fetch).me()
  } catch (error: unknown) {
    out.error(refusal(error, url))
    out.error("Nothing was stored.")
    return 1
  }
  const where = await saveToken(url, token.trim(), {
    env: options.env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  if (options.environment !== undefined)
    await saveEnvironment(options.environment, url, options.env, options.platform)
  const who = `Logged in to ${url} as ${identity.email} (${identity.role}, ${identity.environment})`
  out.log(
    where === "keychain"
      ? `${who}; the token is in the OS keychain.`
      : where === "protected"
        ? `${who}; the token is in the credentials file, encrypted for your Windows account.`
        : `${who}; no keychain was available, so the token is in the credentials file (${(options.platform ?? process.platform) === "win32" ? "in your Windows user profile, not encrypted" : "mode 0600"}).`,
  )
  if (options.environment !== undefined)
    out.log(
      `--env ${options.environment} now selects ${url} for canopy policies and canopy admin tokens.`,
    )
  return 0
}

/** `canopy logout <url>`: removes the stored admin token of a project. */
export async function logout(options: LoginOptions, out: Output): Promise<number> {
  const url = projectKey(options.url)
  const found = await deleteToken(url, {
    env: options.env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  out.log(found ? `Logged out of ${url}.` : `No token stored for ${url}.`)
  return 0
}
