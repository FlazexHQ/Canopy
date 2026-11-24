import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import { resolveConfig } from "@canopy/config"
import { expect, it, vi } from "vitest"
import { type GatewayOverrides, gatewayConfig, startGateway } from "../src/gateway.ts"
import { silentLogger } from "../src/logger.ts"

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn }))

function resolved(input: Record<string, unknown>) {
  return resolveConfig(
    { mongodb: { uri: "mongodb://db.example.test/app", database: "app" }, ...input },
    { env: {}, baseDir: process.cwd(), cwd: process.cwd(), command: "realtime" },
  ).config
}

interface Fixture {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly policies?: Parameters<typeof gatewayConfig>[1]
  readonly env?: NodeJS.ProcessEnv
  readonly overrides?: GatewayOverrides
}

const publicKey = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) }
const cases: readonly Fixture[] = [
  { name: "minimal", input: {} },
  {
    name: "external-auth",
    input: {
      mongodb: { uri: "mongodb://db.example.test/app", database: "app", metaDatabase: "meta" },
      auth: {
        kind: "external",
        issuer: "https://issuer.example.test",
        audience: "canopy-test",
        jwks: { keys: [{ ...publicKey, kid: "fixture" }] },
        algorithms: ["EdDSA"],
        rolesClaim: "app.roles",
        allowServiceRoleFromJwt: true,
        clockToleranceSeconds: 15,
      },
      keys: { publishable: ["fixture-public-key"], secret: ["fixture-secret-key"] },
      server: { metricsToken: "fixture-metrics-token", nodeId: "fixture-node" },
      log: { level: "debug" },
      rateLimits: false,
    },
    policies: { stored: [], contexts: {} },
  },
  {
    name: "view-tokens",
    input: {
      auth: { kind: "builtin", secret: "fixture-only".repeat(3), trustedProxies: ["fd00::/8"] },
      publicUrl: "https://api.example.test",
      server: { trustedProxies: ["10.0.0.0/8"] },
    },
    overrides: {
      auth: {
        issuer: "https://api.example.test/auth/v1",
        audience: "https://api.example.test",
        jwksUrl: "http://127.0.0.1:4000/auth/v1/jwks",
        algorithms: ["EdDSA"],
        rolesClaim: "roles",
      },
      viewTokenKey: publicKey,
    },
  },
  {
    name: "data-plane",
    input: {
      masterKey: "fixture-storage-master-key".repeat(2),
      storage: {
        backend: {
          kind: "s3",
          endpoint: "https://s3.example.test",
          region: "us-east-1",
          bucket: "canopy-fixture",
          accessKeyId: "fixture-access",
          secretAccessKey: "fixture-secret",
          sessionToken: "fixture-session",
          forcePathStyle: true,
          prefix: "fixtures/",
        },
        buckets: { files: { public: true, maxFileSize: 8192, allowedTypes: ["text/plain"] } },
        maxUploadSize: 16 * 1024 * 1024,
      },
      rest: { defaultLimit: 25, maxLimit: 250, maxBodyBytes: 4096 },
      graphql: {
        maxDepth: 4,
        maxComplexity: 500,
        maxAliases: 12,
        maxBatch: 3,
        introspection: "authenticated",
      },
      collections: {
        articles: {
          search: true,
          typeName: "Story",
          relations: { notes: { to: "notes", local: "_id", foreign: "articleId", many: true } },
        },
        notes: {},
        counters: { idType: "number" },
      },
      telemetry: { tracing: true },
      audit: { dataWrites: true },
    },
    overrides: {
      dataPlaneRoutes: [
        "find",
        "count",
        "distinct",
        "aggregate",
        "query",
        "explain",
        "writes",
        "graphql",
        "storage",
      ],
      wire: {
        port: 27018,
        host: "127.0.0.1",
        maxMessageBytes: 16000000,
        maxConnections: 32,
        idleTimeoutMs: 10000,
        tls: { certFile: "wire-cert.pem", keyFile: "wire-key.pem" },
      },
      graphqlPersisted: {
        only: true,
        operations: {
          "9b15636826a31db36e8b145188fb218e83cbd26047bd6cb851c018cbfb91c87b": "{ todosCount }",
        },
      },
    },
  },
  { name: "rest-disabled", input: { rest: false }, overrides: { wire: false } },
  {
    name: "fallback-transports",
    input: {
      cors: { origins: ["https://browser.example.test"] },
      realtime: {
        fullDocument: "images",
        checkpoints: "off",
        resumeWindow: "45s",
        drainWindow: "5s",
        transports: ["sse", "long-poll"],
      },
      rateLimits: {
        messages: { perSecond: 5, burst: 9 },
        requests: { perSecond: 7, burst: 11 },
        failedAuthentications: { perSecond: 2, burst: 4 },
        anonymousConnectionsPerAddress: 3,
        exemptService: false,
      },
    },
    env: {
      CANOPY_GATEWAY_COALESCE_MS: "17",
      CANOPY_GATEWAY_MUTATIONS_URL: "http://127.0.0.1:4000/rest/v1",
    },
    overrides: {
      port: 9000,
      metricsPort: 0,
      metricsHost: "0.0.0.0",
      proxyUrl: "http://127.0.0.1:4000",
    },
  },
]

it.each(cases)(
  "matches the Rust config fixture $name",
  ({ name, input, policies, env, overrides }) => {
    const fixture = new URL(
      `../../../crates/canopy-config/tests/fixtures/${name}.json`,
      import.meta.url,
    )
    const emitted = gatewayConfig(resolved(input), policies, env ?? {}, overrides)
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(JSON.parse(readFileSync(fixture, "utf8")))
  },
)

it.each([
  { frame: '{"t":"listening","wirePort":37018,"port":8000}\r\n', ports: [8000, 37018] },
  { frame: '{"t":"listening","port":8000}\n', ports: [8000, undefined] },
  { frame: undefined, ports: [undefined, undefined] },
])("reports listening ports $ports", async ({ frame, ports }) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  })
  spawn.mockReturnValueOnce(child)
  vi.stubEnv("CANOPYD_BIN", "fixture-gateway")
  try {
    const gateway = await startGateway(resolved({}), silentLogger, { host: "127.0.0.1" })
    expect(JSON.parse(String(child.stdin.read()))).toMatchObject({ server: { host: "127.0.0.1" } })
    if (frame !== undefined) {
      child.stdout.write(frame.slice(0, 23))
      child.stdout.write(frame.slice(23))
    }
    child.emit("exit", frame === undefined ? 1 : 0)
    await expect(Promise.all([gateway.listening, gateway.wireListening])).resolves.toEqual(ports)
  } finally {
    child.stdin.destroy()
    child.stdout.destroy()
    vi.unstubAllEnvs()
  }
})
