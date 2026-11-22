import { ConfigError, isResolvedConfig, type ResolvedConfig, resolveConfig } from "@canopy/config"
import { describe, expect, it } from "vitest"
import { parseServerRole, planServerRole } from "../src/roles.ts"

function resolved(input: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig(
    {
      mongodb: { uri: "mongodb://localhost:27017/?replicaSet=rs0", database: "app" },
      webhooks: {
        secret: "roleTestSecret0123456789",
        triggers: {
          created: {
            collection: "orders",
            operations: ["insert"],
            url: "http://hooks.test/created",
          },
        },
        schedules: { nightly: { cron: "0 3 * * *", url: "http://hooks.test/nightly" } },
      },
      masterKey: "cm9sZS10ZXN0LW1hc3Rlci1rZXktMDEyMzQ1Njc4OWFi",
      storage: { backend: { kind: "local", root: "./files" }, buckets: { avatars: {} } },
      ...input,
    },
    { env: {}, baseDir: ".", cwd: ".", command: "start" },
  ).config
}

describe("parseServerRole", () => {
  it("runs everything when CANOPY_ROLE is unset or blank", () => {
    expect(parseServerRole(undefined)).toBe("all")
    expect(parseServerRole("")).toBe("all")
    expect(parseServerRole("  ")).toBe("all")
  })

  it("accepts each role, ignoring surrounding whitespace", () => {
    expect(parseServerRole("all")).toBe("all")
    expect(parseServerRole("api")).toBe("api")
    expect(parseServerRole(" realtime\n")).toBe("realtime")
  })

  it("refuses unknown roles and other casings with a config error naming the variable", () => {
    for (const value of ["studio", "edge", "API", "Realtime", "api,realtime"]) {
      let thrown: unknown
      try {
        parseServerRole(value)
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ConfigError)
      expect((thrown as ConfigError).problems.map((problem) => problem.path)).toEqual([
        "CANOPY_ROLE",
      ])
      expect((thrown as ConfigError).message).toContain(JSON.stringify(value))
    }
  })
})

describe("planServerRole", () => {
  it("leaves the config untouched for the all role", () => {
    const config = resolved()
    const plan = planServerRole(config, "all", "http://realtime:8080")
    expect(plan.config).toBe(config)
    expect(plan.options).toEqual({})
  })

  it("turns realtime and Studio off for the api role and keeps webhooks there", () => {
    const config = resolved()
    expect(config.realtime).not.toBe(false)
    const plan = planServerRole(config, "api", "http://realtime:8080")
    expect(plan.config.realtime).toBe(false)
    expect(isResolvedConfig(plan.config)).toBe(true)
    expect(plan.config.rest).toEqual(config.rest)
    expect(plan.config.graphql).toEqual(config.graphql)
    expect(plan.config.storage).not.toBe(false)
    expect(plan.config.storage).toEqual(config.storage)
    expect(Object.keys(plan.config.webhooks.triggers)).toEqual(["created"])
    expect(Object.keys(plan.config.webhooks.schedules)).toEqual(["nightly"])
    expect(plan.options.studio).toBe(false)
    expect(plan.options.admin).toBeUndefined()
    expect(plan.options.realtimeUrl?.()).toBe("http://realtime:8080")
    expect(config.realtime).not.toBe(false)
  })

  it("gives the api role no realtime URL when none or an empty one is set", () => {
    expect(planServerRole(resolved(), "api").options.realtimeUrl).toBeUndefined()
    expect(planServerRole(resolved(), "api", "").options.realtimeUrl).toBeUndefined()
  })

  it("keeps realtime and the write path for the realtime role, without admin, Studio, storage or webhooks", () => {
    const config = resolved()
    const plan = planServerRole(config, "realtime", "http://ignored:8080")
    expect(plan.config.realtime).toEqual(config.realtime)
    expect(isResolvedConfig(plan.config)).toBe(true)
    expect(plan.config.rest).toEqual(config.rest)
    expect(plan.config.webhooks.triggers).toEqual({})
    expect(plan.config.webhooks.schedules).toEqual({})
    expect(plan.config.webhooks.secret).toBe(config.webhooks.secret)
    expect(plan.config.storage).toBe(false)
    expect(plan.options.admin).toBe(false)
    expect(plan.options.studio).toBe(false)
    expect(Object.keys(config.webhooks.triggers)).toEqual(["created"])
  })

  it("refuses the realtime role when the config turns realtime off", () => {
    expect(() => planServerRole(resolved({ realtime: false }), "realtime")).toThrow(ConfigError)
  })

  it.each([
    ["/realtime/v1", false, true],
    ["/realtime/v1/sse", false, true],
    ["/realtime/v1/poll", false, true],
    ["/realtime/v10", true, false],
    ["/studio", false, false],
    ["/studio/assets/app.js", false, false],
    ["/studiox", true, false],
    ["/rest/v1/notes", true, false],
    ["/graphql", true, false],
    ["/graphql/v1", true, false],
    ["/auth/v1/session", true, false],
    ["/.well-known/jwks.json", true, false],
    ["/healthz", true, true],
    ["/readyz", true, true],
    ["/readyz/details", true, false],
  ])("limits %s by role", (path, api, realtime) => {
    const config = resolved()
    expect(planServerRole(config, "all").options.serves).toBeUndefined()
    expect(planServerRole(config, "api").options.serves?.(path)).toBe(api)
    expect(planServerRole(config, "realtime").options.serves?.(path)).toBe(realtime)
  })
})
