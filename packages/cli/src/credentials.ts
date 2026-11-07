import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** The result of running a keychain tool. */
export interface ToolResult {
  readonly code: number
  readonly stdout: string
}

/** Runs a program with arguments and optional standard input. Injected so tests avoid the real keychain. */
export type ToolRunner = (
  program: string,
  args: readonly string[],
  input?: string,
) => Promise<ToolResult>

/** Runs a real program. A missing program gives code 127. */
export const runTool: ToolRunner = (program, args, input) =>
  new Promise((done) => {
    const child = execFile(program, [...args], { timeout: 30_000 }, (error, stdout) => {
      const code =
        error === null
          ? 0
          : typeof error.code === "number"
            ? error.code
            : error.code === "ENOENT"
              ? 127
              : 1
      done({ code, stdout: String(stdout) })
    })
    child.stdin?.end(input ?? "")
  })

const SERVICE = "canopy"

/** Where an admin token is kept. */
export type CredentialStore = "keychain" | "file"

/** Options of the credential functions. */
export interface CredentialOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly run?: ToolRunner
}

/**
 * The fallback file: `$CANOPY_CREDENTIALS`, else `$XDG_CONFIG_HOME/canopy/credentials.json`, else
 * `~/.config/canopy/credentials.json`. It is written with mode 0600 and holds tokens in plain text, so it
 * is only as safe as the account that owns it.
 */
export function credentialsFile(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env["CANOPY_CREDENTIALS"]
  if (explicit !== undefined && explicit !== "") return explicit
  const base = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config")
  return join(base, "canopy", "credentials.json")
}

/** Normalizes a project URL so `https://x.example/` and `https://x.example` share one entry. */
export function projectKey(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new TypeError(`${url} is not an http or https URL`)
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
}

async function readFileStore(path: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return {}
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

async function writeFileStore(path: string, tokens: Record<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function keychainCommands(
  platform: NodeJS.Platform,
  account: string,
  token: string,
): { readonly program: string; readonly args: string[]; readonly input?: string } | undefined {
  if (platform === "darwin")
    return {
      program: "security",
      args: ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", token],
    }
  if (platform === "linux")
    return {
      program: "secret-tool",
      args: [
        "store",
        "--label",
        `Canopy admin token for ${account}`,
        "service",
        SERVICE,
        "account",
        account,
      ],
      input: token,
    }
  return undefined
}

/**
 * Stores an admin token for a project: in the macOS Keychain (`security`) or the Secret Service on Linux
 * (`secret-tool`) when available, otherwise in the credentials file. Returns where it went.
 */
export async function saveToken(
  url: string,
  token: string,
  options: CredentialOptions,
): Promise<CredentialStore> {
  const account = projectKey(url)
  const run = options.run ?? runTool
  const command =
    options.env["CANOPY_CREDENTIALS"] === undefined
      ? keychainCommands(options.platform ?? process.platform, account, token)
      : undefined
  if (command !== undefined) {
    const result = await run(command.program, command.args, command.input)
    if (result.code === 0) {
      await forgetFileToken(account, options.env)
      return "keychain"
    }
  }
  const path = credentialsFile(options.env)
  const tokens = await readFileStore(path)
  tokens[account] = token
  await writeFileStore(path, tokens)
  return "file"
}

async function forgetFileToken(
  account: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const path = credentialsFile(env)
  const tokens = await readFileStore(path)
  if (!(account in tokens)) return false
  delete tokens[account]
  await writeFileStore(path, tokens)
  return true
}

/** Reads the admin token of a project from the keychain or the credentials file. */
export async function readToken(
  url: string,
  options: CredentialOptions,
): Promise<string | undefined> {
  const account = projectKey(url)
  const run = options.run ?? runTool
  const platform = options.platform ?? process.platform
  if (options.env["CANOPY_CREDENTIALS"] === undefined) {
    const lookup =
      platform === "darwin"
        ? await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
        : platform === "linux"
          ? await run("secret-tool", ["lookup", "service", SERVICE, "account", account])
          : undefined
    if (lookup !== undefined && lookup.code === 0 && lookup.stdout.trim() !== "")
      return lookup.stdout.trim()
  }
  return (await readFileStore(credentialsFile(options.env)))[account]
}

/** Removes the admin token of a project from both stores. Returns whether one was found. */
export async function deleteToken(url: string, options: CredentialOptions): Promise<boolean> {
  const account = projectKey(url)
  const run = options.run ?? runTool
  const platform = options.platform ?? process.platform
  let found = false
  if (options.env["CANOPY_CREDENTIALS"] === undefined) {
    const removed =
      platform === "darwin"
        ? await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account])
        : platform === "linux"
          ? await run("secret-tool", ["clear", "service", SERVICE, "account", account])
          : undefined
    found = removed?.code === 0
  }
  return (await forgetFileToken(account, options.env)) || found
}
