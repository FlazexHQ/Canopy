import { fileURLToPath } from "node:url"
import { expect, type Page, test } from "@playwright/test"
import type { isCanopyError, ObjectId } from "canopy.js"
import type { RestClient } from "canopy.js/rest"
import { build } from "esbuild"
import { MongoClient } from "mongodb"
import { add, openAs } from "./app-helpers.ts"

declare const window: {
  restHarness: {
    createRestClient(): RestClient
    isCanopyError: typeof isCanopyError
    ObjectId: typeof ObjectId
    user: string
  }
}

const uri = process.env["CANOPY_TEST_MONGODB_URI"]
test.skip(uri === undefined, "needs a MongoDB replica set in CANOPY_TEST_MONGODB_URI")

async function readPages(page: Page, user: string) {
  await page.goto(`/?user=${user}`)
  return page.evaluate(async (expected) => {
    if (window.restHarness.user !== expected)
      throw new Error(`The harness signed in as ${window.restHarness.user}, not ${expected}`)
    const todos = window.restHarness.createRestClient().from("todos")
    const query = todos.find({}).sort({ title: 1 }).fields({ title: 1 }).limit(2)
    const first = await query.page()
    const second = first.page.next === null ? null : await query.page({ after: first.page.next })
    const documents = (data: typeof first.data) =>
      data.map((doc) => ({ ...doc, _id: doc._id.toHexString() }))
    return {
      first: documents(first.data),
      next: first.page.next,
      second: second && { data: documents(second.data), next: second.page.next },
      count: (await todos.count()).data,
    }
  }, user)
}

test("pages and counts private todos over REST, preserves errors and never opens a socket", async ({
  browser,
  page,
}, info) => {
  await using mongo = new MongoClient(uri ?? "")
  const todos = mongo.db(info.config.metadata["database"]).collection("todos")
  await todos.deleteMany({})
  for (const [user, titles] of [
    ["alice", ["Laundry", "Dishes", "Groceries"]],
    ["bob", ["Bills"]],
  ] as const) {
    const context = await browser.newContext()
    try {
      const app = await openAs(context, user)
      for (const title of titles) await add(app, title, false)
      await expect.poll(() => todos.countDocuments({ ownerId: user })).toBe(titles.length)
    } finally {
      await context.close()
    }
  }

  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../web/rest-harness.ts", import.meta.url))],
    conditions: ["@canopy/source"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2023",
    write: false,
  })
  const script = bundle.outputFiles[0]
  if (!script) throw new Error("Missing REST harness bundle")
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: script.text }),
  )
  const sockets: string[] = []
  const errors: string[] = []
  page.on("websocket", (socket) => sockets.push(socket.url()))
  page.on("pageerror", (error) => errors.push(error.message))

  const id = expect.stringMatching(/^[0-9a-f]{24}$/)
  const bob = await readPages(page, "bob")
  expect(bob).toEqual({
    first: [{ _id: id, title: "Bills" }],
    next: null,
    second: null,
    count: { count: 1, exact: true },
  })
  const alice = await readPages(page, "alice")
  expect(alice).toEqual({
    first: [
      { _id: id, title: "Dishes" },
      { _id: id, title: "Groceries" },
    ],
    next: expect.stringMatching(/\S/),
    second: { data: [{ _id: id, title: "Laundry" }], next: null },
    count: { count: 3, exact: true },
  })

  expect(
    await page.evaluate(async () => {
      const controller = new AbortController()
      const pending = window.restHarness
        .createRestClient()
        .from("todos")
        .page({ signal: controller.signal })
      controller.abort()
      try {
        await pending
        return false
      } catch (error) {
        return (
          error === controller.signal.reason &&
          error instanceof DOMException &&
          error.name === "AbortError"
        )
      }
    }),
  ).toBe(true)

  const privateId = bob.first[0]?._id
  if (!privateId) throw new Error("Missing Bob's todo id")
  const failure = await page.evaluate(async (id) => {
    const { createRestClient, isCanopyError, ObjectId } = window.restHarness
    try {
      await createRestClient().from("todos").findById(new ObjectId(id))
      return null
    } catch (error) {
      if (!isCanopyError(error)) throw error
      return { code: error.code, requestId: error.details?.["requestId"] }
    }
  }, privateId)
  expect(failure).toEqual({ code: "CANOPY_NOT_FOUND", requestId: expect.stringMatching(/\S/) })
  expect(errors).toEqual([])
  expect(sockets).toEqual([])
})
