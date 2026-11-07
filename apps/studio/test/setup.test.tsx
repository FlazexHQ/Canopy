import { waitFor, within } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { sdkSnippet } from "../src/features/setup/wizard.tsx"
import { renderStudio, screen } from "./harness.tsx"

const TOKEN = "canopy-setup-0000"

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto["hasPointerCapture"] ??= () => false
  proto["releasePointerCapture"] ??= () => {}
  proto["scrollIntoView"] ??= () => {}
})

async function fillClaim(
  user: Awaited<ReturnType<typeof renderStudio>>["user"],
  values: { token: string; password: string; confirm?: string },
) {
  await user.type(await screen.findByLabelText("Setup token"), values.token)
  await user.type(screen.getByLabelText("Owner email"), "first@example.com")
  await user.type(screen.getByLabelText("Password"), values.password)
  await user.type(screen.getByLabelText("Confirm password"), values.confirm ?? values.password)
  await user.click(screen.getByRole("button", { name: "Claim and create the owner" }))
}

describe("first run setup", () => {
  it("refuses a wrong setup token and creates no admin", async () => {
    const { user, mock } = await renderStudio("/setup", { admins: [], signedInAs: false })
    await fillClaim(user, { token: "guess", password: "long enough password" })
    expect(await screen.findByText("The setup token is wrong")).toBeTruthy()
    expect(mock.state.admins).toHaveLength(0)
  })

  it("rejects a short password before calling the server", async () => {
    const { user, mock } = await renderStudio("/setup", { admins: [], signedInAs: false })
    await fillClaim(user, { token: TOKEN, password: "short" })
    expect(await screen.findByText("The password needs at least 12 characters.")).toBeTruthy()
    expect(mock.state.admins).toHaveLength(0)
    expect(mock.state.audit).toHaveLength(0)
  })

  it("rejects mismatched passwords", async () => {
    const { user, mock } = await renderStudio("/setup", { admins: [], signedInAs: false })
    await fillClaim(user, {
      token: TOKEN,
      password: "long enough password",
      confirm: "long enough passwort",
    })
    expect(await screen.findByText("The passwords do not match.")).toBeTruthy()
    expect(mock.state.admins).toHaveLength(0)
  })

  it("claims the owner, runs the doctor, publishes starter policies and shows the key", async () => {
    const { user, mock, router } = await renderStudio("/setup", { admins: [], signedInAs: false })
    await fillClaim(user, { token: TOKEN, password: "long enough password" })

    expect(await screen.findByRole("heading", { name: "Check the deployment" })).toBeTruthy()
    expect(mock.state.admins.map((admin) => [admin.email, admin.role])).toEqual([
      ["first@example.com", "owner"],
    ])
    expect(document.activeElement?.textContent).toBe("Check the deployment")
    expect(screen.getByText("The oplog covers 6 hours of writes")).toBeTruthy()
    const current = document.querySelector('[aria-current="step"]')
    expect(current?.textContent).toContain("Check the deployment")
    await user.click(screen.getByRole("button", { name: "Next" }))

    expect(await screen.findByRole("heading", { name: "Expose collections" })).toBeTruthy()
    const publish = screen.getByRole("button", { name: "Expose and publish" })
    expect((publish as HTMLButtonElement).disabled).toBe(true)
    await user.click(await screen.findByRole("checkbox", { name: "Expose todos" }))
    await user.click(screen.getByRole("checkbox", { name: "Expose notes" }))
    const notesTemplate = screen.getByRole("combobox", { name: "Starter policy for notes" })
    await user.click(notesTemplate)
    await user.click(await screen.findByRole("option", { name: "Public read / owner write" }))
    await user.click(publish)

    expect(await screen.findByRole("heading", { name: "Connect your app" })).toBeTruthy()
    const todos = mock.state.published.get("todos")
    const notes = mock.state.published.get("notes")
    expect(todos?.version).toBe(1)
    expect(todos?.exposed).toBe(true)
    expect(todos?.policies.map((policy) => policy.name)).toEqual([
      "read own",
      "create own",
      "edit own",
      "delete own",
    ])
    expect(notes?.policies[0]).toMatchObject({ name: "anyone reads", roles: ["public"] })
    expect(mock.state.published.has("orders")).toBe(false)
    expect(mock.state.collections.get("todos")?.exposed).toBe(true)
    expect(mock.state.history.get("todos")?.[0]?.comment).toBe(
      "Starter template from the setup wizard",
    )

    const key = (await screen.findByLabelText("Publishable key")) as HTMLInputElement
    expect(key.value).toBe("canopy_pk_8f2KQmTfE1c9xZ0aW3bYdL5nR7sVuH2j")
    const snippet = screen.getByText((_, element) => element?.tagName === "CODE")
    expect(snippet.textContent).toContain(
      'publishableKey: "canopy_pk_8f2KQmTfE1c9xZ0aW3bYdL5nR7sVuH2j"',
    )
    expect(snippet.textContent).toContain('canopy.from("todos")')

    await user.click(screen.getByRole("button", { name: "Open Studio" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
  })

  it("creates a publishable key when none is usable", async () => {
    const { user, mock } = await renderStudio("/setup", { admins: [], signedInAs: false })
    for (const key of mock.state.apiKeys)
      if (key.kind === "publishable") Object.assign(key, { revokedAt: "2026-11-01T00:00:00Z" })
    await fillClaim(user, { token: TOKEN, password: "long enough password" })
    await user.click(await screen.findByRole("button", { name: "Next" }))
    await user.click(await screen.findByRole("button", { name: "Skip for now" }))
    const key = (await screen.findByLabelText("Publishable key")) as HTMLInputElement
    await waitFor(() => expect(key.value).toMatch(/^canopy_pk_/))
    const created = mock.state.apiKeys.filter(
      (entry) => entry.name === "Default publishable key" && entry.revokedAt === null,
    )
    expect(created).toHaveLength(1)
    expect(created[0]?.key).toBe(key.value)
    expect(within(document.body).queryByText(/canopy\.from/)).toBeNull()
  })

  it("sends a claimed instance to the login", async () => {
    const { router } = await renderStudio("/setup", { signedInAs: false })
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"))
  })

  it("builds the SDK snippet with the url, the key and a first collection", () => {
    expect(sdkSnippet("https://api.example.com", "canopy_pk_x", "todos")).toBe(
      [
        'import { createClient } from "@canopy/client"',
        "",
        "const canopy = createClient({",
        '  url: "https://api.example.com",',
        '  publishableKey: "canopy_pk_x",',
        "})",
        "",
        'const query = canopy.from("todos").find({}).limit(20)',
        "query.subscribe((state) => console.log(state.status, state.data))",
        "",
      ].join("\n"),
    )
    expect(sdkSnippet("u", "k", undefined)).not.toContain("from(")
  })
})
