import { readFile } from "node:fs/promises"
import type { ImportedPasswordHash } from "@canopy/auth"
import type { Output } from "./output.ts"
import type { AdminClient } from "./remote.ts"

/** The export formats `canopy auth import` reads. */
export type ImportSource = "firebase" | "auth0" | "cognito" | "csv"

/** A user ready for `POST /admin/v1/users/import`. */
interface ImportRecord {
  readonly email: string
  readonly emailVerified?: boolean
  readonly name?: string
  readonly createdAt?: string
  readonly disabled?: boolean
  readonly roles?: readonly string[]
  readonly appMetadata?: Readonly<Record<string, unknown>>
  readonly userMetadata?: Readonly<Record<string, unknown>>
  readonly passwordHash?: ImportedPasswordHash
  readonly identities?: readonly { readonly provider: string; readonly subject: string }[]
}

/** Firebase Auth's project wide password hash parameters (Authentication, Users, Password hash parameters). */
export interface FirebaseHashConfig {
  readonly signerKey: string
  readonly saltSeparator: string
  readonly rounds: number
  readonly memCost: number
}

/** What a parse produced: the users, and the ones that could not be read, with why. */
export interface ParsedImport {
  readonly users: readonly ImportRecord[]
  readonly skipped: readonly { readonly line: number; readonly reason: string }[]
}

