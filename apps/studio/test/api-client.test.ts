import { CanopyError, ErrorCode } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import { createMockAdmin } from "../mock/admin.ts"
import { AdminApi, CSRF_HEADER, encodeId, isNotFound, statusOf } from "../src/api/client.ts"
import { ContractError } from "../src/api/schema.ts"
import { cookieFetch, OWNER } from "./harness.tsx"

const respond = (status: number, body: unknown, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  })

describe("AdminApi", () => {
  it("turns Problem Details into CanopyErrors that keep the code, detail and status", async () => {
    const api = new AdminApi({
      baseUrl: "http://x",
      fetch: async () =>
        respond(
          409,
          {
            code: "CANOPY_CONFLICT",
            title: "Conflict",
            detail: "version 4 is published",
            details: { currentVersion: 4 },
          },
          "application/problem+json",
        ),
    })
    const error = await api.history("todos").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CanopyError)
    expect((error as CanopyError).code).toBe(ErrorCode.Conflict)
    expect((error as CanopyError).message).toBe("version 4 is published")
    expect((error as CanopyError).details).toEqual({ currentVersion: 4, status: 409 })
    expect(statusOf(error)).toBe(409)
  })

  it("maps a bare 404 to NotFound so screens can show that a feature is not available", async () => {
    const api = new AdminApi({
      baseUrl: "http://x",
      fetch: async () => respond(404, "Not found", "text/plain"),
    })
    const error = await api.users({}).catch((e: unknown) => e)
    expect(isNotFound(error)).toBe(true)
    expect((error as CanopyError).message).toBe("Not found")
  })

  it("rejects a response that breaks the contract instead of rendering garbage", async () => {
    const api = new AdminApi({
      baseUrl: "http://x",
      fetch: async () =>
        respond(200, { collections: [{ name: "todos", exposed: "yes", realtime: false }] }),
    })
    const error = await api.collections().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ContractError)
    expect((error as ContractError).path).toBe("collections[0].exposed")
  })

  it("calls onUnauthorized on 401 and keeps the error", async () => {
    let calls = 0
    const api = new AdminApi({
      baseUrl: "http://x",
      fetch: async () => respond(401, { code: "CANOPY_UNAUTHORIZED", detail: "Sign in" }),
      onUnauthorized: () => {
        calls += 1
      },
    })
    await expect(api.me()).rejects.toThrow("Sign in")
    expect(calls).toBe(1)
  })

  it("sends the CSRF token from the session on mutating requests only", async () => {
    const seen: { method: string; csrf: string | null }[] = []
    const mock = createMockAdmin({ admins: [OWNER] })
    const inner = cookieFetch(mock)
    const api = new AdminApi({
      baseUrl: "http://studio.test",
      cookies: () => "",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        seen.push({ method: init?.method ?? "GET", csrf: headers.get(CSRF_HEADER) })
        return inner(input, init)
      },
    })
    await api.login({ email: OWNER.email, password: OWNER.password })
    await api.collections()
    await api.updateCollection("todos", { exposed: true })
    expect(seen[0]).toEqual({ method: "POST", csrf: null })
    expect(seen[1]).toEqual({ method: "GET", csrf: null })
    expect(seen[2]?.csrf).toMatch(/^csrf_/)
    expect(mock.state.collections.get("todos")?.exposed).toBe(true)
  })

  it("falls back to the double submit cookie for the CSRF token", () => {
    const api = new AdminApi({ cookies: () => "theme=dark; __Host-canopy_csrf=abc%3D1; x=y" })
    expect(api.csrfToken()).toBe("abc=1")
  })

  it("is refused by the server without the CSRF token", async () => {
    const mock = createMockAdmin({ admins: [OWNER] })
    const fetch = cookieFetch(mock)
    const api = new AdminApi({ baseUrl: "http://studio.test", fetch, cookies: () => "" })
    await api.login({ email: OWNER.email, password: OWNER.password })
    const response = await fetch("http://studio.test/admin/v1/collections/todos", {
      method: "PATCH",
      body: JSON.stringify({ exposed: true }),
    })
    expect(response.status).toBe(403)
    expect(mock.state.collections.get("todos")?.exposed).toBe(false)
  })

  it("encodes document ids as canonical EJSON in the path", () => {
    expect(decodeURIComponent(encodeId({ $oid: "65f1a2b3c4d5e6f7a8b90001" }))).toBe(
      '{"$oid":"65f1a2b3c4d5e6f7a8b90001"}',
    )
    expect(encodeId("a/b")).toBe("%22a%2Fb%22")
  })
})
