import { collection, t } from "@canopy/schema/define"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import {
  type CanopyError,
  type DocumentSchema,
  isCanopyError,
  NotFoundError,
  ObjectId,
  ValidationError,
} from "../src/index.ts"
import { createRestClient, type RestPage } from "../src/rest/index.ts"

interface Todo {
  _id: ObjectId
  title: string
  done: boolean
  at: Date
}

type Db = DocumentSchema<{ todos: Todo; notes: { _id: string; body: string } }>

interface Sent {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function fakeFetch(...responses: (Response | ((sent: Sent) => Response | Promise<Response>))[]) {
  const sent: Sent[] = []
  const impl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const call: Sent = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        signal: init?.signal ?? undefined,
      }
      sent.push(call)
      const next = responses.shift()
      if (next === undefined) throw new Error("no response queued")
      return typeof next === "function" ? next(call) : next
    },
  )
  return { fetch: impl as unknown as typeof fetch, sent, impl }
}

const ID = "6728f0c2a1b2c3d4e5f60718"
const page1 = {
  data: [{ _id: { $oid: ID }, title: "a", done: false, at: { $date: { $numberLong: "0" } } }],
  page: { limit: 1, next: "cursor-1" },
  ct: "7300000000000000001",
}

function client(
  fetch: typeof globalThis.fetch,
  token?: () => string | undefined,
  timeoutMs?: number,
) {
  return createRestClient<Db>({
    url: "http://canopy.test/",
    publishableKey: "pk_test",
    fetch,
    ...(token === undefined ? {} : { token }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

describe("REST queries", () => {
  it("build without I/O and read a page with the caller's token, decoding EJSON", async () => {
    const { fetch, sent, impl } = fakeFetch(json(page1))
    let token = "t1"
    const query = client(fetch, () => token)
      .from("todos")
      .find({ done: false })
      .sort({ _id: 1 })
      .fields({ title: 1 })
      .limit(1)
    expect(impl).not.toHaveBeenCalled()
    token = "t2"
    const first = await query.page()
    expect(sent).toEqual([
      {
        url: "http://canopy.test/rest/v1/todos/_query",
        method: "POST",
        headers: {
          apikey: "pk_test",
          accept: "application/ejson",
          authorization: "Bearer t2",
          "content-type": "application/json",
        },
        body: {
          filter: { done: false },
          sort: { _id: { $numberInt: "1" } },
          fields: { title: { $numberInt: "1" } },
          limit: { $numberInt: "1" },
        },
        signal: undefined,
      },
    ])
    expect(first.data[0]?._id).toEqual(new ObjectId(ID))
    expect((first.data[0] as unknown as Todo).at).toEqual(new Date(0))
    expect(first.page).toEqual({ limit: 1, next: "cursor-1" })
    expect(first.ct).toBe("7300000000000000001")
    expectTypeOf(first).toEqualTypeOf<RestPage<{ _id: ObjectId; title: string }>>()
  })

  it("follows the cursor and asks for a total", async () => {
    const last = { data: [], page: { limit: 1, next: null, total: 1 }, ct: "7300000000000000002" }
    const { fetch, sent } = fakeFetch(json(page1), json(last))
    const query = client(fetch).from("todos").limit(1)
    const first = await query.page()
    const next = first.page.next
    if (next === null) throw new Error("expected a cursor")
    const second = await query.page({ after: next, count: "exact" })
    expect(sent[1]?.body).toEqual({
      filter: {},
      limit: { $numberInt: "1" },
      after: "cursor-1",
      count: "exact",
    })
    expect(sent[1]?.headers["authorization"]).toBeUndefined()
    expect(second.page).toEqual({ limit: 1, next: null, total: 1 })
  })

  it("replaces the filter on a second find", async () => {
    const { fetch, sent } = fakeFetch(json({ ...page1, page: { limit: 20, next: null } }))
    await client(fetch).from("todos").find({ done: true }).find({ title: "x" }).page()
    expect(sent[0]?.body).toEqual({ filter: { title: "x" } })
  })

  it("rejects an envelope it does not recognize", async () => {
    const { fetch } = fakeFetch(
      json({ data: [], page: { limit: 1, next: null } }),
      json({ data: [1], page: { limit: 1, next: null }, ct: "1" }),
      json({ data: [], page: { limit: 1, next: 3 }, ct: "1" }),
    )
    const todos = client(fetch).from("todos")
    for (const message of ["ct is not a cluster time", "data is not a list", "page.next"]) {
      const error = await todos.page().catch((reason: unknown) => reason)
      expect(isCanopyError(error, "CANOPY_PROTOCOL_ERROR")).toBe(true)
      expect((error as Error).message).toContain(message)
    }
  })
})

describe("REST reads by id and counts", () => {
  it("encodes every id as canonical EJSON, so a string that looks like an ObjectId stays a string", async () => {
    const doc = (id: unknown) => json({ data: { _id: id, body: "b" }, ct: "1" })
    const { fetch, sent } = fakeFetch(
      json({ data: { _id: { $oid: ID }, title: "a" }, ct: "1" }),
      doc(ID),
      doc({ $numberInt: "0" }),
    )
    const rest = client(fetch)
    const found = await rest
      .from("todos")
      .findById(new ObjectId(ID), { fields: { title: 1, _id: 1 } })
    await rest.from("notes").findById(ID)
    await (rest.from("notes").findById as (id: unknown) => Promise<unknown>)(0)
    expect(sent.map((call) => decodeURIComponent(call.url))).toEqual([
      `http://canopy.test/rest/v1/todos/{"$oid":"${ID}"}?fields=title,_id`,
      `http://canopy.test/rest/v1/notes/"${ID}"`,
      `http://canopy.test/rest/v1/notes/{"$numberInt":"0"}`,
    ])
    expect(found.data).toEqual({ _id: new ObjectId(ID), title: "a" })
    expectTypeOf(found.data).toEqualTypeOf<{ _id: ObjectId; title: string }>()
    const wrongId = () =>
      // @ts-expect-error notes have string ids
      rest.from("notes").findById(new ObjectId(ID))
    void wrongId
  })

  it("keeps the server's typed 404 with its request id and details", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          type: "urn:canopy:error:not-found",
          title: "Not found",
          status: 404,
          code: "CANOPY_NOT_FOUND",
          detail: "Document not found",
          instance: "/rest/v1/todos/x",
          requestId: "req-1",
          hint: "Check the id",
        },
        404,
        { "content-type": "application/problem+json" },
      ),
    )
    const error = await client(fetch)
      .from("todos")
      .findById(new ObjectId(ID))
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({
      code: "CANOPY_NOT_FOUND",
      message: "Document not found",
      hint: "Check the id",
      details: { requestId: "req-1", status: 404 },
    })
  })

  it("counts with the requested mode and reports exactness", async () => {
    const { fetch, sent } = fakeFetch(
      json({ data: { count: 42, exact: false }, ct: "9" }),
      json({ data: { count: 1, exact: true }, ct: "9" }),
    )
    const todos = client(fetch).from("todos")
    const estimated = await todos.count({ done: false }, { mode: "estimated" })
    const exact = await todos.count()
    expect(estimated).toEqual({ data: { count: 42, exact: false }, ct: "9" })
    expect(exact.data).toEqual({ count: 1, exact: true })
    expect(sent.map((call) => [call.url, call.headers["prefer"], call.body])).toEqual([
      ["http://canopy.test/rest/v1/todos/_count", "count=estimated", { filter: { done: false } }],
      ["http://canopy.test/rest/v1/todos/_count", "count=exact", { filter: {} }],
    ])
  })
})

