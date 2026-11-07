import {
  enabled,
  expect,
  expectNoCspViolations,
  freshCode,
  OWNER,
  setupToken,
  test,
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