/**
 * Parses RFC 4180 CSV: quoted fields with doubled quotes, commas and line breaks inside quotes, and CRLF
 * or LF line ends. Returns the parsed lines as arrays of fields, header included.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') quoted = false
      else field += char
      continue
    }
    if (char === '"' && field === "") quoted = true
    else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1
      row.push(field)
      field = ""
      if (row.some((cell) => cell !== "")) rows.push(row)
      row = []
    } else field += char
  }
  row.push(field)
  if (row.some((cell) => cell !== "")) rows.push(row)
  return rows
}

function truthy(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined
  return /^(true|1|yes)$/i.test(value.trim())
}

function date(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed =
    typeof value === "number" || /^\d+$/.test(String(value))
      ? new Date(Number(value))
      : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

const FIREBASE_PROVIDERS: Readonly<Record<string, string>> = {
  "google.com": "google",
  "github.com": "github",
  "apple.com": "apple",
  "microsoft.com": "microsoft",
}

const AUTH0_PROVIDERS: Readonly<Record<string, string>> = {
  "google-oauth2": "google",
  github: "github",
  apple: "apple",
  windowslive: "microsoft",
  discord: "discord",
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Reads `firebase auth:export users.json --format=json`. Password hashes need the project's parameters. */
export function parseFirebase(text: string, hash: FirebaseHashConfig | undefined): ParsedImport {
  const parsed = record(JSON.parse(text))
  const list = Array.isArray(parsed?.["users"]) ? (parsed["users"] as unknown[]) : []
  const users: ImportRecord[] = []
  const skipped: { line: number; reason: string }[] = []
  list.forEach((entry, index) => {
    const user = record(entry)
    const email = user?.["email"]
    if (user === undefined || typeof email !== "string") {
      skipped.push({ line: index + 1, reason: "no email" })
      return
    }
    const identities = (Array.isArray(user["providerUserInfo"]) ? user["providerUserInfo"] : [])
      .map((info) => record(info))
      .flatMap((info) => {
        const provider = FIREBASE_PROVIDERS[String(info?.["providerId"])]
        const subject = info?.["rawId"]
        return provider === undefined || typeof subject !== "string" ? [] : [{ provider, subject }]
      })
    const passwordHash = user["passwordHash"]
    const salt = user["salt"]
    const createdAt = date(user["createdAt"])
    users.push({
      email,
      ...(typeof user["emailVerified"] === "boolean"
        ? { emailVerified: user["emailVerified"] }
        : {}),
      ...(typeof user["displayName"] === "string" ? { name: user["displayName"] } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(user["disabled"] === true ? { disabled: true } : {}),
      appMetadata: { importedFrom: { system: "firebase", id: user["localId"] } },
      ...(hash !== undefined && typeof passwordHash === "string" && typeof salt === "string"
        ? {
            passwordHash: {
              algorithm: "firebase-scrypt",
              ...hash,
              salt,
              hash: passwordHash,
            },
          }
        : {}),
      ...(identities.length === 0 ? {} : { identities }),
    })
  })
  return { users, skipped }
}

/**
 * Reads an Auth0 bulk user export (newline delimited JSON, or a JSON array). Password hashes come only
 * from Auth0's support export, as `passwordHash` (bcrypt) on the same records.
 */
export function parseAuth0(text: string): ParsedImport {
  const trimmed = text.trim()
  const entries: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown)
  const users: ImportRecord[] = []
  const skipped: { line: number; reason: string }[] = []
  entries.forEach((entry, index) => {
    const user = record(entry)
    const email = user?.["email"] ?? user?.["Email"]
    if (user === undefined || typeof email !== "string") {
      skipped.push({ line: index + 1, reason: "no email" })
      return
    }
    const hash = user["passwordHash"] ?? user["password_hash"] ?? user["custom_password_hash"]
    const identities = (Array.isArray(user["identities"]) ? user["identities"] : [])
      .map((identity) => record(identity))
      .flatMap((identity) => {
        const provider = AUTH0_PROVIDERS[String(identity?.["provider"])]
        const subject = identity?.["user_id"]
        return provider === undefined || subject === undefined
          ? []
          : [{ provider, subject: String(subject) }]
      })
    const createdAt = date(user["created_at"] ?? user["Created At"])
    const appMetadata = record(user["app_metadata"])
    const userMetadata = record(user["user_metadata"])
    users.push({
      email,
      ...(typeof user["email_verified"] === "boolean"
        ? { emailVerified: user["email_verified"] }
        : {}),
      ...(typeof user["name"] === "string" ? { name: user["name"] } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(user["blocked"] === true ? { disabled: true } : {}),
      appMetadata: { ...appMetadata, importedFrom: { system: "auth0", id: user["user_id"] } },
      ...(userMetadata === undefined ? {} : { userMetadata }),
      ...(typeof hash === "string" && hash.startsWith("$2")
        ? { passwordHash: { algorithm: "bcrypt", hash } }
        : {}),
      ...(identities.length === 0 ? {} : { identities }),
    })
  })
  return { users, skipped }
}

function table(text: string): { header: string[]; rows: string[][] } {
  const [header = [], ...rows] = parseCsv(text)
  return { header: header.map((name) => name.trim()), rows }
}

/**
 * Reads a CSV export of an Amazon Cognito user pool (one column per attribute, such as `email`,
 * `email_verified`, `name` and `sub`). Cognito never exports password hashes, so these users sign in with
 * a magic link, an OTP or a password reset.
 */
export function parseCognito(text: string): ParsedImport {
  const { header, rows } = table(text)
  const at = (row: string[], name: string): string | undefined => {
    const index = header.indexOf(name)
    return index < 0 ? undefined : row[index]
  }
  const users: ImportRecord[] = []
  const skipped: { line: number; reason: string }[] = []
  rows.forEach((row, index) => {
    const email = at(row, "email")
    if (email === undefined || email === "") {
      skipped.push({ line: index + 2, reason: "no email" })
      return
    }
    const name =
      at(row, "name") ??
      [at(row, "given_name"), at(row, "family_name")].filter((part) => part).join(" ")
    const verified = truthy(at(row, "email_verified"))
    const enabled = truthy(at(row, "enabled") ?? at(row, "cognito:enabled"))
    users.push({
      email,
      ...(verified === undefined ? {} : { emailVerified: verified }),
      ...(name === undefined || name === "" ? {} : { name }),
      ...(enabled === false ? { disabled: true } : {}),
      appMetadata: {
        importedFrom: { system: "cognito", id: at(row, "sub") ?? at(row, "cognito:username") },
      },
    })
  })
  return { users, skipped }
}

/**
 * Reads a generic CSV with the columns `email` (required), `id` (the user's id in the old system, kept as
 * `app_metadata.importedFrom`), `email_verified`, `name`, `created_at`, `roles` (separated by `;`),
 * `password_hash` with `password_algorithm` (`bcrypt` or `argon2id`, or `pbkdf2-sha256` with
 * `password_salt` and `password_iterations`; bcrypt hashes are recognized without it), and `disabled`.
 */
export function parseGenericCsv(text: string): ParsedImport {
  const { header, rows } = table(text)
  const at = (row: string[], name: string): string | undefined => {
    const index = header.indexOf(name)
    const value = index < 0 ? undefined : row[index]
    return value === "" ? undefined : value
  }
  const users: ImportRecord[] = []
  const skipped: { line: number; reason: string }[] = []
  rows.forEach((row, index) => {
    const line = index + 2
    const email = at(row, "email")
    if (email === undefined) {
      skipped.push({ line, reason: "no email" })
      return
    }
    const hash = at(row, "password_hash")
    const algorithm =
      at(row, "password_algorithm") ?? (hash?.startsWith("$2") ? "bcrypt" : undefined)
    let passwordHash: ImportedPasswordHash | undefined
    if (hash !== undefined) {
      if (algorithm === "bcrypt" || algorithm === "argon2id") passwordHash = { algorithm, hash }
      else if (
        algorithm === "pbkdf2-sha256" ||
        algorithm === "pbkdf2-sha512" ||
        algorithm === "pbkdf2-sha1"
      )
        passwordHash = {
          algorithm,
          hash,
          salt: at(row, "password_salt") ?? "",
          iterations: Number(at(row, "password_iterations") ?? "0"),
        }
      else {
        skipped.push({ line, reason: `unknown password_algorithm ${algorithm ?? "(none)"}` })
        return
      }
    }
    const verified = truthy(at(row, "email_verified"))
    const createdAt = date(at(row, "created_at"))
    const roles = at(row, "roles")
      ?.split(";")
      .map((role) => role.trim())
      .filter((role) => role !== "")
    const name = at(row, "name")
    const id = at(row, "id")
    users.push({
      email,
      ...(verified === undefined ? {} : { emailVerified: verified }),
      ...(name === undefined ? {} : { name }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(truthy(at(row, "disabled")) === true ? { disabled: true } : {}),
      ...(roles === undefined || roles.length === 0 ? {} : { roles }),
      ...(id === undefined ? {} : { appMetadata: { importedFrom: { system: "csv", id } } }),
      ...(passwordHash === undefined ? {} : { passwordHash }),
    })
  })
  return { users, skipped }
}

function parseImport(
  source: ImportSource,
  text: string,
  firebase?: FirebaseHashConfig,
): ParsedImport {
  switch (source) {
    case "firebase":
      return parseFirebase(text, firebase)
    case "auth0":
      return parseAuth0(text)
    case "cognito":
      return parseCognito(text)
    case "csv":
      return parseGenericCsv(text)
  }
}

/** Options of `canopy auth import`. */
export interface AuthImportOptions {
  readonly file: string
  readonly from: ImportSource
  readonly firebase?: FirebaseHashConfig
  /** Parses and reports without sending anything. */
  readonly dryRun: boolean
  readonly remote: AdminClient | undefined
  /** Users per request. Defaults to 500. */
  readonly batchSize?: number
}

interface BatchResult {
  readonly created: number
  readonly skipped: number
  readonly failed: readonly { readonly email: string; readonly reason: string }[]
}

/**
 * `canopy auth import`: reads an export of another identity system and imports its users into built in
 * auth through the admin API, in batches. Imported password hashes are checked on each user's first sign
 * in and then replaced by a native hash. Users whose email exists are left alone. Returns the exit code:
 * 1 when any user failed.
 */
export async function authImport(options: AuthImportOptions, out: Output): Promise<number> {
  const parsed = parseImport(options.from, await readFile(options.file, "utf8"), options.firebase)
  for (const entry of parsed.skipped) out.error(`skip   line ${entry.line}: ${entry.reason}`)
  const withPasswords = parsed.users.filter((user) => user.passwordHash !== undefined).length
  out.log(
    `${parsed.users.length} users read from ${options.file} (${withPasswords} with password hashes, ${parsed.skipped.length} unreadable)`,
  )
  if (options.from === "firebase" && options.firebase === undefined)
    out.log(
      "No --hash-key given: Firebase password hashes are left out, so these users need a magic link or a reset.",
    )
  if (options.dryRun) return parsed.skipped.length > 0 ? 1 : 0
  const remote = options.remote
  if (remote === undefined) {
    out.error(
      "canopy auth import talks to a running project: pass --env <name> after canopy login <url>",
    )
    return 1
  }
  const size = options.batchSize ?? 500
  let created = 0
  let skipped = 0
  const failed: { email: string; reason: string }[] = []
  for (let start = 0; start < parsed.users.length; start += size) {
    const result = (await remote.post("/users/import", {
      users: parsed.users.slice(start, start + size),
    })) as BatchResult
    created += result.created
    skipped += result.skipped
    failed.push(...result.failed)
    out.log(`${Math.min(start + size, parsed.users.length)} / ${parsed.users.length}`)
  }
  for (const failure of failed) out.error(`failed ${failure.email}: ${failure.reason}`)
  out.log(`${created} imported, ${skipped} already existed, ${failed.length} failed`)
  return failed.length > 0 || parsed.skipped.length > 0 ? 1 : 0
}