describe("REST failures", () => {
  it("maps a response that is not Problem Details to CANOPY_UNAVAILABLE with the status", async () => {
    const { fetch } = fakeFetch(
      new Response("bad gateway", { status: 502, headers: { "x-request-id": "r2" } }),
    )
    const error = (await client(fetch)
      .from("todos")
      .page()
      .catch((reason: unknown) => reason)) as CanopyError
    expect(isCanopyError(error, "CANOPY_UNAVAILABLE")).toBe(true)
    expect(error.details).toEqual({ status: 502, requestId: "r2" })
  })

  it("reports an unreachable server as CANOPY_UNAVAILABLE", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed")
    })
    const error = await client(fetch)
      .from("todos")
      .page()
      .catch((reason: unknown) => reason)
    expect(isCanopyError(error, "CANOPY_UNAVAILABLE")).toBe(true)
  })

  it("passes the caller's signal to fetch and rejects with its reason when aborted", async () => {
    const controller = new AbortController()
    const { fetch, sent } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason))
        }),
    )
    const pending = client(fetch).from("todos").page({ signal: controller.signal })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const reason = new Error("left the page")
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(sent[0]?.signal?.aborted).toBe(true)
  })

  it("sends nothing when the signal is already aborted", async () => {
    const { fetch, impl } = fakeFetch(json(page1))
    const controller = new AbortController()
    controller.abort(new Error("gone"))
    await expect(
      client(fetch).from("todos").count({}, { signal: controller.signal }),
    ).rejects.toThrow("gone")
    expect(impl).not.toHaveBeenCalled()
  })

  it("times out with CANOPY_TIMEOUT and aborts the request", async () => {
    const { fetch, sent } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason))
        }),
    )
    const error = await client(fetch, undefined, 20)
      .from("todos")
      .page()
      .catch((reason: unknown) => reason)
    expect(isCanopyError(error, "CANOPY_TIMEOUT")).toBe(true)
    expect(sent[0]?.signal?.aborted).toBe(true)
  })
})

