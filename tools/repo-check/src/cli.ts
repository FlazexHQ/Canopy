#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { checkCargo } from "./cargo.ts"
import { checkCommitMessage } from "./commit.ts"
import { findDashes } from "./dashes.ts"
import { checkWorkspace } from "./workspace.ts"

/** Files the dash scan never reads: generated lockfiles and binary formats. */
export const DASH_SCAN_EXCLUDED: RegExp =
  /(?:^|\/)bun\.lock$|\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz|wasm)$/i

/** Where the CLI writes its report and which directory it treats as the repository root. */
export interface CliContext {
  readonly cwd: string
  readonly out: (line: string) => void
  /** Lists repository files relative to the given root. Defaults to tracked and untracked files not ignored by Git. */
  readonly listFiles?: (cwd: string) => string[]
}

const USAGE = [
  "usage: canopy-repo-check [--root <dir>] <check>...",
  "",
  "--root <dir> makes later checks run against <dir> instead of the working directory.",
  "",
  "checks:",
  "  workspace            workspace packages and crates follow the repository layout",
  "  dashes               no punctuation dashes in repository files",
  "  commit-msg <file>    the commit message in <file> follows the commit rules",
].join("\n")

/**
 * Runs the requested checks and reports every problem.
 *
 * @returns the process exit code: 0 when all checks pass, 1 when a check fails, 2 on a usage error.
 */
export async function run(args: readonly string[], context: CliContext): Promise<number> {
  if (args.length === 0 || args.includes("--help")) {
    context.out(USAGE)
    return args.length === 0 ? 2 : 0
  }
  const problems: string[] = []
  let root = context.cwd
  for (let i = 0; i < args.length; i++) {
    const command = args[i]
    if (command === "--root") {
      const dir = args[++i]
      if (dir === undefined) {
        context.out(`--root needs a directory\n\n${USAGE}`)
        return 2
      }
      root = resolve(context.cwd, dir)
    } else if (command === "workspace") {
      problems.push(...(await checkWorkspace(root)), ...(await checkCargo(root)))
    } else if (command === "dashes") {
      problems.push(...(await scanDashes(root, context.listFiles ?? gitFiles)))
    } else if (command === "commit-msg") {
      const file = args[++i]
      if (file === undefined) {
        context.out(`commit-msg needs the path of the message file\n\n${USAGE}`)
        return 2
      }
      const message = await readFile(resolve(context.cwd, file), "utf8")
      problems.push(...checkCommitMessage(message).map((problem) => `commit message: ${problem}`))
    } else {
      context.out(`unknown check "${command}"\n\n${USAGE}`)
      return 2
    }
  }
  for (const problem of problems) context.out(problem)
  return problems.length === 0 ? 0 : 1
}

async function scanDashes(root: string, listFiles: (cwd: string) => string[]): Promise<string[]> {
  const files = listFiles(root)
  const problems: string[] = []
  for (const file of files) {
    if (DASH_SCAN_EXCLUDED.test(file)) continue
    let text: string
    try {
      text = await readFile(join(root, file), "utf8")
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    for (const dash of findDashes(file, text)) {
      problems.push(`${file}:${dash.line}:${dash.column}: ${dash.kind} used as punctuation`)
    }
  }
  return problems
}

function gitFiles(cwd: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd,
      encoding: "utf8",
    },
  )
  return [...new Set(output.split("\0").filter((file) => file !== ""))].sort()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
  })
  process.exitCode = code
}
