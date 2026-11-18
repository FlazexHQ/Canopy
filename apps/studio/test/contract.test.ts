// @vitest-environment node
import type { ResolvedConfig } from "@canopy/server"
import { createAdminApi } from "@canopy/server"
import { MongoClient } from "mongodb"
import { afterAll, describe, expect, it } from "vitest"
import { createMockAdmin } from "../mock/admin.ts"

/**
 * Server routes Studio has no screen for yet, so the mock does not serve them. Studio's tests fail when Studio
 * calls a route the mock lacks (see `test/setup.ts`), so a route listed here is one Studio never calls.
 */
const NOT_IN_MOCK = [
  "GET tokens",
  "POST tokens",
  "DELETE tokens/:",
  "GET collections/:/documents/:",
  "GET policies",
  "POST policies/:/explain",
  "GET contexts",
  "POST contexts/validate",
  "POST contexts/publish",
  "GET contexts/history",
  "POST contexts/rollback",
  "POST users/import",
  "GET webhooks",
  "GET webhooks/dead-letters",
  "POST webhooks/dead-letters/:/retry",
  "DELETE webhooks/dead-letters/:",
  "POST webhooks/:/run",
]

const shape = (route: string): string =>
  route.replace(/(^|\/):[A-Za-z]+/g, (_match, slash: string) => `${slash}:`)

function serverRoutes(client: MongoClient): string[] {
  const config = {
    environment: "development",
    mongodb: {
      uri: "mongodb://127.0.0.1:9",
      database: "app",
      metaDatabase: "canopy",
      authDatabase: "canopy_auth",
    },
    publicUrl: undefined,
    masterKey: undefined,
    previousMasterKeys: [],
    auth: undefined,
    keys: { publishable: [], secret: [] },
    collections: {},
  } as unknown as ResolvedConfig
  const unused = {} as never
  const api = createAdminApi({
    config,
    client,
    accounts: unused,
    audit: unused,
    policies: unused,
    keys: unused,
    settings: unused,
    tokens: unused,
    engine: () => unused,
    contexts: unused,
    writes: unused,
    realtime: undefined,
    logger: unused,
  })
  return api.routes.map(shape)
}

describe("the admin API contract between Studio and the server", () => {
  const client = new MongoClient("mongodb://127.0.0.1:9")
  afterAll(() => client.close())

  it("serves every route of the mock on the server", () => {
    const server = new Set(serverRoutes(client))
    const mock = createMockAdmin()
    try {
      const missing = mock.routes.map(shape).filter((route) => !server.has(route))
      expect(missing).toEqual([])
    } finally {
      mock.close()
    }
  })

  it("lists exactly the server routes the mock does not serve", () => {
    const mock = createMockAdmin()
    try {
      const served = new Set(mock.routes.map(shape))
      const lacking = serverRoutes(client).filter((route) => !served.has(route))
      expect(lacking.sort()).toEqual([...NOT_IN_MOCK].sort())
    } finally {
      mock.close()
    }
  })
})
