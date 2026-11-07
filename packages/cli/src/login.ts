import { deleteToken, projectKey, saveToken, type ToolRunner } from "./credentials.ts"
import { messageOf, type Output } from "./output.ts"

/** Options of `canopy login` and `canopy logout`. */
export interface LoginOptions {
  readonly url: string
  /** The token; otherwise `CANOPY_ADMIN_TOKEN`, otherwise read from the terminal or standard input. */
  readonly token?: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly run?: ToolRunner
  /** Checks that the project answers; injected by tests. Defaults to `GET <url>/healthz`. */
  readonly reachable?: (url: string) => Promise<boolean>
}

async function healthz(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * `canopy login <url>`: stores an admin token for a remote project in the OS keychain (macOS Keychain or
 * the Linux Secret Service), falling back to a 0600 credentials file. The token is never taken from a
 * prompt that echoes it.
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
  const token =
    options.token ??
    options.env["CANOPY_ADMIN_TOKEN"] ??
    (await out.readSecret?.(`Admin token for ${url}: `))
  if (token === undefined || token.trim() === "") {
    out.error("No token: pass --token, set CANOPY_ADMIN_TOKEN, or pipe it on standard input.")
    return 1
  }
  if (!(await (options.reachable ?? healthz)(url)))
    out.log(`warn  ${url}/healthz did not answer; the token is stored anyway`)
  const where = await saveToken(url, token.trim(), {
    env: options.env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  out.log(
    where === "keychain"
      ? `Logged in to ${url}; the token is in the OS keychain.`
      : `Logged in to ${url}; no keychain was available, so the token is in the credentials file (mode 0600).`,
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
