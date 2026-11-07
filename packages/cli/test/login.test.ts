import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { credentialsFile, projectKey, readToken, type ToolResult } from "../src/credentials.ts"
import { login, logout } from "../src/login.ts"
import type { Output } from "../src/output.ts"

const scratch = fileURLToPath(new URL("./.tmp/login/", import.meta.url))
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function capture(): { lines: string[]; errors: string[]; out: Output } {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, out: { log: (l) => lines.push(l), error: (l) => errors.push(l) } }
}

/** A keychain that keeps secrets in memory, or one whose tool is missing. */
function keychain(available = true): {
  calls: { program: string; args: readonly string[]; input: string | undefined }[]
  run: (program: string, args: readonly string[], input?: string) => Promise<ToolResult>
} {
  const secrets = new Map<string, string>()
  const calls: { program: string; args: readonly string[]; input: string | undefined }[] = []
  return {
    calls,
    run: async (program, args, input) => {
      calls.push({ program, args, input })
      if (!available) return { code: 127, stdout: "" }
      const account = args[args.indexOf(program === "security" ? "-a" : "account") + 1] ?? ""
      const verb = args[0]
      if (verb === "add-generic-password") secrets.set(account, args.at(-1) ?? "")
      else if (verb === "store") secrets.set(account, input ?? "")
      else if (verb === "find-generic-password" || verb === "lookup") {
        const value = secrets.get(account)
        return value === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${value}\n` }
      } else if (verb === "delete-generic-password" || verb === "clear")
        return { code: secrets.delete(account) ? 0 : 44, stdout: "" }
      return { code: 0, stdout: "" }
    },
  }
}

const reachable = async (): Promise<boolean> => true

describe("canopy login", () => {
  it("normalizes project URLs", () => {
    expect(projectKey("https://canopy.example.com/")).toBe("https://canopy.example.com")
    expect(projectKey("https://Canopy.example.com/eu//")).toBe("https://canopy.example.com/eu")
    expect(() => projectKey("ftp://x")).toThrow("not an http or https URL")
  })

  it("stores the token in the macOS Keychain and in the Secret Service on Linux", async () => {
    await mkdir(scratch, { recursive: true })
    const home = await mkdtemp(join(scratch, "home-"))
    const env = { HOME: home }
    for (const platform of ["darwin", "linux"] as const) {
      const tool = keychain()
      const { lines, out } = capture()
      const code = await login(
        { url: "https://p.example/", token: "tok_1", env, platform, run: tool.run, reachable },
        out,
      )
      expect(code).toBe(0)
      expect(lines).toEqual(["Logged in to https://p.example; the token is in the OS keychain."])
      expect(tool.calls[0]?.program).toBe(platform === "darwin" ? "security" : "secret-tool")
      if (platform === "linux") {
        expect(tool.calls[0]?.input).toBe("tok_1")
        expect(tool.calls[0]?.args).not.toContain("tok_1")
      }
      expect(await readToken("https://p.example", { env, platform, run: tool.run })).toBe("tok_1")
      await expect(stat(credentialsFile(env))).rejects.toThrow()
      await logout({ url: "https://p.example", env, platform, run: tool.run }, capture().out)
      expect(await readToken("https://p.example", { env, platform, run: tool.run })).toBeUndefined()
    }
  })

  it("falls back to a 0600 credentials file without a keychain", async () => {
    await mkdir(scratch, { recursive: true })
    const config = await mkdtemp(join(scratch, "xdg-"))
    const env = { XDG_CONFIG_HOME: config }
    const tool = keychain(false)
    for (const [platform, url, token] of [
      ["linux", "https://a.example", "tok_a"],
      ["win32", "https://b.example", "tok_b"],
    ] as const) {
      const { lines, out } = capture()
      expect(await login({ url, token, env, platform, run: tool.run, reachable }, out)).toBe(0)
      expect(lines[0]).toContain("the token is in the credentials file (mode 0600)")
    }
    const file = join(config, "canopy", "credentials.json")
    expect(credentialsFile(env)).toBe(file)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "https://a.example": "tok_a",
      "https://b.example": "tok_b",
    })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(tool.calls.map((call) => call.program)).toEqual(["secret-tool"])

    const out = capture()
    await logout({ url: "https://a.example", env, platform: "win32", run: tool.run }, out.out)
    expect(out.lines).toEqual(["Logged out of https://a.example."])
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "https://b.example": "tok_b" })
  })

  it("takes the token from the environment or a hidden prompt, and refuses plain http", async () => {
    await mkdir(scratch, { recursive: true })
    const credentials = join(await mkdtemp(join(scratch, "file-")), "c.json")
    const env = { CANOPY_CREDENTIALS: credentials, CANOPY_ADMIN_TOKEN: "from_env" }
    expect(await login({ url: "https://e.example", env, reachable }, capture().out)).toBe(0)
    const asked: string[] = []
    const prompt = capture()
    const out: Output = {
      ...prompt.out,
      readSecret: async (question) => {
        asked.push(question)
        return " from_prompt\n"
      },
    }
    expect(
      await login(
        { url: "https://f.example", env: { CANOPY_CREDENTIALS: credentials }, reachable },
        out,
      ),
    ).toBe(0)
    expect(asked).toEqual(["Admin token for https://f.example: "])
    expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({
      "https://e.example": "from_env",
      "https://f.example": "from_prompt",
    })

    const none = capture()
    expect(
      await login({ url: "https://g.example", env: { CANOPY_CREDENTIALS: credentials } }, none.out),
    ).toBe(1)
    expect(none.errors[0]).toContain("No token")
    const http = capture()
    expect(await login({ url: "http://g.example", token: "t", env }, http.out)).toBe(1)
    expect(http.errors[0]).toContain("only sent over HTTPS")
    expect(
      await login({ url: "http://localhost:8080", token: "t", env, reachable }, capture().out),
    ).toBe(0)
    const unreachable = capture()
    await login(
      { url: "https://h.example", token: "t", env, reachable: async () => false },
      unreachable.out,
    )
    expect(unreachable.lines[0]).toBe(
      "warn  https://h.example/healthz did not answer; the token is stored anyway",
    )
  })
})
