import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveConfig } from "@canopy/config"
import { describe, expect, it } from "vitest"
import { parse, parseAllDocuments } from "yaml"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n")

type Node = Record<string, unknown>

const at = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object"
        ? (current as Record<string | number, unknown>)[key]
        : undefined,
    value,
  )

const SECRET_VALUES = {
  MONGODB_URI: "mongodb://db.internal:27017/?replicaSet=rs0",
  CANOPY_MASTER_KEY: "bWFzdGVyLWtleS1mb3ItdGhlLW1hbmlmZXN0LXRlc3Q=",
  CANOPY_PUBLISHABLE_KEYS: "canopy_pk_0123456789abcdef0123456789abcdef",
  CANOPY_SECRET_KEYS: "canopy_sk_0123456789abcdef0123456789abcdef",
  CANOPY_METRICS_TOKEN: "0123456789abcdef0123456789abcdef",
}

function durationMs(text: string): number {
  const match = /^(\d+)s$/.exec(text)
  if (match?.[1] === undefined) throw new Error(`not a duration in seconds: ${text}`)
  return Number(match[1]) * 1000
}

describe("plain Kubernetes manifests", () => {
  const documents = parseAllDocuments(read("deploy/kubernetes/canopy.yaml")).map(
    (document) => document.toJS() as Node,
  )
  const ofKind = (kind: string) => documents.filter((document) => document["kind"] === kind)
  const deployment = ofKind("Deployment")[0]
  const container = at(deployment, "spec", "template", "spec", "containers", 0) as Node
  const env = Object.fromEntries(
    (container["env"] as { name: string; value?: string }[])
      .filter((entry) => entry.value !== undefined)
      .map((entry) => [entry.name, entry.value]),
  )

  it("probes readiness with /readyz and liveness with /healthz", () => {
    expect(at(container, "readinessProbe", "httpGet", "path")).toBe("/readyz")
    expect(at(container, "livenessProbe", "httpGet", "path")).toBe("/healthz")
    expect(at(container, "startupProbe", "httpGet", "path")).toBe("/healthz")
  })

  it("gives pods longer to stop than the drain window, and keeps one pod up during disruptions", () => {
    const grace = at(deployment, "spec", "template", "spec", "terminationGracePeriodSeconds")
    const drain = env["CANOPY_DRAIN_WINDOW"]
    expect(typeof drain).toBe("string")
    expect(Number(grace) * 1000).toBeGreaterThan(durationMs(String(drain)) + 5000)
    const budget = ofKind("PodDisruptionBudget")[0]
    expect(at(budget, "spec", "maxUnavailable")).toBe(1)
    expect(at(budget, "spec", "selector", "matchLabels")).toEqual(
      at(deployment, "spec", "selector", "matchLabels"),
    )
    expect(at(deployment, "spec", "strategy", "rollingUpdate", "maxUnavailable")).toBe(0)
  })

  it("has no keys of its own: they come from a secret, and the environment resolves for production", () => {
    for (const name of Object.keys(SECRET_VALUES)) expect(env[name]).toBeUndefined()
    expect(at(container, "envFrom", 0, "secretRef", "name")).toBe("canopy")
    const resolution = resolveConfig(
      {},
      {
        env: { ...env, ...SECRET_VALUES, CANOPY_NODE_ID: "canopy-7d9f-x2" },
        baseDir: root,
        cwd: root,
        command: "start",
      },
    )
    expect(resolution.config.environment).toBe("production")
    expect(
      resolution.config.realtime === false ? 0 : resolution.config.realtime.drainWindowMs,
    ).toBe(durationMs(String(env["CANOPY_DRAIN_WINDOW"])))
  })

  it("runs as a non root user with a read only root file system", () => {
    expect(at(deployment, "spec", "template", "spec", "securityContext", "runAsNonRoot")).toBe(true)
    expect(at(container, "securityContext", "readOnlyRootFilesystem")).toBe(true)
    expect(at(container, "securityContext", "allowPrivilegeEscalation")).toBe(false)
  })
})

