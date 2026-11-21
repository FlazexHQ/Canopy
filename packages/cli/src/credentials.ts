import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CanopyError, ErrorCode, trimTrailingSlashes } from "@canopy/protocol"

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
const runTool: ToolRunner = (program, args, input) =>
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

/**
 * Where an admin token is kept: the OS keychain (macOS, Linux), the credentials file encrypted for the
 * Windows account with DPAPI (`protected`), or the credentials file in plain text.
 */
export type CredentialStore = "keychain" | "protected" | "file"

/** Options of the credential functions. */
export interface CredentialOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly run?: ToolRunner
}

function configDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  const xdg = env["XDG_CONFIG_HOME"]
  if (xdg !== undefined && xdg !== "") return join(xdg, "canopy")
  if (platform === "win32")
    return join(
      env["APPDATA"] || join(env["USERPROFILE"] || homedir(), "AppData", "Roaming"),
      "canopy",
    )
  return join(env["HOME"] || homedir(), ".config", "canopy")
}

/**
 * The fallback file: `$CANOPY_CREDENTIALS`, else `credentials.json` in the per user config folder
 * (`$XDG_CONFIG_HOME/canopy`, `%APPDATA%\canopy` on Windows, `~/.config/canopy` elsewhere). It holds tokens
 * in plain text on Linux and macOS (with mode 0600) when no keychain is available. On Windows each token is
 * encrypted for the signed in account with DPAPI, unless `$CANOPY_CREDENTIALS` names the file or PowerShell
 * cannot run.
 */
export function credentialsFile(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env["CANOPY_CREDENTIALS"]
  if (explicit !== undefined && explicit !== "") return explicit
  return join(configDir(env, platform), "credentials.json")
}

/** Normalizes a project URL so `https://x.example/` and `https://x.example` share one entry. */
export function projectKey(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new TypeError(`${url} is not an http or https URL`)
  return `${parsed.origin}${trimTrailingSlashes(parsed.pathname)}`
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

/**
 * Reads a JSON file of strings. A missing file is empty; an unreadable or corrupt one throws, so the next
 * write does not replace the entries of other projects.
 */
async function readFileStore(path: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return {}
    throw new CanopyError(
      ErrorCode.ConfigInvalid,
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new CanopyError(ErrorCode.ConfigInvalid, `${path} is not valid JSON; fix or remove it`, {
      cause: error,
    })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CanopyError(
      ErrorCode.ConfigInvalid,
      `${path} must hold a JSON object; fix or remove it`,
    )
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

async function writeFileStore(path: string, tokens: Record<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  await writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await renameWithRetry(temporary, path)
}

const BUSY = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * Renames over an existing file. On Windows the rename fails while another process (an indexer, an
 * antivirus scanner, a second `canopy`) has the target open, so busy errors are retried for about 3 s.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      const code = errorCode(error)
      if (code === undefined || !BUSY.has(code) || attempt >= 10) {
        await rm(from, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 500)))
    }
  }
}

const PROTECTED_PREFIX = "dpapi:"
const POWERSHELL = "powershell.exe"

function dpapiScript(verb: "Protect" | "Unprotect"): string {
  const [input, output] =
    verb === "Protect"
      ? ["[Text.Encoding]::UTF8.GetBytes($text)", "[Convert]::ToBase64String($bytes)"]
      : ["[Convert]::FromBase64String($text)", "[Text.Encoding]::UTF8.GetString($bytes)"]
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$text = [Console]::In.ReadToEnd().Trim()",
    `$bytes = [Security.Cryptography.ProtectedData]::${verb}(${input}, $null, 'CurrentUser')`,
    `[Console]::Out.Write(${output})`,
  ].join("; ")
}

/**
 * Encrypts or decrypts `input` for the signed in Windows account with DPAPI, through Windows PowerShell.
 * The secret travels on standard input, never on the command line. `undefined` when that fails.
 */
async function dpapi(
  run: ToolRunner,
  verb: "Protect" | "Unprotect",
  input: string,
): Promise<string | undefined> {
  const result = await run(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(verb)],
    input,
  )
  const output = result.stdout.trim()
  return result.code === 0 && output !== "" ? output : undefined
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
      await forgetFileToken(account, options.env, options.platform)
      return "keychain"
    }
  }
  const platform = options.platform ?? process.platform
  const path = credentialsFile(options.env, platform)
  const tokens = await readFileStore(path)
  const sealed =
    platform === "win32" && options.env["CANOPY_CREDENTIALS"] === undefined
      ? await dpapi(run, "Protect", token)
      : undefined
  tokens[account] = sealed === undefined ? token : `${PROTECTED_PREFIX}${sealed}`
  await writeFileStore(path, tokens)
  return sealed === undefined ? "file" : "protected"
}

async function forgetFileToken(
  account: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform | undefined,
): Promise<boolean> {
  const path = credentialsFile(env, platform)
  const tokens = await readFileStore(path)
  if (!(account in tokens)) return false
  delete tokens[account]
  await writeFileStore(path, tokens)
  return true
}

/**
 * Encrypts a token that an older version left in plain text in the default Windows credentials file.
 * Best effort: when PowerShell fails or the file cannot be written, the token stays as it was.
 */
async function sealStoredToken(
  path: string,
  account: string,
  token: string,
  run: ToolRunner,
): Promise<void> {
  try {
    const sealed = await dpapi(run, "Protect", token)
    if (sealed === undefined) return
    const latest = await readFileStore(path)
    if (latest[account] !== token) return
    await writeFileStore(path, { ...latest, [account]: `${PROTECTED_PREFIX}${sealed}` })
  } catch {
    // The plain text token still works; sealing is retried on the next read.
  }
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
  const path = credentialsFile(options.env, platform)
  const tokens = await readFileStore(path)
  const stored = tokens[account]
  if (stored === undefined) return stored
  if (!stored.startsWith(PROTECTED_PREFIX)) {
    if (platform === "win32" && options.env["CANOPY_CREDENTIALS"] === undefined)
      await sealStoredToken(path, account, stored, run)
    return stored
  }
  const token = await dpapi(run, "Unprotect", stored.slice(PROTECTED_PREFIX.length))
  if (token === undefined)
    throw new CanopyError(
      ErrorCode.Unauthorized,
      `The token for ${account} is encrypted for another Windows account, or this one cannot read it any more; run canopy login again`,
    )
  return token
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
  return (await forgetFileToken(account, options.env, platform)) || found
}

const ENVIRONMENT_NAME = /^[A-Za-z][\w-]{0,63}$/

/** Whether `name` can name an environment for `--env`: a letter, then up to 63 word characters or `-`. */
export function isEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name)
}

/**
 * The file that maps environment names (`--env production`) to project URLs: `$CANOPY_ENVIRONMENTS`, else
 * `environments.json` next to the default credentials file. It holds no secrets.
 */
export function environmentsFile(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env["CANOPY_ENVIRONMENTS"]
  if (explicit !== undefined && explicit !== "") return explicit
  return join(configDir(env, platform), "environments.json")
}

/** Remembers that the environment `name` is the project at `url`. */
export async function saveEnvironment(
  name: string,
  url: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const path = environmentsFile(env, platform)
  const environments = await readFileStore(path)
  environments[name] = projectKey(url)
  await writeFileStore(path, environments)
}

/** The project URL stored for an environment name. */
export async function readEnvironment(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  return (await readFileStore(environmentsFile(env, platform)))[name]
}
