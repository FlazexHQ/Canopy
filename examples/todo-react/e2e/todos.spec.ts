import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test"
import { MongoClient } from "mongodb"
import { add, openAs } from "./app-helpers.ts"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]

test.skip(uri === undefined, "needs a MongoDB replica set in CANOPY_TEST_MONGODB_URI")

let mongo: MongoClient | undefined

const todosCollection = () => {
  const info = test.info().config.metadata as { database: string }
  if (mongo === undefined) throw new Error("not connected")
  return mongo.db(info.database).collection<{ title: string; [key: string]: unknown }>("todos")
}

test.beforeAll(async () => {
  mongo = new MongoClient(uri ?? "")
  await mongo.connect()
})

test.afterAll(async () => {
  await mongo?.close()
})

const contexts: BrowserContext[] = []

/** A browser context of its own (another user or device), closed after the test. */
async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  contexts.push(context)
  return context
}

test.beforeEach(async () => {
  await todosCollection().deleteMany({})
})

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

const titles = (page: Page) => page.getByTestId("todo").locator(".title")

test("keeps two tabs of one user in sync", async ({ context }) => {
  const first = await openAs(context, "alice")
  const second = await openAs(context, "alice")
  await add(first, "Water the plants")
  await expect(titles(first)).toHaveText(["Water the plants"])
  await expect(titles(second)).toHaveText(["Water the plants"])
  await second.getByRole("checkbox", { name: "Done: Water the plants" }).check()
  await expect(first.getByRole("checkbox", { name: "Done: Water the plants" })).toBeChecked()
  await first.getByRole("button", { name: "Delete Water the plants" }).click()
  await expect(titles(second)).toHaveCount(0)
  expect(await todosCollection().countDocuments()).toBe(0)
})

test("shows each user only what the policies allow, live", async ({ browser }) => {
  const alice = await openAs(await newContext(browser), "alice")
  const bob = await openAs(await newContext(browser), "bob")
  await add(alice, "Buy milk")
  await add(alice, "Read diary", false)
  await expect(titles(alice)).toHaveText(["Buy milk", "Read diary"])
  await expect(titles(bob)).toHaveText(["Buy milk"])
  await add(bob, "Fix the bike")
  await expect(titles(alice)).toHaveText(["Buy milk", "Read diary", "Fix the bike"])
  await expect(bob.getByTestId("todo").filter({ hasText: "Fix the bike" })).toContainText("you")
  await expect(alice.getByTestId("todo").filter({ hasText: "Fix the bike" })).toContainText("bob")
})

test("rolls back a delete the policies refuse and explains why", async ({ browser }) => {
  const alice = await openAs(await newContext(browser), "alice")
  const bob = await openAs(await newContext(browser), "bob")
  await add(alice, "Alice's chore")
  await expect(titles(bob)).toHaveText(["Alice's chore"])
  await bob.getByRole("button", { name: "Delete Alice's chore" }).click()
  await expect(bob.getByTestId("error")).toContainText("not yours to change")
  await expect(titles(bob)).toHaveText(["Alice's chore"])
  await expect(titles(alice)).toHaveText(["Alice's chore"])
  expect(await todosCollection().countDocuments({ title: "Alice's chore" })).toBe(1)
})

