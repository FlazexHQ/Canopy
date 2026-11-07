import { CanopyError, ErrorCode, isDocument } from "@canopy/protocol"
import { confirmed, messageOf, type Output } from "./output.ts"
import type { AdminClient } from "./remote.ts"

/** An admin API token as `GET /admin/v1/tokens` lists it. */
interface TokenEntry {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly role: string
  readonly userId: string
  readonly expiresAt: Date | undefined
  readonly lastUsedAt: Date | undefined
  readonly revokedAt: Date | undefined
  readonly active: boolean
}

const date = (value: unknown): Date | undefined => {
  if (value instanceof Date) return value
  if (typeof value !== "string") return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const show = (value: Date | undefined, none: string): string =>
  value === undefined ? none : value.toISOString()

function entryOf(value: unknown): TokenEntry | undefined {
  if (!isDocument(value) || typeof value["id"] !== "string") return undefined
  return {
    id: value["id"],
    name: String(value["name"] ?? ""),
    prefix: String(value["prefix"] ?? ""),
    role: String(value["role"] ?? ""),
    userId: String(value["userId"] ?? ""),
    expiresAt: date(value["expiresAt"]),
    lastUsedAt: date(value["lastUsedAt"]),
    revokedAt: date(value["revokedAt"]),
    active: value["active"] === true,
  }
}

function state(entry: TokenEntry): string {
  if (entry.revokedAt !== undefined) return `revoked ${entry.revokedAt.toISOString()}`
  return entry.active ? "active" : "expired"
}

/** Says what to do when the server refuses a token command, then returns 1. */
function refused(error: unknown, out: Output): number {
  if (error instanceof CanopyError && error.details?.["reason"] === "session_required")
    out.error(
      "Admin API tokens cannot manage tokens. Log in with a session (canopy login <url> with a token from Studio or POST /admin/v1/login) and try again.",
    )
  else out.error(error instanceof CanopyError ? error.message : `error  ${messageOf(error)}`)
  return 1
}

/** Options of `canopy admin tokens create`. */
export interface TokenCreateOptions {
  readonly remote: AdminClient
  readonly name: string
  /** `owner`, `admin`, `developer` or `viewer`; the server defaults to the caller's role. */
  readonly role?: string
  readonly expiresInDays?: number
}

/**
 * `canopy admin tokens create`: creates a long lived admin API token on the project behind `--env`, for
 * CI. The token is printed this one time; the server keeps only its hash.
 */
export async function tokensCreate(options: TokenCreateOptions, out: Output): Promise<number> {
  try {
    const body = await options.remote.post("/tokens", {
      name: options.name,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
    })
    const entry = entryOf(body)
    const token = isDocument(body) ? body["token"] : undefined
    if (entry === undefined || typeof token !== "string")
      throw new CanopyError(ErrorCode.Internal, "The server did not return a token")
    out.log(
      `${entry.id}  ${entry.role}  ${JSON.stringify(entry.name)}  expires ${show(entry.expiresAt, "never")}`,
    )
    out.log(token)
    out.log(
      "This is the only time the token is shown. Store it as a CI secret and pass it as CANOPY_ADMIN_TOKEN, with CANOPY_ADMIN_URL set to the project URL.",
    )
    return 0
  } catch (error: unknown) {
    return refused(error, out)
  }
}

/** Options of `canopy admin tokens list`. */
export interface TokenListOptions {
  readonly remote: AdminClient
  /** Every admin's tokens, not just the caller's (owners and admins). */
  readonly all: boolean
}

/** `canopy admin tokens list`: the admin API tokens with their role, expiry, last use and state. */
export async function tokensList(options: TokenListOptions, out: Output): Promise<number> {
  try {
    const body = await options.remote.get(options.all ? "/tokens?all=true" : "/tokens")
    const data = isDocument(body) && Array.isArray(body["data"]) ? body["data"] : []
    const entries = data.flatMap((value) => entryOf(value) ?? [])
    if (entries.length === 0) {
      out.log(
        "No admin API tokens. Create one with canopy admin tokens create --name ci --env <name>",
      )
      return 0
    }
    for (const entry of entries)
      out.log(
        `${entry.id}  ${`${entry.prefix}...`.padEnd(20)}  ${entry.role.padEnd(9)}  ${JSON.stringify(entry.name)}${options.all ? `  admin ${entry.userId}` : ""}  expires ${show(entry.expiresAt, "never")}  last used ${show(entry.lastUsedAt, "never")}  ${state(entry)}`,
      )
    return 0
  } catch (error: unknown) {
    return refused(error, out)
  }
}

/** Options of `canopy admin tokens revoke`. */
export interface TokenRevokeOptions {
  readonly remote: AdminClient
  readonly id: string
  readonly yes: boolean
}

/** `canopy admin tokens revoke <id>`: revokes a token at once, after confirmation. */
export async function tokensRevoke(options: TokenRevokeOptions, out: Output): Promise<number> {
  const question = `Revoke the admin API token ${options.id}? Jobs that use it stop working at once.`
  if (!(await confirmed(out, question, options.yes))) return 1
  try {
    const entry = entryOf(await options.remote.delete(`/tokens/${encodeURIComponent(options.id)}`))
    out.log(`revoked  ${entry?.id ?? options.id}  ${JSON.stringify(entry?.name ?? "")}`)
    return 0
  } catch (error: unknown) {
    return refused(error, out)
  }
}
