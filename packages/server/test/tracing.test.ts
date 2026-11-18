import { allow, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { context, propagation, SpanKind, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const KEY = "pk_tracing_test"
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const PARENT_ID = "00f067aa0ba902b7"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [allow.read("anon"), allow.insert("anon")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("OpenTelemetry tracing", () => {
  const dbName = `canopy_server_tracing_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const contextManager = new AsyncLocalStorageContextManager()
  const running: Canopy[] = []
  let traced: Canopy
  let untraced: Canopy
  let mongo: MongoClient

  const start = (tracing: boolean, suffix: string) =>
    createCanopy(
      defineConfig({
        mongodb: {
          uri: MONGODB_URI ?? "",
          database: `${dbName}_${suffix}`,
          metaDatabase: `${dbName}_${suffix}_meta`,
        },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        telemetry: { tracing },
      }),
      { env: TEST_ENV, policies: createPolicySet([notes]), onSetupToken: false },
    )

  beforeAll(async () => {
    context.setGlobalContextManager(contextManager.enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    trace.setGlobalTracerProvider(provider)
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    traced = await start(true, "on")
    untraced = await start(false, "off")
    running.push(traced, untraced)
  })

  afterAll(async () => {
    for (const canopy of running) await canopy.close()
    for (const suffix of ["on", "off"]) {
      await mongo.db(`${dbName}_${suffix}`).dropDatabase()
      await mongo.db(`${dbName}_${suffix}_meta`).dropDatabase()
    }
    await mongo.close()
    await provider.shutdown()
    trace.disable()
    propagation.disable()
    context.disable()
  })

  beforeEach(() => exporter.reset())

  const get = (canopy: Canopy, headers: Record<string, string> = {}) =>
    canopy.fetch(
      new Request("http://canopy.test/rest/v1/notes?filter=%7B%22tag%22%3A%22x%22%7D", {
        headers: { apikey: KEY, ...headers },
      }),
    )

  const spans = (): ReadableSpan[] => exporter.getFinishedSpans()
  const parentOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId

  it("continues the caller's traceparent and nests the MongoDB commands under the request", async () => {
    const response = await get(traced, { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` })
    expect(response.status).toBe(200)
    const server = spans().find((span) => span.kind === SpanKind.SERVER)
    expect(server?.name).toBe("GET /rest/v1")
    expect(server?.spanContext().traceId).toBe(TRACE_ID)
    expect(server && parentOf(server)).toBe(PARENT_ID)
    expect(server?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/rest/v1",
      "http.response.status_code": 200,
    })
    const find = spans().find(
      (span) => span.kind === SpanKind.CLIENT && span.name === `find ${dbName}_on.notes`,
    )
    expect(find?.spanContext().traceId).toBe(TRACE_ID)
    expect(find && parentOf(find)).toBe(server?.spanContext().spanId)
    expect(find?.attributes).toMatchObject({
      "db.system.name": "mongodb",
      "db.operation.name": "find",
      "db.collection.name": "notes",
    })
    expect(JSON.stringify(find?.attributes)).not.toContain("tag")
  })

  it("starts a new trace without a traceparent, and records a fan out for each change", async () => {
    await get(traced)
    const server = spans().find((span) => span.kind === SpanKind.SERVER)
    expect(server).toBeDefined()
    expect(server?.spanContext().traceId).not.toBe(TRACE_ID)
    expect(server && parentOf(server)).toBeUndefined()

    exporter.reset()
    await mongo.db(`${dbName}_on`).collection("notes").insertOne({ text: "hello" })
    for (let i = 0; i < 100 && !spans().some((s) => s.name === "canopy.realtime.fanout"); i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const fanout = spans().find((span) => span.name === "canopy.realtime.fanout")
    expect(fanout?.attributes["events"]).toBe(1)
  })

  it("records nothing when tracing is off", async () => {
    await get(untraced, { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` })
    await mongo.db(`${dbName}_off`).collection("notes").insertOne({ text: "quiet" })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(spans().filter((span) => span.name.includes(`${dbName}_off`))).toEqual([])
    expect(spans().filter((span) => span.kind === SpanKind.SERVER)).toEqual([])
  })
})
