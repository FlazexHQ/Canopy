import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { findGatewayBinary } from "@canopy/realtime"
import { MONGODB_URI, TEST_ENGINE, TEST_ENV } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

const BIN = fileURLToPath(new URL("../src/bin/canopy-server.ts", import.meta.url))
const POLICIES = fileURLToPath(new URL("./fixtures/policies", import.meta.url))
const PACKAGE = fileURLToPath(new URL("..", import.meta.url))
const ISSUER = "https://idp.bin.test/"
const AUDIENCE = "https://api.bin.test"
const KEY = "pk_bin_test"

/** Variables of the test process that would leak into the server's config. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("CANOPY_") && !["MONGODB_URI", "PORT", "METRICS_PORT"].includes(name),
  ),
)

interface Running {
  readonly child: ChildProcess
  readonly exited: Promise<number | null>
  output(): string
}

function start(args: readonly string[], env: Record<string, string>, cwd?: string): Running {
  const child = spawn(process.execPath, ["--conditions=@canopy/source", BIN, ...args], {
    cwd: cwd ?? process.cwd(),
    env: { ...CLEAN_ENV, ...TEST_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  )
  return { child, exited, output: () => output }
}

/** How a test asks the server to stop. Windows has no SIGTERM, only the IPC message. */
type Shutdown = "SIGTERM" | "shutdown"
const SHUTDOWNS: readonly Shutdown[] =
  process.platform === "win32" ? ["shutdown"] : ["SIGTERM", "shutdown"]

function requestShutdown(run: Running, how: Shutdown = SHUTDOWNS[0] ?? "shutdown"): void {
  if (how === "SIGTERM") run.child.kill("SIGTERM")
  else run.child.send("shutdown")
}

