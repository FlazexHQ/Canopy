import { type ChildProcess, spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { toNodeListener } from "@canopy/node-http"
import { findGatewayBinary } from "@canopy/realtime"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildHandler,
  type CaseFile,
  capture,
  loadCaseFiles,
  loadFixture,
  type RecordedRequest,
  seed,
} from "../../rest/test/conformance/find/harness.ts"

const DIR = fileURLToPath(new URL("../../../conformance/http/find", import.meta.url))
const READS_DIR = fileURLToPath(new URL("../../../conformance/http/reads", import.meta.url))
const GATEWAY = findGatewayBinary()
const fixture = await loadFixture(DIR)
const files = await loadCaseFiles(DIR)
const cases = files.flatMap((file) => file.cases)
const readCases = (await loadCaseFiles(READS_DIR)).flatMap((file) => file.cases)
const READ_ROUTES = "count,distinct,aggregate"

/** The recorded cases the gateway leaves to the server: a path outside the REST base path and a bad escape. */
const LEFT_TO_THE_SERVER = new Set(["outside-base-path", "bad-percent-encoding"])

const ORIGIN = "https://app.example.test"

/** A gateway process in front of the TypeScript handler. */
interface Gateway {
  readonly base: string
  readonly child: ChildProcess
}

function headersOf(request: RecordedRequest): Record<string, string> {
  const caller = fixture.callers[request.caller]
  if (caller === undefined) throw new Error(`The fixture has no caller named ${request.caller}`)
  return { ...caller, ...request.headers }
}

function listening(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  )
}

