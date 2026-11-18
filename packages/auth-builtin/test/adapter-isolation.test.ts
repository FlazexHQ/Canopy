import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context"
import { afterAll, beforeAll, expect, it } from "vitest"
import { describeMongo, type Harness, signUpVerified, startAuth } from "./support.ts"

/**
 * A Better Auth adapter store whose adapter fails on any use. Deno can leave a store like this current
 * after an unrelated operation, holding another instance's adapter.
 */
function foreignStore(): unknown {
  const adapter = new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === "then") return undefined
        throw new Error(`the foreign adapter was used (${String(key)})`)
      },
    },
  )
  return { adapter, pendingHooks: [], isTransactionActive: false }
}

describeMongo("Better Auth adapter context", () => {
  let h: Harness

  beforeAll(async () => {
    h = await startAuth()
  })
  afterAll(async () => {
    await h?.close()
  })

  it("reads sessions and users through its own database when another adapter is current", async () => {
    const client = h.client()
    await signUpVerified(h, client, "iso@example.com", "isolation password")
    const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    const storage = await getCurrentDBAdapterAsyncLocalStorage()
    await storage.run(foreignStore() as never, async () => {
      const response = await h.auth.handler(
        new Request(`${h.url}/auth/v1/token`, { headers: { cookie } }),
        { clientAddress: client.ip },
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { access_token?: unknown }
      expect(typeof body.access_token).toBe("string")
      const page = await h.auth.users.list()
      expect(page.users.map((user) => user.email)).toContain("iso@example.com")
    })
  })
})