describe("Helm chart", () => {
  const values = parse(read("deploy/helm/canopy/values.yaml")) as Node
  const templates = join(root, "deploy/helm/canopy/templates")

  it("only reads values that values.yaml defines", () => {
    const used = new Set<string>()
    for (const file of readdirSync(templates)) {
      const text = readFileSync(join(templates, file), "utf8")
      for (const match of text.matchAll(/\.Values((?:\.[A-Za-z]\w*)+)/g))
        used.add((match[1] ?? "").slice(1))
    }
    expect(used.size).toBeGreaterThan(10)
    const missing = [...used].filter((path) => at(values, ...path.split(".")) === undefined)
    expect(missing).toEqual([])
  })

  it("defaults to production without keys of its own", () => {
    expect(values["environment"]).toBe("production")
    expect(values["existingSecret"]).toBe("canopy")
    expect(JSON.stringify(values)).not.toMatch(/canopy_(?:pk|sk)_|pk_dev|sk_dev/)
  })
})

/** A compose file with its YAML anchors and merge keys applied, as `docker compose` reads it. */
function compose(path: string): { readonly text: string; readonly services: Record<string, Node> } {
  const text = read(path)
  const services = at(parse(text, { merge: true }), "services") as Record<string, Node>
  return { text, services }
}

const environmentOf = (service: Node): Record<string, string> =>
  (service["environment"] ?? {}) as Record<string, string>

/** The host side of each published port: `127.0.0.1` for loopback only, otherwise every interface. */
function published(service: Node): { readonly loopback: boolean; readonly spec: string }[] {
  const ports = (service["ports"] ?? []) as string[]
  return ports.map((spec) => ({ spec, loopback: spec.startsWith("127.0.0.1:") }))
}

const STACK_SERVICES = ["api", "realtime", "studio", "edge"]

for (const [file, extra] of [
  ["deploy/compose/canopy.yaml", ["database"]],
  ["deploy/compose/production.yaml", []],
] as const) {
  describe(`${file} as separate services`, () => {
    const { services } = compose(file)

    it("runs api, realtime, studio and edge as their own containers, each restarting on its own", () => {
      expect(Object.keys(services).sort()).toEqual([...STACK_SERVICES, ...extra].sort())
      for (const name of Object.keys(services))
        expect(services[name]?.["restart"], `${name} restart policy`).toBe("unless-stopped")
    })

    it("runs the server image once per role, with distinct node ids for leases", () => {
      const api = environmentOf(services["api"] ?? {})
      const realtime = environmentOf(services["realtime"] ?? {})
      expect(api["CANOPY_ROLE"]).toBe("api")
      expect(realtime["CANOPY_ROLE"]).toBe("realtime")
      expect(api["CANOPY_NODE_ID"]).toBeDefined()
      expect(realtime["CANOPY_NODE_ID"]).toBeDefined()
      expect(api["CANOPY_NODE_ID"]).not.toBe(realtime["CANOPY_NODE_ID"])
      expect(api["CANOPY_REALTIME_URL"]).toBe("http://realtime:8080")
      expect(services["api"]?.["image"]).toBe(services["realtime"]?.["image"])
    })

    it("health checks every service but the edge waits on none of them", () => {
      for (const name of ["api", "realtime", "studio", ...extra])
        expect(services[name]?.["healthcheck"], `${name} health check`).toBeDefined()
      expect(services["edge"]?.["depends_on"]).toBeUndefined()
    })

    it("lets realtime and api fail independently: neither depends on the other or on studio", () => {
      for (const name of ["api", "realtime"]) {
        const dependsOn = Object.keys((services[name]?.["depends_on"] ?? {}) as Node)
        expect(dependsOn.filter((other) => STACK_SERVICES.includes(other))).toEqual([])
      }
    })

    it("publishes only the edge to the network; metrics stay on the host loopback", () => {
      for (const name of ["api", "realtime", "studio", ...extra])
        for (const port of published(services[name] ?? {}))
          expect(port.loopback, `${name} publishes ${port.spec}`).toBe(true)
      expect(published(services["edge"] ?? {}).some((port) => !port.loopback)).toBe(true)
      const metrics = ["api", "realtime"].flatMap((name) =>
        published(services[name] ?? {}).map((port) => port.spec.split(":")[1]),
      )
      expect(new Set(metrics).size).toBe(metrics.length)
    })

    it("trusts forwarded addresses from the edge alone", () => {
      const edge = services["edge"] ?? {}
      const address = at(edge, "networks", "default", "ipv4_address")
      expect(typeof address).toBe("string")
      for (const name of ["api", "realtime"])
        expect(environmentOf(services[name] ?? {})["CANOPY_TRUSTED_PROXIES"]).toBe(address)
    })

    it("stops the realtime service slower than it drains its connections", () => {
      const realtime = services["realtime"] ?? {}
      const drain = environmentOf(realtime)["CANOPY_DRAIN_WINDOW"]
      expect(drain).toBeDefined()
      expect(durationMs(String(realtime["stop_grace_period"]))).toBeGreaterThan(
        durationMs(String(drain)),
      )
    })
  })
}

