import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test"
import { MongoClient } from "mongodb"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]

test.skip(uri === undefined, "needs a MongoDB replica set in CANOPY_TEST_MONGODB_URI")

let mongo: MongoClient | undefined
const contexts: BrowserContext[] = []
let visitors = 0

const database = (): string => (test.info().config.metadata as { database: string }).database

test.beforeAll(async () => {
  mongo = new MongoClient(uri ?? "")
  await mongo.connect()
})

test.beforeEach(async () => {
  await mongo?.db(database()).collection("posts").deleteMany({})
})

test.afterAll(async () => {
  if (mongo !== undefined)
    for (const suffix of ["", "_meta", "_auth"])
      await mongo.db(`${database()}${suffix}`).dropDatabase()
  await mongo?.close()
})

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

/**
 * A visitor of their own: a separate browser context signs in anonymously as another user. Each one comes
 * from its own client address (the server trusts the loopback proxy), since anonymous sign ins are rate
 * limited per address.
 */
async function visitor(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": `10.6.0.${++visitors}` },
  })
  contexts.push(context)
  const page = await context.newPage()
  await page.goto("/")
  await expect(page.getByRole("status")).toContainText("ready")
  return page
}

async function post(page: Page, title: string, topic: string): Promise<void> {
  await page.getByLabel("Title").fill(title)
  await page.getByLabel("Topic").selectOption({ label: topic })
  await page.getByRole("button", { name: "Post" }).click()
}

const rows = (page: Page) => page.getByRole("listitem")

test("posts through GraphQL show their topic and reach other visitors live", async ({
  browser,
}) => {
  const ann = await visitor(browser)
  const ben = await visitor(browser)
  await expect(ann.getByLabel("Topic").locator("option")).toHaveText(["Help", "Ideas", "News"])

  await post(ann, "First post", "Ideas")
  await expect(rows(ann)).toHaveCount(1)
  await expect(rows(ann).first().locator(".title")).toHaveText("First post")
  await expect(rows(ann).first().locator(".topic")).toHaveText("Ideas")
  await expect(rows(ben)).toHaveCount(1)
  await expect(rows(ben).first().locator(".topic")).toHaveText("Ideas")

  await post(ben, "Second post", "Help")
  await expect(ann.locator(".title")).toHaveText(["Second post", "First post"])
  await expect(ann.locator(".topic")).toHaveText(["Help", "Ideas"])

  const stored = await mongo?.db(database()).collection("posts").find().toArray()
  expect(stored?.map((doc) => doc["title"]).sort()).toEqual(["First post", "Second post"])
})

test("only the author can delete a post, and the delete reaches everyone", async ({ browser }) => {
  const ann = await visitor(browser)
  const ben = await visitor(browser)
  await post(ann, "Ann's post", "News")
  await expect(rows(ben)).toHaveCount(1)
  await expect(rows(ben).getByRole("button", { name: "Delete" })).toHaveCount(0)
  await rows(ann).getByRole("button", { name: "Delete" }).click()
  await expect(rows(ann)).toHaveCount(0)
  await expect(rows(ben)).toHaveCount(0)
})
