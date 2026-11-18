import { expect, test } from "@playwright/test"
import { MongoClient } from "mongodb"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]

test.skip(uri === undefined, "needs a MongoDB replica set in CANOPY_TEST_MONGODB_URI")

let mongo: MongoClient | undefined

const articles = () => {
  const { database } = test.info().config.metadata as { database: string }
  if (mongo === undefined) throw new Error("not connected")
  return mongo.db(database).collection<{
    _id: string
    title: string
    published: boolean
    publishedAt: Date
  }>("articles")
}

test.beforeAll(async () => {
  mongo = new MongoClient(uri ?? "")
  await mongo.connect()
})

test.beforeEach(async () => {
  await articles().deleteMany({})
  await articles().insertMany([
    { _id: "a1", title: "Older story", published: true, publishedAt: new Date("2026-01-01") },
    { _id: "a2", title: "Newer story", published: true, publishedAt: new Date("2026-02-01") },
    {
      _id: "d1",
      title: "Unpublished draft",
      published: false,
      publishedAt: new Date("2026-03-01"),
    },
  ])
})

test.afterAll(async () => {
  if (mongo !== undefined) {
    const { database } = test.info().config.metadata as { database: string }
    for (const suffix of ["", "_meta"]) await mongo.db(`${database}${suffix}`).dropDatabase()
  }
  await mongo?.close()
})

test("the server renders the published articles into the HTML", async ({ request }) => {
  const html = await (await request.get("/")).text()
  expect(html).toContain("Newer story")
  expect(html).toContain("Older story")
  expect(html).not.toContain("Unpublished draft")
  expect(html.indexOf("Newer story")).toBeLessThan(html.indexOf("Older story"))
  expect(html).toContain('data-query="stale"')
})

test("the page hydrates the server's result and then follows it live", async ({ page }) => {
  await page.goto("/")
  const items = page.getByRole("listitem")
  await expect(items).toHaveText(["Newer story", "Older story"])
  await expect(page.getByRole("status")).toHaveAttribute("data-query", "ready")

  await articles().insertOne({
    _id: "a3",
    title: "Breaking news",
    published: true,
    publishedAt: new Date("2026-04-01"),
  })
  await expect(items).toHaveText(["Breaking news", "Newer story", "Older story"])

  await articles().insertOne({
    _id: "d2",
    title: "Another draft",
    published: false,
    publishedAt: new Date("2026-05-01"),
  })
  await articles().updateOne({ _id: "a1" }, { $set: { published: false } })
  await expect(items).toHaveText(["Breaking news", "Newer story"])
  await articles().updateOne({ _id: "d1" }, { $set: { published: true } })
  await expect(items).toHaveText(["Breaking news", "Unpublished draft", "Newer story"])
})
