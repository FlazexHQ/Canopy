import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
  credentialsFile,
  environmentsFile,
  projectKey,
  readEnvironment,
  readToken,
  type ToolResult,
} from "../src/credentials.ts"
import { login, logout } from "../src/login.ts"
import type { Output } from "../src/output.ts"
import type { Fetch } from "../src/remote.ts"

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

/** An admin API that knows `tokens`; every request is recorded. */
function adminApi(tokens: Readonly<Record<string, string>> = {}): {
  requests: { url: string; authorization: string | null }[]
  fetch: Fetch
} {
  const requests: { url: string; authorization: string | null }[] = []
  return {
    requests,
    fetch: async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization")
      requests.push({ url, authorization })
      const token = authorization?.replace(/^Bearer /, "") ?? ""
      const email = tokens[token]
      if (!url.endsWith("/admin/v1/me")) return new Response("Not found", { status: 404 })
      if (email === undefined)
        return Response.json(
          { status: 401, code: "CANOPY_UNAUTHORIZED", detail: "Log in to use the admin API" },
          { status: 401, headers: { "content-type": "application/problem+json" } },
        )
      return Response.json({
        user: { id: "adm_1", email, role: "admin" },
        environment: "production",
        permissions: ["policies.read", "policies.publish"],
      })
    },
  }
}

const fetch = adminApi({
  tok_1: "ops@example.com",
  tok_a: "a@example.com",
  tok_b: "b@example.com",
  from_env: "env@example.com",
  from_prompt: "prompt@example.com",
  t: "t@example.com",
}).fetch

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
        { url: "https://p.example/", token: "tok_1", env, platform, run: tool.run, fetch },
        out,
      )
      expect(code).toBe(0)
      expect(lines).toEqual([
        "Logged in to https://p.example as ops@example.com (admin, production); the token is in the OS keychain.",
      ])
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

  it("keeps the credentials and environments files in the per user config folder of each OS", () => {
    const home = { HOME: "/home/ada", USERPROFILE: "C:\\Users\\ada" }
    const appData = "C:\\Users\\ada\\AppData\\Roaming"
    expect(credentialsFile(home, "linux")).toBe(
      join("/home/ada", ".config", "canopy", "credentials.json"),
    )
    expect(credentialsFile(home, "darwin")).toBe(
      join("/home/ada", ".config", "canopy", "credentials.json"),
    )
    expect(credentialsFile({ ...home, APPDATA: appData }, "win32")).toBe(
      join(appData, "canopy", "credentials.json"),
    )
    expect(credentialsFile(home, "win32")).toBe(
      join("C:\\Users\\ada", "AppData", "Roaming", "canopy", "credentials.json"),
    )
    expect(environmentsFile({ ...home, APPDATA: appData }, "win32")).toBe(
      join(appData, "canopy", "environments.json"),
    )
    expect(credentialsFile({ ...home, XDG_CONFIG_HOME: "/xdg", APPDATA: appData }, "win32")).toBe(
      join("/xdg", "canopy", "credentials.json"),
    )
    expect(credentialsFile({ ...home, CANOPY_CREDENTIALS: "/run/secret.json" }, "win32")).toBe(
      "/run/secret.json",
    )
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
      expect(await login({ url, token, env, platform, run: tool.run, fetch }, out)).toBe(0)
      expect(lines[0]).toContain(
        platform === "win32"
          ? "the token is in the credentials file (in your Windows user profile)"
          : "the token is in the credentials file (mode 0600)",
      )
    }
    const file = join(config, "canopy", "credentials.json")
    expect(credentialsFile(env)).toBe(file)
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "https://a.example": "tok_a",
      "https://b.example": "tok_b",
    })
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
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
    expect(await login({ url: "https://e.example", env, fetch }, capture().out)).toBe(0)
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
        { url: "https://f.example", env: { CANOPY_CREDENTIALS: credentials }, fetch },
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
      await login({ url: "http://localhost:8080", token: "t", env, fetch }, capture().out),
    ).toBe(0)
  })

  it("verifies the token with GET /admin/v1/me and stores nothing the server refuses", async () => {
    await mkdir(scratch, { recursive: true })
    const credentials = join(await mkdtemp(join(scratch, "verify-")), "c.json")
    const env = { CANOPY_CREDENTIALS: credentials }
    const api = adminApi({ good: "ops@example.com" })

    const refused = capture()
    expect(
      await login(
        { url: "https://v.example/eu/", token: "stolen", env, fetch: api.fetch },
        refused.out,
      ),
    ).toBe(1)
    expect(api.requests).toEqual([
      { url: "https://v.example/eu/admin/v1/me", authorization: "Bearer stolen" },
    ])
    expect(refused.errors[0]).toContain("https://v.example/eu refused the token")
    expect(refused.errors.at(-1)).toBe("Nothing was stored.")
    await expect(stat(credentials)).rejects.toThrow()

    const down = capture()
    const unreachable: Fetch = async () => {
      throw new TypeError("fetch failed")
    }
    expect(
      await login({ url: "https://v.example", token: "good", env, fetch: unreachable }, down.out),
    ).toBe(1)
    expect(down.errors[0]).toBe(
      "https://v.example did not answer, so the token could not be verified.",
    )
    await expect(stat(credentials)).rejects.toThrow()

    const notCanopy: Fetch = async () => Response.json({ hello: "world" })
    expect(
      await login(
        { url: "https://v.example", token: "good", env, fetch: notCanopy },
        capture().out,
      ),
    ).toBe(1)
    await expect(stat(credentials)).rejects.toThrow()

    expect(
      await login(
        { url: "https://v.example", token: "good", env, fetch: api.fetch },
        capture().out,
      ),
    ).toBe(0)
    expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({ "https://v.example": "good" })
  })

  it("remembers the project under an environment name with --env", async () => {
    await mkdir(scratch, { recursive: true })
    const config = await mkdtemp(join(scratch, "envs-"))
    const env = { XDG_CONFIG_HOME: config, CANOPY_CREDENTIALS: join(config, "c.json") }
    const api = adminApi({ good: "ops@example.com" })
    const bad = capture()
    expect(
      await login(
        { url: "https://prod.example", token: "good", environment: "prod uction", env, fetch },
        bad.out,
      ),
    ).toBe(1)
    expect(bad.errors[0]).toContain("is not an environment name")
    expect(api.requests).toEqual([])

    const refused = capture()
    expect(
      await login(
        {
          url: "https://prod.example",
          token: "nope",
          environment: "production",
          env,
          fetch: api.fetch,
        },
        refused.out,
      ),
    ).toBe(1)
    expect(await readEnvironment("production", env)).toBeUndefined()

    const done = capture()
    expect(
      await login(
        {
          url: "https://prod.example/",
          token: "good",
          environment: "production",
          env,
          fetch: api.fetch,
        },
        done.out,
      ),
    ).toBe(0)
    expect(done.lines.at(-1)).toBe(
      "--env production now selects https://prod.example for canopy policies and canopy admin tokens.",
    )
    expect(environmentsFile(env)).toBe(join(config, "canopy", "environments.json"))
    expect(await readEnvironment("production", env)).toBe("https://prod.example")
    expect(await readEnvironment("staging", env)).toBeUndefined()
  })
})