function closing(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

const suite = MONGODB_URI === undefined || GATEWAY === undefined ? describe.skip : describe

/**
 * The gateway with and without `find` selected, in front of the TypeScript REST handler of the oracle, against
 * one seeded database. The recorded requests of `conformance/http/find` get the recorded answers either way;
 * only the selected route is answered by the gateway itself (the handler marks every answer it gives with
 * `x-served-by`), and every other request reaches the handler unchanged.
 */
suite("CANOPY_DATA_PLANE_ROUTES switches the find route between Rust and TypeScript", () => {
  const database = `canopy_switch_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  const gateways: ChildProcess[] = []
  let mongo: MongoClient
  let upstream: Server
  let upstreamBase: string
  let corsUpstream: Server
  let corsBase: string
  let selected: Gateway
  let selectedByDocument: Gateway
  let unselected: Gateway
  let readsSelected: Gateway
  let withCors: Gateway

  /** Marks what the handler answers, and builds the listener of a handler over the seeded database. */
  const typescript = (extra: Parameters<typeof buildHandler>[3] = {}): Server => {
    const handler = buildHandler(mongo, database, fixture, extra)
    return createServer(
      toNodeListener(async (request, info) => {
        const response = await handler.fetch(request, info)
        response.headers.set("x-served-by", "typescript")
        return response
      }),
    )
  }

  const launcher = (proxy: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    mongodb: { uri: MONGODB_URI, database, metaDatabase: `${database}_meta` },
    server: { host: "127.0.0.1", port: 0, metricsPort: 0, shards: 2 },
    auth: {
      issuer: fixture.auth.issuer,
      jwks: fixture.auth.jwks,
      rolesClaim: fixture.auth.rolesClaim,
    },
    keys: { publishable: fixture.auth.publishableKeys, secret: fixture.auth.secretKeys },
    policies: { stored: fixture.policies.collections, contexts: fixture.policies.contexts },
    realtime: { checkpoints: "off", drainWindowMs: 100 },
    rateLimits: false,
    rest: fixture.readLimits,
    proxy: { url: proxy },
    log: { level: "error" },
    ...extra,
  })

  const start = async (
    document: Record<string, unknown>,
    routes: string | undefined,
  ): Promise<Gateway> => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env["CANOPY_DATA_PLANE_ROUTES"]
    if (routes !== undefined) env["CANOPY_DATA_PLANE_ROUTES"] = routes
    const child = spawn(GATEWAY ?? "", ["--config", "-"], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
    })
    gateways.push(child)
    child.stdin?.write(`${JSON.stringify(document)}\n`)
    const port = await new Promise<number>((resolve, reject) => {
      let pending = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString()
        const match = /\{"t":"listening","port":(\d+)\}/.exec(pending)
        if (match?.[1] !== undefined) resolve(Number(match[1]))
      })
      child.once("exit", (code) => reject(new Error(`canopy-gateway exited with ${code}`)))
    })
    return { base: `http://127.0.0.1:${port}`, child }
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "", { serverSelectionTimeoutMS: 10_000 })
    await mongo.connect()
    await seed(mongo, database, fixture)
    upstream = typescript()
    upstreamBase = await listening(upstream)
    corsUpstream = typescript({ cors: { origins: [ORIGIN] } })
    corsBase = await listening(corsUpstream)
    selected = await start(launcher(upstreamBase, {}), "find")
    selectedByDocument = await start(
      launcher(upstreamBase, { dataPlane: { routes: ["find"] } }),
      "",
    )
    unselected = await start(launcher(upstreamBase, {}), undefined)
    readsSelected = await start(launcher(upstreamBase, {}), READ_ROUTES)
    withCors = await start(launcher(corsBase, { cors: { origins: [ORIGIN] } }), "find")
  }, 120_000)

  afterAll(async () => {
    for (const child of gateways) {
      child.stdin?.end()
      await new Promise((resolve) => {
        child.once("exit", resolve)
        setTimeout(() => {
          child.kill()
          resolve(undefined)
        }, 5000).unref()
        if (child.exitCode !== null) resolve(undefined)
      })
    }
    await Promise.all([
      upstream === undefined ? undefined : closing(upstream),
      corsUpstream === undefined ? undefined : closing(corsUpstream),
    ])
    await mongo?.db(database).dropDatabase()
    await mongo?.close()
  })

  const send = (base: string, request: RecordedRequest): Promise<Response> =>
    fetch(`${base}${request.target}`, {
      method: request.method,
      headers: headersOf(request),
      ...(request.body === undefined ? {} : { body: request.body }),
    })

  const replay = async (
    gateway: () => Gateway,
    expectRust: boolean,
    recorded: readonly CaseFile["cases"][number][] = cases,
  ): Promise<number> => {
    let rust = 0
    for (const item of recorded) {
      const response = await send(gateway().base, item.request)
      const servedByTypeScript = response.headers.get("x-served-by") === "typescript"
      const actual = await capture(response, item.response.volatile)
      expect(actual.status, item.id).toBe(item.response.status)
      expect(actual.headers, item.id).toEqual(item.response.headers)
      expect(actual.body, item.id).toBe(item.response.body)
      for (const forbidden of item.response.neverInBody)
        expect(actual.body, item.id).not.toContain(forbidden)
      const expected = !expectRust || LEFT_TO_THE_SERVER.has(item.id)
      expect(
        servedByTypeScript,
        `${item.id} is answered by ${expected ? "TypeScript" : "Rust"}`,
      ).toBe(expected)
      if (!servedByTypeScript) rust += 1
    }
    return rust
  }

  it("has the recorded cases to replay", () => {
    expect(cases.length).toBeGreaterThan(200)
    for (const id of LEFT_TO_THE_SERVER) expect(cases.some((item) => item.id === id)).toBe(true)
  })

  it("answers every recorded request as recorded when the route is selected by the variable", async () => {
    const rust = await replay(() => selected, true)
    expect(rust).toBe(cases.length - LEFT_TO_THE_SERVER.size)
  }, 120_000)

  it("answers every recorded request as recorded when the route is selected by the document", async () => {
    const rust = await replay(() => selectedByDocument, true)
    expect(rust).toBe(cases.length - LEFT_TO_THE_SERVER.size)
  }, 120_000)

  it("answers every recorded request as recorded, all of them from TypeScript, when no route is selected", async () => {
    const rust = await replay(() => unselected, false)
    expect(rust).toBe(0)
  }, 120_000)

  it("answers every recorded count, distinct and aggregate as recorded from Rust when those routes are selected", async () => {
    expect(readCases.length).toBeGreaterThan(70)
    expect(await replay(() => readsSelected, true, readCases)).toBe(readCases.length)
    expect(await replay(() => unselected, false, readCases)).toBe(0)
    const find = await send(readsSelected.base, cases[0]?.request as RecordedRequest)
    expect(find.headers.get("x-served-by"), "find is not selected there").toBe("typescript")
    await find.arrayBuffer()
  }, 120_000)

  /** Requests of routes that are not selected. None of them changes a document, so the answers can be compared. */
  const others: readonly (readonly [string, string, string?])[] = [
    ["POST", "/rest/v1/todos", "{"],
    ["PATCH", "/rest/v1/todos?where=%7B%22_id%22%3A%22none%22%7D", '{"$set":{"title":"y"}}'],
    ["DELETE", "/rest/v1/todos?where=%7B%22_id%22%3A%22none%22%7D"],
    ["GET", "/rest/v1/todos/does-not-exist"],
    ["PUT", "/rest/v1/todos/does-not-exist", "{}"],
    ["POST", "/rest/v1/todos/_count", "{}"],
    ["POST", "/rest/v1/todos/_distinct", '{"field":"status"}'],
    ["POST", "/rest/v1/todos/_query", "{}"],
    ["POST", "/rest/v1/_batch", '{"operations":[]}'],
    ["GET", "/rest/v1/openapi.json"],
    ["GET", "/rest/v1"],
    ["GET", "/rest/v1/a/b/c"],
    ["OPTIONS", "/rest/v1/openapi.json"],
    ["GET", "/rest/v10/todos"],
    ["GET", "/other/todos"],
    ["GET", "/rest/v1/%E0%A4%A"],
  ]

  const raw = (base: string, method: string, target: string, body?: string): Promise<Response> =>
    fetch(`${base}${target}`, {
      method,
      headers: { ...fixture.callers["service"], "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    })

  const comparable = async (response: Response) => {
    const text = await response.text()
    const body = text.length === 0 ? undefined : (JSON.parse(text) as Record<string, unknown>)
    if (body !== undefined) {
      delete body["requestId"]
      delete body["ct"]
    }
    return {
      status: response.status,
      allow: response.headers.get("allow"),
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      servedBy: response.headers.get("x-served-by"),
      body,
    }
  }

  it("proxies every route that is not selected to TypeScript, whether or not find is selected", async () => {
    for (const [method, target, body] of others) {
      const direct = await comparable(await raw(upstreamBase, method, target, body))
      const via = await comparable(await raw(selected.base, method, target, body))
      expect(via.servedBy, `${method} ${target} is answered by the handler`).toBe("typescript")
      expect(via, `${method} ${target} through the selected gateway`).toEqual(direct)
      const plain = await comparable(await raw(unselected.base, method, target, body))
      expect(plain, `${method} ${target} through the other gateway`).toEqual(direct)
    }
  }, 60_000)

  it("serves the selected route itself: GET, OPTIONS and the 405 of the other methods of a collection", async () => {
    const own: readonly (readonly [string, string, number])[] = [
      ["GET", "/rest/v1/todos?limit=1", 200],
      ["OPTIONS", "/rest/v1/todos", 204],
      ["PUT", "/rest/v1/todos", 405],
      ["HEAD", "/rest/v1/todos", 405],
    ]
    for (const [method, target, status] of own) {
      for (const [gateway, rust] of [
        [selected, true],
        [unselected, false],
      ] as const) {
        const response = await raw(gateway.base, method, target)
        expect(response.status, `${method} ${target}`).toBe(status)
        expect(response.headers.get("x-served-by") === "typescript", `${method} ${target}`).toBe(
          !rust,
        )
        await response.arrayBuffer()
      }
      const direct = await comparable(await raw(upstreamBase, method, target))
      const rust = await comparable(await raw(selected.base, method, target))
      expect({ ...rust, servedBy: null }).toEqual({ ...direct, servedBy: null })
    }
  }, 60_000)

  it("keeps answering the selected route when the TypeScript server is gone, and nothing else", async () => {
    const lonely = createServer((_request, response) => {
      response.statusCode = 200
      response.end("here")
    })
    const lonelyBase = await listening(lonely)
    const gateway = await start(launcher(lonelyBase, {}), "find")
    try {
      const alive = await raw(gateway.base, "GET", "/rest/v1/todos?limit=1")
      expect(alive.status).toBe(200)
      expect(((await alive.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
      expect(await (await raw(gateway.base, "POST", "/rest/v1/todos", "{}")).text()).toBe("here")
      await closing(lonely)
      const find = await raw(gateway.base, "GET", "/rest/v1/todos?limit=1")
      expect(find.status, "find does not need the TypeScript server").toBe(200)
      expect(((await find.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
      for (const [method, target] of [
        ["POST", "/rest/v1/todos"],
        ["GET", "/rest/v1/todos/1"],
        ["GET", "/rest/v1/openapi.json"],
        ["GET", "/graphql/v1"],
      ] as const) {
        const response = await raw(
          gateway.base,
          method,
          target,
          method === "POST" ? "{}" : undefined,
        )
        expect(response.status, `${method} ${target} with no server behind the gateway`).toBe(502)
        await response.arrayBuffer()
      }
    } finally {
      gateway.child.stdin?.end()
      await closing(lonely)
    }
  }, 60_000)

  it("answers the browser headers of the selected route as the TypeScript handler does", async () => {
    const targets: readonly [string, string, Record<string, string>][] = [
      ["OPTIONS", "/rest/v1/todos", { origin: ORIGIN }],
      ["OPTIONS", "/rest/v1/todos", { origin: "https://evil.example.test" }],
      ["OPTIONS", "/rest/v1/todos", {}],
      ["GET", "/rest/v1/todos?limit=1", { origin: ORIGIN }],
      ["GET", "/rest/v1/todos?limit=1", { origin: "https://evil.example.test" }],
      ["GET", "/rest/v1/todos?limit=1", {}],
      ["PUT", "/rest/v1/todos", { origin: ORIGIN }],
      ["GET", "/rest/v1/nope", { origin: ORIGIN }],
    ]
    const keys = [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-max-age",
      "access-control-expose-headers",
      "vary",
      "allow",
    ]
    for (const [method, target, extra] of targets) {
      const headers = { ...fixture.callers["service"], ...extra }
      const direct = await fetch(`${corsBase}${target}`, { method, headers })
      const rust = await fetch(`${withCors.base}${target}`, { method, headers })
      expect(rust.status, `${method} ${target} ${JSON.stringify(extra)}`).toBe(direct.status)
      expect(rust.headers.get("x-served-by")).toBeNull()
      expect(direct.headers.get("x-served-by")).toBe("typescript")
      for (const key of keys)
        expect(rust.headers.get(key), `${method} ${target} ${JSON.stringify(extra)} ${key}`).toBe(
          direct.headers.get(key),
        )
      await Promise.all([rust.arrayBuffer(), direct.arrayBuffer()])
    }
  }, 60_000)
})