function boundPorts(output: string): { port: number; metricsPort: number } | undefined {
  const line = output.split(/\r?\n/).find((line) => line.includes('"msg":"canopy listening"'))
  if (line === undefined) return undefined
  try {
    const { port, metricsPort } = JSON.parse(line) as { port?: unknown; metricsPort?: unknown }
    if (typeof port === "number" && port > 0 && typeof metricsPort === "number" && metricsPort > 0)
      return { port, metricsPort }
  } catch {
    return undefined
  }
  return undefined
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

describe("canopy-server: argument and config errors", { timeout: 45_000 }, () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-server-config-"))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("exits 1 and lists every problem of the environment at once", async () => {
    const run = start([], { MONGODB_URI: "http://localhost:27017", PORT: "99999" }, dir)
    expect(await within(run.exited, 20_000, "exit")).toBe(1)
    const output = run.output()
    expect(output).toContain("canopy: the environment has")
    expect(output).toContain("mongodb.uri")
    expect(output).toContain('Expected a connection string starting with "mongodb://"')
    expect(output).toContain("server.port")
    expect(output).toContain("Expected a port between 0 and 65535")
    expect(output).not.toContain("canopy listening")
  })

  it("names the config file and suggests the setting a typo meant", async () => {
    const file = join(dir, "canopy.config.mjs")
    await writeFile(
      file,
      `export default { mongodb: { uri: "mongodb://localhost:27017/?replicaSet=rs0", database: "app" }, servr: {} }\n`,
    )
    const run = start(["--config", file], {}, dir)
    expect(await within(run.exited, 20_000, "exit")).toBe(1)
    expect(run.output()).toContain(`canopy: ${file} has 1 problem`)
    expect(run.output()).toContain("servr")
    expect(run.output()).toContain("server")
  })

  it("refuses unknown options and a --config without a file", async () => {
    const unknown = start(["--prot", "80"], {}, dir)
    expect(await within(unknown.exited, 20_000, "exit")).toBe(1)
    expect(unknown.output()).toContain("Unknown option --prot")
    expect(unknown.output()).toContain("Usage: canopy-server")
    const missing = start(["--config"], {}, dir)
    expect(await within(missing.exited, 20_000, "exit")).toBe(1)
    expect(missing.output()).toContain("--config needs a file")
  })

  it("prints the usage with --help and exits 0", async () => {
    const run = start(["--help"], {}, dir)
    expect(await within(run.exited, 20_000, "exit")).toBe(0)
    expect(run.output()).toContain("Usage: canopy-server [--config <file>]")
  })
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("canopy-server against MongoDB", { timeout: 60_000 }, () => {
  const id = `${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const database = `canopy_bin_${id}`
  const metaDatabase = `canopy_bin_${id}_meta`
  let mongo: MongoClient
  let dir: string
  let config: string
  let sign: (sub: string) => Promise<string>

  const boot = async (
    policies = POLICIES,
    extra: Record<string, string> = {},
  ): Promise<{ run: Running; base: string; metrics: string }> => {
    const run = start(["--config", config], {
      ...extra,
      MONGODB_URI: MONGODB_URI ?? "",
      CANOPY_DB: database,
      CANOPY_META_DB: metaDatabase,
      CANOPY_POLICIES: policies,
      CANOPY_PUBLISHABLE_KEYS: KEY,
      CANOPY_CHECKPOINTS: "off",
      CANOPY_DRAIN_WINDOW: "5s",
      CANOPY_LOG_LEVEL: "info",
      PORT: "0",
      METRICS_PORT: "0",
    })
    const started = Date.now()
    for (;;) {
      if (run.child.exitCode !== null)
        throw new Error(`canopy-server exited early:\n${run.output()}`)
      const ports = boundPorts(run.output())
      if (ports !== undefined) {
        const base = `http://127.0.0.1:${ports.port}`
        const ready = await fetch(`${base}/readyz`).then(
          (response) => response.status === 200,
          () => false,
        )
        if (ready) return { run, base, metrics: `http://127.0.0.1:${ports.metricsPort}/metrics` }
      }
      if (Date.now() - started > 30_000) {
        run.child.kill()
        throw new Error(`canopy-server did not become ready:\n${run.output()}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  const stop = async (run: Running): Promise<number | null> => {
    if (run.child.exitCode !== null) return run.child.exitCode
    requestShutdown(run)
    return within(run.exited, 20_000, "canopy-server to stop")
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    sign = (sub) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
    dir = await mkdtemp(join(tmpdir(), "canopy-server-"))
    config = join(dir, "canopy.config.mjs")
    const auth = { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE }
    await writeFile(config, `export default ${JSON.stringify({ auth })}\n`)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    await mongo.db(database).dropDatabase()
    await mongo.db(metaDatabase).dropDatabase()
    await mongo.close()
  })

  it("serves health, readiness, metrics, REST and a WebSocket subscription on one port", async () => {
    const { run, base, metrics } = await boot()
    try {
      expect(run.output()).toContain('"msg":"canopy listening"')
      expect(run.output()).toContain(`"engine":"${TEST_ENGINE}"`)
      const healthz = await fetch(`${base}/healthz`)
      expect(healthz.status).toBe(200)
      expect(await healthz.text()).toBe("ok")
      expect(await (await fetch(`${base}/readyz`)).text()).toBe("ready")
      expect((await fetch(`${base}/nowhere`)).status).toBe(404)

      const headers = async (sub: string) => ({
        apikey: KEY,
        authorization: `Bearer ${await sign(sub)}`,
        "content-type": "application/json",
      })
      const token = await sign("alice")
      const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
      const messages: Record<string, unknown>[] = []
      socket.on("message", (data) =>
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
      )
      const waitFor = async (test: (m: Record<string, unknown>) => boolean) => {
        const started = Date.now()
        for (;;) {
          const found = messages.find(test)
          if (found !== undefined) return found
          if (Date.now() - started > 10_000)
            throw new Error(`timed out: ${JSON.stringify(messages)}`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve())
        socket.once("error", reject)
      })
      socket.send(JSON.stringify({ t: "hello", v: 1, key: KEY, token }))
      await waitFor((m) => m["t"] === "welcome")
      socket.send(JSON.stringify({ t: "sub", id: "s", c: "notes", q: {} }))
      await waitFor((m) => m["t"] === "ready")

      const created = await fetch(`${base}/rest/v1/notes`, {
        method: "POST",
        headers: await headers("alice"),
        body: JSON.stringify({ _id: "n1", ownerId: "alice", text: "hi" }),
      })
      expect(created.status).toBe(201)
      const forbidden = await fetch(`${base}/rest/v1/notes`, {
        method: "POST",
        headers: await headers("bob"),
        body: JSON.stringify({ _id: "n2", ownerId: "alice" }),
      })
      expect(forbidden.status).toBe(403)

      const added = await waitFor((m) => m["t"] === "added")
      expect(added).toMatchObject({ id: "n1" })
      expect(messages.filter((m) => m["t"] === "added")).toHaveLength(1)

      const list = async (sub: string) => {
        const response = await fetch(`${base}/rest/v1/notes`, { headers: await headers(sub) })
        expect(response.status).toBe(200)
        return ((await response.json()) as { data: { _id: string }[] }).data.map((d) => d._id)
      }
      expect(await list("alice")).toEqual(["n1"])
      expect(await list("bob")).toEqual([])

      const scraped = await fetch(metrics)
      expect(scraped.status).toBe(200)
      const text = await scraped.text()
      expect(text).toMatch(/canopy_build_info\{runtime="(node|bun)",node_id="n1"\} 1/)
      expect(text).toMatch(/canopy_realtime_connections\S* 1\b/)
      expect((await fetch(metrics.replace("/metrics", "/other"))).status).toBe(404)
      socket.close()
    } finally {
      expect(await stop(run)).toBe(0)
    }
  })

  it.skipIf(findGatewayBinary() === undefined)(
    "runs canopy-gateway on the public port in front of REST, with socket writes acknowledged after their echo",
    async () => {
      const { run, base } = await boot(POLICIES, { CANOPY_REALTIME_SERVER: "gateway" })
      try {
        expect(run.output()).toContain('"realtimeServer":"gateway"')
        expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok")
        expect(await (await fetch(`${base}/readyz`)).text()).toBe("ready")
        expect((await fetch(`${base}/nowhere`)).status).toBe(404)
        const headers = async (sub: string) => ({
          apikey: KEY,
          authorization: `Bearer ${await sign(sub)}`,
          "content-type": "application/json",
        })
        const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
        const messages: Record<string, unknown>[] = []
        socket.on("message", (data) =>
          messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
        )
        const waitFor = async (test: (m: Record<string, unknown>) => boolean) => {
          const started = Date.now()
          for (;;) {
            const found = messages.find(test)
            if (found !== undefined) return found
            if (Date.now() - started > 10_000)
              throw new Error(`timed out: ${JSON.stringify(messages)}\n${run.output()}`)
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        }
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve())
          socket.once("error", reject)
        })
        socket.send(JSON.stringify({ t: "hello", v: 1, key: KEY, token: await sign("carol") }))
        await waitFor((m) => m["t"] === "welcome")
        socket.send(JSON.stringify({ t: "sub", id: "g", c: "notes", q: {} }))
        await waitFor((m) => m["t"] === "ready")

        const created = await fetch(`${base}/rest/v1/notes`, {
          method: "POST",
          headers: await headers("carol"),
          body: JSON.stringify({ _id: "g1", ownerId: "carol" }),
        })
        expect(created.status).toBe(201)
        expect(
          (
            await fetch(`${base}/rest/v1/notes`, {
              method: "POST",
              headers: await headers("dave"),
              body: JSON.stringify({ _id: "g2", ownerId: "carol" }),
            })
          ).status,
        ).toBe(403)
        expect(await waitFor((m) => m["t"] === "added")).toMatchObject({ id: "g1" })

        const mutation = "0192f6a1-7c2e-7b1a-9d3e-00000000a001"
        socket.send(
          JSON.stringify({
            t: "mut",
            id: mutation,
            c: "notes",
            op: "insert",
            args: { doc: { _id: "g3", ownerId: "carol" } },
          }),
        )
        const ack = await waitFor((m) => m["t"] === "ack" && m["m"] === mutation)
        expect(ack).toMatchObject({ ok: true })
        const added = messages.findIndex((m) => m["t"] === "added" && m["id"] === "g3")
        expect(added).toBeGreaterThanOrEqual(0)
        expect(added).toBeLessThan(messages.indexOf(ack))
        const refused = "0192f6a1-7c2e-7b1a-9d3e-00000000a002"
        socket.send(
          JSON.stringify({
            t: "mut",
            id: refused,
            c: "notes",
            op: "insert",
            args: { doc: { _id: "g4", ownerId: "dave" } },
          }),
        )
        expect(await waitFor((m) => m["t"] === "ack" && m["m"] === refused)).toMatchObject({
          ok: false,
        })
        expect(messages.some((m) => m["t"] === "added" && m["id"] === "g4")).toBe(false)
        socket.close()
      } finally {
        expect(await stop(run)).toBe(0)
        await mongo
          .db(database)
          .collection<{ _id: string }>("notes")
          .deleteMany({ _id: { $in: ["g1", "g3"] } })
      }
    },
  )

  it("reloads the policy folder when a file changes", async () => {
    // Inside the package so the policy file resolves @canopy/policy, but not under node_modules, where
    // Deno caches modules by path and ignores the query that forces a fresh import on reload.
    await mkdir(join(PACKAGE, "test", ".tmp"), { recursive: true })
    const policies = await mkdtemp(join(PACKAGE, "test", ".tmp", "canopy-policies-"))
    const write = (roles: string) =>
      writeFile(
        join(policies, "notes.mjs"),
        `import { allow, collection } from "@canopy/policy"\n` +
          `export default collection("notes", { exposed: true, policies: [allow.read(${roles})] })\n`,
      )
    await write(`"staff"`)
    const { run, base } = await boot(policies)
    try {
      await mongo.db(database).collection<{ _id: string }>("notes").insertOne({ _id: "public" })
      const anon = async () => {
        const response = await fetch(`${base}/rest/v1/notes`, { headers: { apikey: KEY } })
        expect(response.status).toBe(200)
        return ((await response.json()) as { data: { _id: string }[] }).data.map((d) => d._id)
      }
      expect(await anon()).toEqual([])
      await write(`"anon"`)
      const started = Date.now()
      while (!(await anon()).includes("public")) {
        if (Date.now() - started > 10_000)
          throw new Error(`the policies were not reloaded:\n${run.output()}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(run.output()).toContain('"msg":"policies reloaded"')
    } finally {
      expect(await stop(run)).toBe(0)
      await mongo.db(database).collection<{ _id: string }>("notes").deleteOne({ _id: "public" })
      await rm(policies, { recursive: true, force: true })
    }
  })

  it.each(SHUTDOWNS)(
    "drains on %s: readiness fails, sockets are told to reconnect, then it exits 0",
    async (how) => {
      const { run, base } = await boot()
      const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
      const messages: Record<string, unknown>[] = []
      socket.on("message", (data) =>
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
      )
      const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)))
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve())
        socket.once("error", reject)
      })
      socket.send(JSON.stringify({ t: "hello", v: 1, key: KEY, token: await sign("alice") }))
      const started = Date.now()
      while (!messages.some((m) => m["t"] === "welcome")) {
        if (Date.now() - started > 10_000) throw new Error(`no welcome: ${run.output()}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      requestShutdown(run, how)
      let draining = false
      while (run.child.exitCode === null && !draining) {
        const response = await fetch(`${base}/readyz`).catch(() => undefined)
        if (response?.status === 503) draining = (await response.text()) === "draining"
        else await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(draining).toBe(true)
      expect(await within(closed, 10_000, "the socket to close")).toBe(1012)
      expect(messages).toContainEqual(
        expect.objectContaining({ t: "reconnect", reason: "shutdown" }),
      )
      expect(await within(run.exited, 20_000, "exit")).toBe(0)
      const output = run.output()
      expect(output).toContain(`"msg":"draining","signal":"${how}","drainMs":5000`)
      expect(output.indexOf('"msg":"draining"')).toBeLessThan(output.indexOf('"msg":"stopped"'))
      await expect(fetch(`${base}/healthz`)).rejects.toThrow()
    },
  )
})