describe("the REST entry point", () => {
  it("imports and reads where no WebSocket exists", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
    Reflect.deleteProperty(globalThis, "WebSocket")
    try {
      expect("WebSocket" in globalThis).toBe(false)
      vi.resetModules()
      const rest = await import("../src/rest/index.ts")
      const { fetch } = fakeFetch(json(page1))
      const result = await rest
        .createRestClient({ url: "http://canopy.test", publishableKey: "pk", fetch })
        .from("todos")
        .page()
      expect(result.data).toHaveLength(1)
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "WebSocket", original)
    }
  })
})

describe("REST distinct and aggregate", () => {
  interface Tagged {
    _id: ObjectId
    tags: string[]
    rank: number | null
  }
  type Tags = DocumentSchema<{ tagged: Tagged }>

  it("reads distinct values of a typed path", async () => {
    const { fetch, sent } = fakeFetch(json({ data: ["a", "b"], ct: "5" }))
    const rest = createRestClient<Tags>({ url: "http://canopy.test", publishableKey: "pk", fetch })
    const tags = await rest.from("tagged").distinct("tags", { rank: { $gt: 1 } })
    expect(tags).toEqual({ data: ["a", "b"], ct: "5" })
    expect(sent[0]).toMatchObject({
      url: "http://canopy.test/rest/v1/tagged/_distinct",
      method: "POST",
      body: { field: "tags", filter: { rank: { $gt: { $numberInt: "1" } } } },
    })
    expectTypeOf(tags.data).toEqualTypeOf<readonly string[]>()
    const ranks = () => rest.from("tagged").distinct("rank")
    expectTypeOf<Awaited<ReturnType<typeof ranks>>["data"]>().toEqualTypeOf<
      readonly (number | null)[]
    >()
    const unknownField = () =>
      // @ts-expect-error not a path of the documents
      rest.from("tagged").distinct("tag")
    void unknownField
  })

  it("returns aggregation output as unknown without a decoder", async () => {
    const { fetch, sent } = fakeFetch(json({ data: [{ _id: "a", n: 2 }], ct: "6" }))
    const rest = createRestClient<Tags>({ url: "http://canopy.test", publishableKey: "pk", fetch })
    const pipeline = [{ $unwind: "$tags" }, { $group: { _id: "$tags", n: { $sum: 1 } } }]
    const result = await rest.from("tagged").aggregate(pipeline)
    expect(result.data).toEqual([{ _id: "a", n: 2 }])
    expectTypeOf(result.data).toEqualTypeOf<readonly unknown[]>()
    expect(sent[0]?.url).toBe("http://canopy.test/rest/v1/tagged/_aggregate")
    expect(sent[0]?.body).toEqual({
      pipeline: [
        { $unwind: "$tags" },
        { $group: { _id: "$tags", n: { $sum: { $numberInt: "1" } } } },
      ],
    })
  })

  it("checks aggregation output with a Standard Schema decoder", async () => {
    const counts = collection("counts", { _id: t.string(), n: t.int() })
    const { fetch } = fakeFetch(
      json({ data: [{ _id: "a", n: 2 }], ct: "7" }),
      json({
        data: [
          { _id: "a", n: 2 },
          { _id: "b", n: "two" },
        ],
        ct: "7",
      }),
    )
    const rest = createRestClient<Tags>({ url: "http://canopy.test", publishableKey: "pk", fetch })
    const typed = await rest.from("tagged").aggregate([], { decode: counts })
    expect(typed.data).toEqual([{ _id: "a", n: 2 }])
    expectTypeOf(typed.data).toEqualTypeOf<readonly { _id: string; n: number }[]>()
    const error = await rest
      .from("tagged")
      .aggregate([], { decode: counts })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe(
      "Output document 1 does not match: Expected int, got a string at n",
    )
  })
})