describe("production compose file", () => {
  const { text, services } = compose("deploy/compose/production.yaml")

  it("refuses to start api or realtime without each secret instead of falling back to a default", () => {
    for (const name of ["api", "realtime"]) {
      const environment = environmentOf(services[name] ?? {})
      for (const secret of Object.keys(SECRET_VALUES))
        expect(environment[secret], `${name} ${secret}`).toMatch(new RegExp(`^\\$\\{${secret}:\\?`))
      expect(environment["CANOPY_ENV"]).toBe("production")
    }
    expect(text).not.toMatch(/pk_dev|sk_dev/)
  })

  it("runs every Canopy container read only, without capabilities", () => {
    for (const name of ["api", "realtime", "studio"]) {
      const service = services[name] ?? {}
      expect(service["read_only"], name).toBe(true)
      expect(service["cap_drop"], name).toEqual(["ALL"])
    }
  })

  it("resolves for production from the environment the api service is given", () => {
    const secrets: Readonly<Record<string, string>> = SECRET_VALUES
    const interpolate = (value: string): string | undefined => {
      const reference = /^\$\{(\w+)(:-|:\?)(.*)\}$/.exec(value)
      if (reference === null) return value
      const [, name = "", kind] = reference
      return kind === ":-" ? reference[3] : secrets[name]
    }
    const environment = Object.fromEntries(
      Object.entries(environmentOf(services["api"] ?? {})).map(([name, value]) => [
        name,
        interpolate(value),
      ]),
    )
    const resolution = resolveConfig(
      {},
      {
        env: environment,
        baseDir: root,
        cwd: root,
        command: "start",
      },
    )
    expect(resolution.config.environment).toBe("production")
    expect(resolution.config.server.nodeId).toBe("api-1")
    expect(resolution.config.mongodb.database).toBe("app")
    expect(resolution.config.server.trustedProxies).toEqual(["172.29.0.10"])
  })
})

