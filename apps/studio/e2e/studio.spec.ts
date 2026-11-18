import {
  enabled,
  expect,
  expectNoCspViolations,
  freshCode,
  OWNER,
  setupToken,
  test,
  withMongo,
} from "./harness.ts"

test.describe.configure({ mode: "serial" })
test.skip(!enabled, "needs CANOPY_TEST_MONGODB_URI")

let totpSecret = ""

test.afterEach(async ({ studio }) => {
  await expectNoCspViolations(studio)
})

test("claims the server with the setup token and enrolls the owner's authenticator", async ({
  studio: page,
}) => {
  await page.goto("/studio/")
  await page.getByRole("link", { name: "Claim it with the setup token" }).click()
  await expect(page.getByRole("heading", { name: "Claim this server" })).toBeVisible()
  await page.getByLabel("Setup token").fill("canopy_setup_wrong")
  await page.getByLabel("Owner email").fill(OWNER.email)
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password)
  await page.getByLabel("Confirm password").fill(OWNER.password)
  await page.getByRole("button", { name: "Claim and create the owner" }).click()
  await expect(page.getByRole("alert").filter({ hasText: /setup token/i })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toHaveCount(0)

  await page.getByLabel("Setup token").fill(setupToken())
  await page.getByRole("button", { name: "Claim and create the owner" }).click()
  const secret = page.locator("#totp-enrollment-title ~ div code")
  await expect(secret).toBeVisible()
  totpSecret = (await secret.textContent()) ?? ""
  expect(totpSecret).toMatch(/^[A-Z2-7]{16,}$/)
  await page.getByLabel("Authenticator code").fill(await freshCode(totpSecret))
  await page.getByRole("button", { name: "Verify and sign in" }).click()
  await expect(page.getByRole("heading", { name: "Check the deployment" })).toBeVisible()
})

test("walks the rest of the first run wizard: doctor, a starter policy and the publishable key", async ({
  studio: page,
}) => {
  await page.getByRole("button", { name: "Next" }).click()
  await expect(page.getByRole("heading", { name: "Expose collections" })).toBeVisible()
  await page.getByLabel("Expose todos").check()
  await page.getByRole("button", { name: "Expose and publish" }).click()
  await expect(page.getByRole("heading", { name: "Connect your app" })).toBeVisible()
  const key = page.getByRole("textbox", { name: "Publishable key" })
  await expect(key).toHaveValue(/^canopy_pk_/)
  await page
    .getByRole("link", { name: "Open Studio" })
    .or(page.getByRole("button", { name: "Open Studio" }))
    .click()
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible()
})

test("signs the owner out and back in with an authenticator code", async ({ studio: page }) => {
  await page.getByRole("button", { name: "Account" }).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Sign in to Canopy Studio" })).toBeVisible()
  await page.getByLabel("Email").fill(OWNER.email)
  await page.getByLabel("Password").fill(OWNER.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  const code = page.getByLabel("Authenticator code")
  await expect(code).toBeFocused()
  await code.fill("000000")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("alert").filter({ hasText: /./ })).toBeVisible()
  await code.fill(await freshCode(totpSecret))
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible()
})

