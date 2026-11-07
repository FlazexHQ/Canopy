import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { templateDraft } from "../src/features/policies/model.ts"
import { renderStudio, screen } from "./harness.tsx"

const ownerOnly = templateDraft("todos", "owner-only")

async function openPublishDialog(user: Awaited<ReturnType<typeof renderStudio>>["user"]) {
  await user.click(await screen.findByRole("switch", { name: "Realtime subscriptions" }))
  const footer = screen.getAllByRole("button", { name: "Publish" })
  await user.click(footer[footer.length - 1] as HTMLElement)
  return screen.findByRole("dialog")
}

describe("policies index", () => {
  it("lists collections with their published version", async () => {
    await renderStudio("/policies", { policies: [ownerOnly] })
    const todos = await screen.findByRole("link", { name: "Edit policies of todos" })
    const row = todos.closest("tr") as HTMLElement
    expect(within(row).getByText("v1")).toBeTruthy()
    expect(within(row).getByText("4")).toBeTruthy()
    const notes = screen
      .getByRole("link", { name: "Edit policies of notes" })
      .closest("tr") as HTMLElement
    expect(within(notes).getByText("Not published")).toBeTruthy()
  })
})

describe("policy editor", () => {
  it("keeps the TS view in sync with the form and marks the draft", async () => {
    const { user } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    expect(await screen.findByText("Matches published version 1")).toBeTruthy()
    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "read mine")
    expect(
      screen.getByText("Draft (unpublished)", { selector: "[data-testid=draft-status] *" }),
    ).toBeTruthy()
    await user.click(screen.getByRole("tab", { name: "TS" }))
    const dsl = (await screen.findByTestId("policy-dsl")).textContent ?? ""
    expect(dsl).toContain('allow.read("authenticated")')
    expect(dsl).toContain('.named("read mine")')
    expect(dsl).not.toContain('.named("read own")')
    expect(localStorage.getItem("canopy-studio-policy-draft:todos")).toContain("read mine")
  })

  it("flags a public insert policy without a check", async () => {
    const { user } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    await user.click(await screen.findByRole("button", { name: "Add policy" }))
    const roles = screen.getByLabelText("Roles")
    await user.clear(roles)
    await user.type(roles, "public")
    await user.click(screen.getByRole("checkbox", { name: "insert" }))
    const lint = screen.getByTestId("lint-panel")
    await waitFor(() => expect(lint.querySelector('[data-rule="public-allow-all"]')).not.toBeNull())
    expect(lint.querySelector('[data-rule="public-allow-all"]')?.textContent).toContain("error")
  })

  it("simulates the draft as different identities with an explain trace", async () => {
    const { user } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    const simulate = await screen.findByRole("button", { name: "Simulate" })
    await user.click(simulate)
    const trace = await screen.findByTestId("simulation-trace")
    expect(trace.textContent).toContain("read own")
    expect(trace.textContent).toContain("variable $auth:sub is missing or null")
    expect(screen.getByTestId("simulation-count").textContent).toBe("0 documents")

    await user.type(screen.getByLabelText("Subject (sub)"), "u_alice")
    await user.click(simulate)
    await waitFor(() =>
      expect(screen.getByTestId("simulation-count").textContent).toBe("8 documents"),
    )
    expect(screen.getByTestId("simulation-result").textContent).toContain("Allowed")
    expect(screen.getByTestId("simulation-result").textContent).toContain('"u_alice"')

    await user.click(screen.getByRole("radio", { name: "Anonymous" }))
    await user.click(simulate)
    await waitFor(() =>
      expect(screen.getByTestId("simulation-result").textContent).toContain("Denied"),
    )
    expect(screen.getByTestId("simulation-trace").textContent).toContain(
      "not granted to roles anon",
    )
  })

  it("turns a simulator case into a policy test", async () => {
    const { user } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    await user.type(await screen.findByLabelText("Subject (sub)"), "u_alice")
    await user.click(screen.getByRole("button", { name: "Simulate" }))
    await screen.findByText("8 documents")
    await user.click(screen.getByRole("button", { name: "Save as test" }))
    const dialog = await screen.findByRole("dialog")
    const code = dialog.querySelector("code")?.textContent ?? ""
    expect(code).toContain('describePolicies("todos"')
    expect(code).toContain('const actor = as.user({"sub":"u_alice"})')
    expect(code).toContain("expect(actor).can.read(doc(")
  })

  it("publishes the draft with a comment as the next version", async () => {
    const { user, mock } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    const dialog = await openPublishDialog(user)
    await user.type(within(dialog).getByLabelText(/Comment/), "Disable realtime")
    await user.click(within(dialog).getByRole("button", { name: "Publish" }))
    await screen.findByText("Matches published version 2")
    expect(mock.state.published.get("todos")?.version).toBe(2)
    expect(mock.state.published.get("todos")?.realtime).toBe(false)
    expect(mock.state.history.get("todos")?.[0]?.comment).toBe("Disable realtime")
    expect(localStorage.getItem("canopy-studio-policy-draft:todos")).toBeNull()
  })

  it("requires a comment to publish in production", async () => {
    const { user, mock } = await renderStudio("/policies/todos", {
      policies: [ownerOnly],
      environment: "production",
    })
    const dialog = await openPublishDialog(user)
    const confirm = within(dialog).getByRole("button", { name: "Publish" }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByText("Production needs a comment for every publish.")).toBeTruthy()
    await user.type(within(dialog).getByLabelText(/Comment/), "Ticket 42")
    expect(confirm.disabled).toBe(false)
    await user.click(confirm)
    await waitFor(() => expect(mock.state.published.get("todos")?.version).toBe(2))
  })

  it("shows a conflict when someone else published first and lets the draft be published on top", async () => {
    const { user, api, mock } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    await screen.findByText("Matches published version 1")
    await api.publish("todos", {
      draft: templateDraft("todos", "public-read"),
      expectedVersion: 1,
      comment: "elsewhere",
    })
    const dialog = await openPublishDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Publish" }))
    expect(await screen.findByText("Someone else published first")).toBeTruthy()
    expect(mock.state.published.get("todos")?.version).toBe(2)
    await user.click(screen.getByRole("button", { name: "Keep my draft and compare" }))
    expect(await screen.findByTestId("policy-diff")).toBeTruthy()
    const footer = screen.getAllByRole("button", { name: "Publish" })
    await user.click(footer[footer.length - 1] as HTMLElement)
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish" }),
    )
    await waitFor(() => expect(mock.state.published.get("todos")?.version).toBe(3))
    expect(mock.state.published.get("todos")?.policies.map((policy) => policy.name)).toContain(
      "read own",
    )
  })

  it("rolls back to an older version by publishing it again", async () => {
    const { user, mock } = await renderStudio("/policies/todos", { policies: [ownerOnly] })
    const dialog = await openPublishDialog(user)
    await user.click(within(dialog).getByRole("button", { name: "Publish" }))
    await screen.findByText("Matches published version 2")
    const history = await screen.findByTestId("policy-history")
    await waitFor(() => expect(within(history).getAllByRole("listitem")).toHaveLength(2))
    await user.click(within(history).getByRole("button", { name: "Roll back" }))
    const confirm = await screen.findByRole("dialog")
    expect(within(confirm).getByText("Roll back to version 1")).toBeTruthy()
    await user.click(within(confirm).getByRole("button", { name: "Roll back" }))
    await waitFor(() => expect(mock.state.published.get("todos")?.version).toBe(3))
    expect(mock.state.published.get("todos")?.realtime).toBe(true)
    expect(mock.state.audit.some((entry) => entry.action === "policy.rollback")).toBe(true)
  })

  it("does not let a developer publish in production", async () => {
    const developer = {
      id: "adm_dev",
      email: "dev@example.com",
      role: "developer" as const,
      password: "correct horse battery",
    }
    await renderStudio("/policies/todos", {
      policies: [ownerOnly],
      environment: "production",
      admins: [developer],
    })
    expect(await screen.findByText("Your role cannot publish policies here.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull()
  })
})
