import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test"
import { MongoClient } from "mongodb"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]

test.skip(uri === undefined, "needs a MongoDB replica set in CANOPY_TEST_MONGODB_URI")

let mongo: MongoClient | undefined
const contexts: BrowserContext[] = []
const run = Date.now().toString(36)

const database = (): string => (test.info().config.metadata as { database: string }).database

test.beforeAll(async () => {
  mongo = new MongoClient(uri ?? "")
  await mongo.connect()
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

async function open(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  contexts.push(context)
  const page = await context.newPage()
  await page.goto("/")
  return page
}

async function submit(page: Page, email: string, password: string, action: string): Promise<void> {
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: action }).click()
}

async function addNote(page: Page, text: string): Promise<void> {
  await page.getByLabel("New note").fill(text)
  await page.getByRole("button", { name: "Add" }).click()
}

const notes = (page: Page) => page.locator("#notes li span")

test("signs up, keeps notes private per user, and updates other tabs live", async ({ browser }) => {
  const ann = `ann-${run}@example.com`
  const ben = `ben-${run}@example.com`
  const annPage = await open(browser)
  await submit(annPage, ann, "ann password 123", "Create account")
  await expect(annPage.locator("#user-email")).toHaveText(ann)
  await addNote(annPage, "Buy milk")
  await expect(notes(annPage)).toHaveText(["Buy milk"])

  const annSecondTab = await annPage.context().newPage()
  await annSecondTab.goto("/")
  await expect(annSecondTab.locator("#user-email")).toHaveText(ann)
  await expect(notes(annSecondTab)).toHaveText(["Buy milk"])

  const benPage = await open(browser)
  await submit(benPage, ben, "ben password 123", "Create account")
  await expect(benPage.locator("#status")).toHaveText("0 notes")
  await addNote(benPage, "Ben's plan")
  await expect(notes(benPage)).toHaveText(["Ben's plan"])

  await addNote(annPage, "Call Sam")
  await expect(notes(annSecondTab)).toHaveText(["Call Sam", "Buy milk"])
  await expect(notes(benPage)).toHaveText(["Ben's plan"])

  const stored = await mongo?.db(database()).collection("notes").find().toArray()
  expect(stored?.map((note) => note["text"]).sort()).toEqual(["Ben's plan", "Buy milk", "Call Sam"])

  await annSecondTab
    .getByRole("listitem")
    .filter({ hasText: "Buy milk" })
    .getByRole("button")
    .click()
  await expect(notes(annPage)).toHaveText(["Call Sam"])
})

test("signs out and back in, and reports a wrong password", async ({ browser }) => {
  const email = `cat-${run}@example.com`
  const page = await open(browser)
  await submit(page, email, "cat password 123", "Create account")
  await addNote(page, "Remember me")
  await expect(notes(page)).toHaveText(["Remember me"])

  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expect(page.locator("#notes li")).toHaveCount(0)

  await submit(page, email, "not the password", "Sign in")
  await expect(page.getByRole("alert")).not.toBeEmpty()
  await expect(page.locator("#signed-in")).toBeHidden()

  await submit(page, email, "cat password 123", "Sign in")
  await expect(notes(page)).toHaveText(["Remember me"])
  await page.reload()
  await expect(notes(page)).toHaveText(["Remember me"])
})
