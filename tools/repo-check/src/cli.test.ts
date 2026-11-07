import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { run } from "./cli.ts"

let root: string
let lines: string[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-check-cli-"))
  lines = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(path: string, content: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

function context(files?: string[]) {
  return {
    cwd: root,
    out: (line: string) => lines.push(line),
    ...(files === undefined ? {} : { listFiles: () => files }),
  }
}

describe("run", () => {
  it("prints usage and exits 2 without arguments, 0 for --help", async () => {
    expect(await run([], context())).toBe(2)
    expect(lines[0]).toMatch(/^usage: canopy-repo-check/)
    expect(await run(["--help"], context())).toBe(0)
  })

  it("exits 2 on an unknown check or a missing argument", async () => {
    expect(await run(["lint"], context())).toBe(2)
    expect(lines[0]).toMatch(/^unknown check "lint"/)
    expect(await run(["commit-msg"], context())).toBe(2)
    expect(await run(["--root"], context())).toBe(2)
  })

  it("reports dash problems as file:line:column and exits 1", async () => {
    await write("README.md", "ok\nbad \x2d line\n")
    await write("src/a.ts", "const n = a \x2d b\n")
    await write("bun.lock", "x \u2014 y\n")
    await write("logo.png", "x \u2014 y")
    expect(
      await run(
        ["dashes"],
        context(["README.md", "src/a.ts", "bun.lock", "logo.png", "deleted.md"]),
      ),
    ).toBe(1)
    expect(lines).toEqual(["README.md:2:5: spaced hyphen used as punctuation"])
  })

  it("exits 0 when every check passes", async () => {
    await write("README.md", "A self-hostable tool.\n")
    expect(await run(["dashes"], context(["README.md"]))).toBe(0)
    expect(lines).toEqual([])
  })

  it("checks a commit message file given relative to the working directory", async () => {
    await write(".git/COMMIT_EDITMSG", "feat: add codec\n")
    expect(await run(["commit-msg", ".git/COMMIT_EDITMSG"], context())).toBe(1)
    expect(lines).toEqual([
      'commit message: missing DCO sign off: add "Signed-off-by: Name <email>" (use git commit -s)',
    ])
  })

  it("runs later checks against the directory given with --root", async () => {
    await write("repo/package.json", JSON.stringify({ workspaces: ["packages/*"] }))
    await write(
      "repo/tsconfig.json",
      JSON.stringify({ files: [], references: [{ path: "packages/gone" }] }),
    )
    expect(await run(["--root", "repo", "workspace"], context())).toBe(1)
    expect(lines).toEqual(["tsconfig.json references packages/gone, which has no tsconfig.json"])
  })

  it("lists tracked and untracked files from Git but skips ignored ones", async () => {
    execFileSync("git", ["init", "--quiet"], { cwd: root })
    await write(".gitignore", "ignored/\n")
    await write("tracked.md", "a \x2d b\n")
    await write("ignored/file.md", "a \x2d b\n")
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "tracked.md"], { cwd: root })
    await write("untracked.md", "c \x2d d\n")
    expect(await run(["dashes"], context())).toBe(1)
    expect(lines).toEqual([
      "tracked.md:1:3: spaced hyphen used as punctuation",
      "untracked.md:1:3: spaced hyphen used as punctuation",
    ])
  })
})
