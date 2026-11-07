import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { previewTemplate } from "../src/features/auth/page.tsx"
import { renderStudio, screen } from "./harness.tsx"

const lastDialog = () => {
  const dialogs = screen.getAllByRole("dialog")
  const dialog = dialogs.at(-1)
  if (dialog === undefined) throw new Error("no dialog open")
  return within(dialog)
}

describe("Auth users", () => {
  it("lists app users and narrows them with the search", async () => {
    const { user } = await renderStudio("/auth")
    expect(
      await screen.findByRole("button", { name: "Details for alice@example.com" }),
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Details for carol@example.com" })).toBeTruthy()
    await user.type(screen.getByLabelText("Search users"), "bob")
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Details for alice@example.com" })).toBeNull(),
    )
    expect(screen.getByRole("button", { name: "Details for bob@example.com" })).toBeTruthy()
  })

  it("bans a user, and the ban reaches the server and the audit log", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("button", { name: "Details for alice@example.com" }))
    await user.click(lastDialog().getByRole("button", { name: "Ban" }))
    await waitFor(() => expect(mock.state.users.find((u) => u.id === "u_alice")?.banned).toBe(true))
    expect(
      mock.state.audit.some((entry) => entry.action === "user.ban" && entry.target === "u_alice"),
    ).toBe(true)
    expect(await lastDialog().findByRole("button", { name: "Unban" })).toBeTruthy()
  })

  it("signs a user out everywhere after confirmation", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("button", { name: "Details for alice@example.com" }))
    await user.click(lastDialog().getByRole("button", { name: "Sign out everywhere" }))
    expect(mock.state.users.find((u) => u.id === "u_alice")?.sessions?.length).toBe(1)
    await user.click(lastDialog().getByRole("button", { name: "Sign out everywhere" }))
    await waitFor(() =>
      expect(mock.state.users.find((u) => u.id === "u_alice")?.sessions).toEqual([]),
    )
    expect(mock.state.audit.some((entry) => entry.action === "user.revoke_sessions")).toBe(true)
  })

  it("deletes a user only after confirmation", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("button", { name: "Details for bob@example.com" }))
    await user.click(lastDialog().getByRole("button", { name: "Delete user" }))
    expect(mock.state.users.some((u) => u.id === "u_bob")).toBe(true)
    expect(lastDialog().getByText("Delete bob@example.com?")).toBeTruthy()
    await user.click(lastDialog().getByRole("button", { name: "Delete user" }))
    await waitFor(() => expect(mock.state.users.some((u) => u.id === "u_bob")).toBe(false))
    expect(
      mock.state.audit.some((entry) => entry.action === "user.delete" && entry.target === "u_bob"),
    ).toBe(true)
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Details for bob@example.com" })).toBeNull(),
    )
  })

  it("views data as a user, landing on Data with the impersonation banner", async () => {
    const { user, router } = await renderStudio("/auth")
    await user.click(await screen.findByRole("button", { name: "Details for alice@example.com" }))
    await user.click(lastDialog().getByRole("button", { name: "View data as this user" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/data"))
    expect(await screen.findByText("Viewing as alice@example.com")).toBeTruthy()
  })

  it("hides user management from viewers", async () => {
    const viewer = {
      id: "adm_v",
      email: "viewer@example.com",
      role: "viewer" as const,
      password: "a long password 1",
    }
    const { user } = await renderStudio("/auth", { admins: [viewer] })
    await user.click(await screen.findByRole("button", { name: "Details for alice@example.com" }))
    expect(lastDialog().queryByRole("button", { name: "Ban" })).toBeNull()
    expect(lastDialog().getByText("Your role can view users but not change them.")).toBeTruthy()
  })

  it("explains that app user endpoints are not available yet when the server answers 404", async () => {
    const { user } = await renderStudio("/auth", { appUsers: false })
    expect(await screen.findByText("Not available on this server yet")).toBeTruthy()
    expect(screen.queryByText(/Something went wrong/)).toBeNull()
    await user.click(screen.getByRole("tab", { name: "Signing keys" }))
    expect(await screen.findByText(/does not provide signing key management/)).toBeTruthy()
  })
})

describe("Auth configuration", () => {
  it("rotates the signing key after confirmation and audits it", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("tab", { name: "Signing keys" }))
    expect(await screen.findByText("k_2026_10")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Rotate signing key" }))
    await user.click(lastDialog().getByRole("button", { name: "Rotate signing key" }))
    await waitFor(() =>
      expect(mock.state.audit.some((entry) => entry.action === "auth.rotate_signing_key")).toBe(
        true,
      ),
    )
  })

  it("shows providers and previews templates with test data", async () => {
    const { user } = await renderStudio("/auth")
    await user.click(await screen.findByRole("tab", { name: "Providers" }))
    expect(await screen.findByText("1234.apps.googleusercontent.com")).toBeTruthy()
    await user.click(screen.getByRole("tab", { name: "Email templates" }))
    const preview = await screen.findByTestId("template-preview")
    expect(preview.textContent).toBe(
      "Hi Alice, confirm with https://app.example.com/verify?token=sample.",
    )
    expect(previewTemplate("{{ unknown }} {{name}}")).toBe("{{ unknown }} Alice")
  })

  it("lists only auth and user events in the auth audit", async () => {
    const { user, api } = await renderStudio("/auth")
    await api.updateUser("u_carol", { banned: false })
    await api.updateCollection("todos", { exposed: true })
    await user.click(await screen.findByRole("tab", { name: "Auth audit" }))
    expect(await screen.findByText("user.update")).toBeTruthy()
    expect(screen.queryByText("collection.update")).toBeNull()
    expect(screen.queryByText("admin.login")).toBeNull()
  })
})
