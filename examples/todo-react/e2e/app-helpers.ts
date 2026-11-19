import { type BrowserContext, expect, type Page } from "@playwright/test"

/** Opens the running todo app as a demo user. */
export async function openAs(context: BrowserContext, user: string, base?: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${base ?? ""}/?user=${user}`)
  await expect(page.getByTestId("status")).toHaveText(base === undefined ? "live" : "fallback")
  await expect(page.getByTestId("query-status")).toHaveText("ready")
  return page
}

/** Adds a todo through the app. */
export async function add(page: Page, title: string, shared = true): Promise<void> {
  const box = page.getByRole("checkbox", { name: "Shared" })
  if ((await box.isChecked()) !== shared) await box.click()
  await page.getByLabel("New todo").fill(title)
  await page.getByRole("button", { name: "Add" }).click()
}
