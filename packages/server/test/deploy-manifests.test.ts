import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveConfig } from "@canopy/config"
import { describe, expect, it } from "vitest"
import { parse, parseAllDocuments } from "yaml"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), "utf8")

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

describe("production compose file", () => {
  const text = read("deploy/compose/production.yaml")
  const service = at(parse(text), "services", "canopy") as Node
  const environment = service["environment"] as Record<string, string>

  it("refuses to start without each secret instead of falling back to a default", () => {
    for (const name of Object.keys(SECRET_VALUES))
      expect(environment[name]).toMatch(new RegExp(`^\\$\\{${name}:\\?`))
    expect(environment["CANOPY_ENV"]).toBe("production")
    expect(text).not.toMatch(/pk_dev|sk_dev/)
  })

  it("publishes metrics on the host loopback only, and stops slower than it drains", () => {
    expect(service["ports"]).toContain("127.0.0.1:9464:9464")
    expect(durationMs(String(service["stop_grace_period"]))).toBeGreaterThan(
      durationMs(String(environment["CANOPY_DRAIN_WINDOW"])),
    )
  })
})

describe("development compose file", () => {
  it("publishes metrics on the host loopback only", () => {
    const service = at(parse(read("deploy/compose/canopy.yaml")), "services", "canopy") as Node
    expect(service["ports"]).toContain("127.0.0.1:${CANOPY_METRICS_PORT:-9464}:9464")
  })
})