test("detects concurrent renames and keeps the first one", async ({ browser }) => {
  const aliceContext = await newContext(browser)
  const bobContext = await newContext(browser)
  const alice = await openAs(aliceContext, "alice")
  const bob = await openAs(bobContext, "bob")
  await add(alice, "Plan trip")
  await expect(titles(bob)).toHaveText(["Plan trip"])

  await bobContext.setOffline(true)
  await expect(bob.getByTestId("status")).toHaveText("offline")
  await bob.getByRole("button", { name: "Rename Plan trip" }).click()
  await bob.getByLabel("New title for Plan trip").fill("Plan the bob trip")
  await bob.getByRole("button", { name: "Save" }).click()
  await expect(titles(bob)).toHaveText(["Plan the bob trip"])

  await alice.getByRole("button", { name: "Rename Plan trip" }).click()
  await alice.getByLabel("New title for Plan trip").fill("Plan the alice trip")
  await alice.getByRole("button", { name: "Save" }).click()
  await expect(titles(alice)).toHaveText(["Plan the alice trip"])
  await expect
    .poll(async () => (await todosCollection().findOne({}))?.title)
    .toBe("Plan the alice trip")

  await bobContext.setOffline(false)
  await expect(bob.getByTestId("status")).toHaveText("live")
  await expect(bob.getByTestId("error")).toContainText("changed that todo first")
  await expect(titles(bob)).toHaveText(["Plan the alice trip"])
  await expect(titles(alice)).toHaveText(["Plan the alice trip"])
  expect((await todosCollection().findOne({}))?.["v"]).toBe(1)
})

test("queues changes while offline and sends them in order when back online", async ({
  browser,
}) => {
  const aliceContext = await newContext(browser)
  const alice = await openAs(aliceContext, "alice")
  const bob = await openAs(await newContext(browser), "bob")
  await aliceContext.setOffline(true)
  await expect(alice.getByTestId("status")).toHaveText("offline")
  await add(alice, "First offline")
  await add(alice, "Second offline")
  await alice.getByRole("checkbox", { name: "Done: First offline" }).check()
  await expect(titles(alice)).toHaveText(["First offline", "Second offline"])
  await bob.waitForTimeout(500)
  await expect(titles(bob)).toHaveCount(0)
  expect(await todosCollection().countDocuments()).toBe(0)

  await aliceContext.setOffline(false)
  await expect(alice.getByTestId("status")).toHaveText("live")
  await expect(titles(bob)).toHaveText(["First offline", "Second offline"])
  await expect(bob.getByRole("checkbox", { name: "Done: First offline" })).toBeChecked()
})

test("replays changes queued offline after the page is closed and opened again", async ({
  context,
}) => {
  const first = await openAs(context, "alice")
  await context.setOffline(true)
  await expect(first.getByTestId("status")).toHaveText("offline")
  await add(first, "Survives a reload")
  await expect(titles(first)).toHaveText(["Survives a reload"])
  await first.waitForTimeout(300)
  await first.close()
  expect(await todosCollection().countDocuments()).toBe(0)

  await context.setOffline(false)
  const again = await openAs(context, "alice")
  await expect(titles(again)).toHaveText(["Survives a reload"])
  await expect.poll(() => todosCollection().countDocuments({ title: "Survives a reload" })).toBe(1)
  const second = await openAs(context, "alice")
  await expect(titles(second)).toHaveText(["Survives a reload"])
  await again.waitForTimeout(500)
  expect(await todosCollection().countDocuments()).toBe(1)
})

test("falls back to SSE when WebSockets are blocked and stays live with WebSocket users", async ({
  browser,
}) => {
  const metadata = test.info().config.metadata as { fallbackPort: number }
  const context = await newContext(browser)
  const splitUrl = process.env["CANOPY_SPLIT_E2E_URL"]
  if (splitUrl)
    await context.routeWebSocket("**/realtime/v1", (socket) => socket.close({ code: 1006 }))
  const blocked = splitUrl ?? `http://127.0.0.1:${metadata.fallbackPort}`
  const alice = await openAs(context, "alice", blocked)
  const bob = await openAs(await newContext(browser), "bob")
  await add(alice, "Over SSE")
  await expect(titles(bob)).toHaveText(["Over SSE"])
  await add(bob, "Over WebSocket")
  await expect(titles(alice)).toHaveText(["Over SSE", "Over WebSocket"])
  await alice.getByRole("checkbox", { name: "Done: Over WebSocket" }).check()
  await expect(bob.getByRole("checkbox", { name: "Done: Over WebSocket" })).toBeChecked()
})