describe("edge routes", () => {
  const caddyfile = read("deploy/compose/edge/Caddyfile")

  /** The upstream of the `handle` block that matches `matcher` (a named matcher or a path). */
  function upstream(matcher: string): string | undefined {
    const block = caddyfile
      .split(/\n\t(?=handle)/)
      .find((part) => part.startsWith(`handle ${matcher} {`))
    return /reverse_proxy (\S+)/.exec(block ?? "")?.[1]
  }

  it("sends realtime transports to realtime, Studio to studio and everything else to api", () => {
    expect(caddyfile).toMatch(/@realtime path \/realtime\/v1 \/realtime\/v1\/\*/)
    expect(caddyfile).toMatch(/@studio path \/studio \/studio\/\*/)
    expect(upstream("@realtime")).toBe("realtime:8080")
    expect(upstream("@studio")).toBe("studio:8080")
    expect(/\thandle \{\n\t\treverse_proxy (\S+)/.exec(caddyfile)?.[1]).toBe("api:8080")
  })

  it("answers a down service with a Problem Details 503 using the stable unavailable code", () => {
    const errors = /handle_errors 502 503 504 \{([\s\S]*?)\n\t\}/.exec(caddyfile)?.[1] ?? ""
    expect(errors).toContain('header Content-Type "application/problem+json"')
    const body = /respond `(.*)` 503/.exec(errors)?.[1] ?? ""
    const problem = JSON.parse(body) as Record<string, unknown>
    expect(problem["code"]).toBe("CANOPY_UNAVAILABLE")
    expect(problem["status"]).toBe(503)
    expect(problem["type"]).toBe("urn:canopy:error:unavailable")
  })

  it("streams realtime and API responses without buffering", () => {
    const realtime = caddyfile
      .split(/\n\t(?=handle)/)
      .find((part) => part.startsWith("handle @realtime {"))
    expect(realtime).toContain("flush_interval -1")
    const api = /\thandle \{\n([\s\S]*?)\n\t\}/.exec(caddyfile)?.[1] ?? ""
    expect(api).toContain("reverse_proxy api:8080")
    expect(api).toContain("flush_interval -1")
  })
})

describe("split deployment", () => {
  it("runs Rust control and Rust auth independently of data in Compose", () => {
    const { services } = compose("deploy/compose/split.yaml")
    const data = services["data"] ?? {}
    const control = services["control"] ?? {}
    const auth = services["auth"] ?? {}
    expect(data["image"]).toBe(control["image"])
    expect(environmentOf(control)["CANOPY_ROLE"]).toBe("control")
    expect(environmentOf(control)["CANOPY_REALTIME_INTERNAL_URL"]).toBe("http://data:8080")
    expect(environmentOf(control)["CANOPY_MASTER_KEY"]).toBe(
      environmentOf(data)["CANOPY_MASTER_KEY"],
    )
    expect(auth["image"]).toBe(data["image"])
    expect(environmentOf(auth)["CANOPY_ROLE"]).toBe("control")
    expect(environmentOf(auth)["CANOPY_AUTH_ENGINE"]).toBe("rust")
    expect(environmentOf(auth)["CANOPY_SPLIT_AUTH_ONLY"]).toBeUndefined()
    expect(environmentOf(auth)["CANOPY_POLICY_BUNDLE"]).toBeUndefined()
    expect(environmentOf(auth)["CANOPY_MASTER_KEY"]).toBe(environmentOf(data)["CANOPY_MASTER_KEY"])
    expect(auth["command"]).toEqual(["--config", "/app/auth.json"])
    expect(auth["volumes"]).toEqual([
      expect.stringMatching(
        /^\$\{CANOPY_AUTH_CONFIG:-\.\/split-gateway\.json\}:\/app\/auth\.json:ro$/,
      ),
    ])
    for (const service of [data, control, auth])
      expect(Object.keys((service["depends_on"] ?? {}) as Node)).toEqual(["database"])
    expect(services["edge"]?.["depends_on"]).toBeUndefined()
  })

  it("gives the auth service a built in auth config in the auth overlay", () => {
    const { services } = compose("deploy/compose/split-auth.yaml")
    expect(services["auth"]?.["volumes"]).toEqual([
      expect.stringMatching(
        /^\$\{CANOPY_AUTH_CONFIG:-\.\/split-auth\.json\}:\/app\/auth\.json:ro$/,
      ),
    ])
    const config = JSON.parse(read("deploy/compose/split-auth.json")) as Node
    expect(at(config, "auth", "kind")).toBe("builtin")
    expect(at(config, "auth", "claims")).toBeUndefined()
  })

  it("relays the SDK auth claims hook on the auth service's own loopback address", () => {
    const { services } = compose("deploy/compose/split-e2e.yaml")
    const relay = services["claims-relay"] ?? {}
    expect(relay["network_mode"]).toBe("service:auth")
    const config = JSON.parse(read("deploy/compose/split-e2e-auth.json")) as Node
    const hook = new URL(String(at(config, "auth", "claims", "url")))
    expect(hook.protocol).toBe("http:")
    expect(hook.hostname).toBe("127.0.0.1")
    const command = relay["command"] as string[]
    expect(command[command.indexOf("--from") + 1]).toBe(`:${hook.port}`)
    expect(command[command.indexOf("--to") + 1]).toBe(`host.docker.internal:${hook.port}`)
    const secret = at(config, "auth", "claims", "secret", "$env", "name")
    expect(environmentOf(services["auth"] ?? {})).toHaveProperty(String(secret))
  })

  it("keeps the TypeScript auth service as an opt in overlay", () => {
    const { services } = compose("deploy/compose/split-auth-typescript.yaml")
    const auth = services["auth"] ?? {}
    expect(auth["image"]).toContain("canopy-control")
    expect(environmentOf(auth)["CANOPY_SPLIT_AUTH_ONLY"]).toBe("on")
    expect(auth["command"]).toEqual(["--config", "/app/canopy.config.ts"])
  })

  it("runs Rust auth on the canopy image in the Kubernetes manifest and the Helm chart", () => {
    const documents = parseAllDocuments(read("deploy/kubernetes/split.yaml")).map(
      (document) => document.toJS() as Node,
    )
    const deployment = (name: string) =>
      documents.find(
        (document) =>
          document["kind"] === "Deployment" && at(document, "metadata", "name") === name,
      )
    const container = (name: string) =>
      at(deployment(name), "spec", "template", "spec", "containers", 0) as Node
    const auth = container("canopy-auth")
    expect(auth["image"]).toBe(container("canopy-control")["image"])
    const env = Object.fromEntries(
      (auth["env"] as { name: string; value?: string }[]).map((entry) => [entry.name, entry.value]),
    )
    expect(env["CANOPY_ROLE"]).toBe("control")
    expect(env["CANOPY_AUTH_ENGINE"]).toBe("rust")
    expect(auth["args"]).toEqual(["--config", "/app/auth.json"])
    expect(auth["volumeMounts"]).toContainEqual({
      name: "settings",
      mountPath: "/app/auth.json",
      subPath: "auth.json",
      readOnly: true,
    })
    const settings = documents.find(
      (document) =>
        document["kind"] === "ConfigMap" && at(document, "metadata", "name") === "canopy-split",
    )
    expect(JSON.parse(String(at(settings, "data", "auth.json")))).toBeTypeOf("object")
    expect(read("deploy/kubernetes/split.yaml")).not.toContain(`image: "canopy-control`)
    const helm = read("deploy/helm/canopy/templates/split.yaml")
    expect(helm).not.toContain("CANOPY_SPLIT_AUTH_ONLY")
    expect(helm).toMatch(/name: CANOPY_AUTH_ENGINE\n\s+value: rust/)
    expect(helm).not.toContain("canopy.config.ts")
    const values = parse(read("deploy/helm/canopy/values.yaml")) as Node
    expect(at(values, "split", "auth", "image")).toBeUndefined()
    expect(at(values, "split", "auth", "settings")).toEqual({})
  })

  it("handles auth and private paths before forwarding requests to control or data", () => {
    const caddyfile = read("deploy/helm/canopy/files/Caddyfile.split")
    expect(caddyfile).toContain(
      "@auth path /auth/v1 /auth/v1/* /.well-known/jwks.json /admin/v1/users /admin/v1/users/*",
    )
    expect(caddyfile).toContain(
      "handle @auth {\n\t\treverse_proxy {$CANOPY_AUTH_UPSTREAM:auth:8080}",
    )
    expect(caddyfile).toContain("@control path /admin/v1 /admin/v1/*")
    expect(caddyfile.indexOf("handle @auth")).toBeLessThan(caddyfile.indexOf("handle @control"))
    expect(caddyfile).toContain("@internal path /internal /internal/*")
    expect(caddyfile).toContain('handle @internal {\n\t\trespond "Not found" 404')
    expect(caddyfile).toContain("handle {\n\t\treverse_proxy {$CANOPY_DATA_UPSTREAM:data:8080}")
  })
})