test("publishes a policy change with a comment and lists it in the history", async ({
  studio: page,
}) => {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Policies" })
    .click()
  await page.getByRole("link", { name: "Edit policies of todos" }).click()
  await expect(page.getByTestId("draft-status")).toContainText("Matches published version 1")
  await page.getByLabel("Start from a template").selectOption("public-read")
  await page.getByRole("button", { name: "Apply template" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Apply template" }).click()
  await expect(page.getByTestId("draft-status")).toContainText("Draft (unpublished)")
  await page.getByRole("button", { name: "Publish", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Publish policies of todos" })
  await expect(dialog.getByText("Version 2 becomes active")).toBeVisible()
  await dialog.getByLabel("Comment").fill("Public read for the e2e run")
  await dialog.getByRole("button", { name: "Publish" }).click()
  await expect(page.getByText("Published version 2", { exact: true })).toBeVisible()
  await expect(page.getByTestId("draft-status")).toContainText("Matches published version 2")
  await expect(
    page.getByTestId("policy-history").getByText("Public read for the e2e run"),
  ).toBeVisible()
})

test("simulates the draft as a user and as anonymous against the real documents", async ({
  studio: page,
}) => {
  await page.getByLabel("Start from a template").selectOption("owner-only")
  await page.getByRole("button", { name: "Apply template" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Apply template" }).click()
  const simulator = page.getByRole("region", { name: "Simulator" })
  await simulator.getByLabel("Subject (sub)").fill("user_alice")
  await simulator.getByRole("button", { name: "Simulate" }).click()
  await expect(simulator.getByText("Allowed")).toBeVisible()
  await expect(simulator.getByText("2 documents")).toBeVisible()
  await simulator.getByLabel("Anonymous").check()
  await simulator.getByRole("button", { name: "Simulate" }).click()
  await expect(simulator.getByText("Denied")).toBeVisible()
  await page.getByRole("button", { name: "Publish", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Publish policies of todos" })
  await dialog.getByLabel("Comment").fill("Back to owner only")
  await dialog.getByRole("button", { name: "Publish" }).click()
  await expect(page.getByTestId("draft-status")).toContainText("Matches published version 3")
})

test("browses the documents of a collection and edits one as the service role", async ({
  studio: page,
}) => {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Data" })
    .click()
  await page.getByRole("link", { name: "Browse documents of todos" }).click()
  const grid = page.getByRole("table", { name: "Documents of todos" })
  await expect(grid.getByRole("row")).toHaveCount(4)
  await expect(grid).toContainText("Walk the dog")
  await page.getByRole("button", { name: /Edit document .*todo_1/ }).click()
  const dialog = page.getByRole("dialog")
  const editor = dialog.getByRole("textbox", { name: "Document as EJSON" })
  await expect(editor).toContainText("Buy milk")
  await editor.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.insertText(
    JSON.stringify({ _id: "todo_1", title: "Buy oat milk", ownerId: "user_alice", done: true }),
  )
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Document updated")).toBeVisible()
  await expect(grid).toContainText("Buy oat milk")
  const stored = await withMongo((db) =>
    db.collection<{ _id: string }>("todos").findOne({ _id: "todo_1" }),
  )
  expect(stored).toEqual({
    _id: "todo_1",
    title: "Buy oat milk",
    ownerId: "user_alice",
    done: true,
  })
  const audit = await withMongo(
    (db) => db.collection("audit_log").findOne({ action: "documents.replace" }),
    "_meta",
  )
  expect(audit?.["target"]).toEqual({ collection: "todos", ids: ["todo_1"] })
  expect(audit?.["diff"]).toMatchObject({
    before: { title: "Buy milk" },
    after: { title: "Buy oat milk" },
  })
})

test("views the data as a signed in user, through the published policies", async ({
  studio: page,
}) => {
  await page.getByRole("button", { name: "View as" }).click()
  const dialog = page.getByRole("dialog", { name: "View data as" })
  await dialog.getByLabel("Signed in user").check()
  await dialog.getByLabel("Subject (sub claim)").fill("user_bob")
  await dialog.getByRole("button", { name: "View as" }).click()
  await expect(page.getByText(/Viewing as .*user_bob/)).toBeVisible()
  const grid = page.getByRole("table", { name: "Documents of todos" })
  await expect(grid.getByRole("row")).toHaveCount(2)
  await expect(grid).toContainText("File taxes")
  await expect(grid).not.toContainText("Buy oat milk")
  await expect(page.getByRole("button", { name: /Edit document/ })).toHaveCount(0)
  await page.getByRole("button", { name: "Stop viewing as" }).click()
  await expect(grid.getByRole("row")).toHaveCount(4)
  const audit = await withMongo(
    (db) => db.collection("audit_log").findOne({ action: "documents.viewAs" }),
    "_meta",
  )
  expect(audit?.["details"]).toMatchObject({ as: { claims: { sub: "user_bob" } } })
})

test("creates a secret API key and revokes it, after which REST refuses it", async ({
  studio: page,
  request,
}) => {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "API" })
    .click()
  await page.getByRole("button", { name: "Create key" }).click()
  const create = page.getByRole("dialog", { name: "Create an API key" })
  await create.getByLabel("Name").fill("CI server")
  await create.getByLabel(/^Secret/).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()
  const shown = page.getByRole("dialog", { name: "Copy your new secret key" })
  const key = await shown.getByRole("textbox", { name: "Key value" }).inputValue()
  expect(key).toMatch(/^canopy_sk_/)
  await shown.getByRole("button", { name: "I stored the key" }).click()

  const read = () => request.get("/rest/v1/todos", { headers: { apikey: key } })
  const before = await read()
  expect(before.status()).toBe(200)
  expect(((await before.json()) as { data: unknown[] }).data).toHaveLength(3)

  await page.getByRole("button", { name: "Revoke CI server" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Revoke CI server" }).click()
  await expect(page.getByText("CI server was revoked")).toBeVisible()
  await expect(page.getByRole("row", { name: /CI server/ })).toContainText("Revoked")
  await expect.poll(async () => (await read()).status()).toBe(403)
})

test("bans an app user, who can no longer sign in", async ({ studio: page, request }) => {
  const email = "carol@studio.test"
  const password = "carol password 12345"
  const origin = new URL(page.url()).origin
  const signUp = await request.post("/auth/v1/sign-up/email", {
    headers: { origin },
    data: { email, password, name: "Carol" },
  })
  expect(signUp.status()).toBe(200)
  const signIn = () =>
    request.post("/auth/v1/sign-in/email", { headers: { origin }, data: { email, password } })
  expect((await signIn()).status()).toBe(200)

  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Auth" })
    .click()
  await page.getByRole("button", { name: `Details for ${email}` }).click()
  await page.getByRole("button", { name: "Ban", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `Ban ${email}?` })
  await dialog.getByLabel("Reason").fill("Spam from the e2e run")
  await dialog.getByRole("button", { name: "Ban" }).click()
  await expect(page.getByText(`${email} is banned`)).toBeVisible()
  await expect(page.getByText("Reason: Spam from the e2e run")).toBeVisible()

  const refused = await signIn()
  expect(refused.status()).toBe(403)
  const user = await withMongo((db) => db.collection("users").findOne({ email }), "_auth")
  expect(user?.["banned"]).toBe(true)
})
