import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { isOrigin } from "../src/features/settings/page.tsx"
import { renderStudio, screen } from "./harness.tsx"

const lastDialog = () => {
  const dialog = screen.getAllByRole("dialog").at(-1)
  if (dialog === undefined) throw new Error("no dialog open")
  return within(dialog)
}

const admin = {
  id: "adm_a",
  email: "admin@example.com",
  role: "admin" as const,
  password: "a long password 1",
}
const viewer = {
  id: "adm_v",
  email: "viewer@example.com",
  role: "viewer" as const,
  password: "a long password 1",
}

describe("Settings", () => {
  it("adds a CORS origin and saves it on the server", async () => {
    const { user, mock } = await renderStudio("/settings")
    await user.type(await screen.findByLabelText("New origin"), "https://app.example.com/")
    await user.click(screen.getByRole("button", { name: "Add origin" }))
    expect(screen.getByText("https://app.example.com")).toBeTruthy()
    expect(mock.state.settings.corsOrigins).toEqual(["http://localhost:5173"])
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mock.state.settings.corsOrigins).toEqual([
        "http://localhost:5173",
        "https://app.example.com",
      ]),
    )
    expect(mock.state.audit.some((entry) => entry.action === "settings.update")).toBe(true)
  })

  it("rejects something that is not an origin and duplicates", async () => {
    const { user } = await renderStudio("/settings")
    const input = await screen.findByLabelText("New origin")
    await user.type(input, "app.example.com/path")
    await user.click(screen.getByRole("button", { name: "Add origin" }))
    const describedError = () =>
      document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? ""
    expect(describedError()).toContain("app.example.com/path is not an origin")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    await user.clear(input)
    await user.type(input, "http://localhost:5173")
    await user.click(screen.getByRole("button", { name: "Add origin" }))
    expect(describedError()).toContain("is already in the list")
  })

  it("removes an origin", async () => {
    const { user, mock } = await renderStudio("/settings")
    await user.click(await screen.findByRole("button", { name: "Remove http://localhost:5173" }))
    expect(screen.getByText("No origins. Browsers cannot call the API.")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mock.state.settings.corsOrigins).toEqual([]))
  })

  it("lists admins and realtime image status", async () => {
    const { api } = await renderStudio("/settings")
    expect(await screen.findByText("owner@example.com")).toBeTruthy()
    expect(screen.getByText("No collection has realtime turned on.")).toBeTruthy()
    await api.updateCollection("todos", { realtime: true })
    expect(screen.getByText(/canopy realtime enable-images/)).toBeTruthy()
  })

  it("shows the danger zone to owners only", async () => {
    await renderStudio("/settings", { admins: [admin] })
    expect(await screen.findByLabelText("New origin")).toBeTruthy()
    expect(screen.queryByText("Danger zone")).toBeNull()
  })

  it("requires the exact phrase before revoking all sessions", async () => {
    const { user, mock } = await renderStudio("/settings")
    await user.click(await screen.findByRole("button", { name: "Revoke all sessions" }))
    const confirm = lastDialog().getByRole("button", {
      name: "Revoke all sessions",
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const typed = lastDialog().getByLabelText("Type revoke all sessions to confirm")
    await user.type(typed, "revoke all session")
    expect(confirm.disabled).toBe(true)
    await user.type(typed, "s")
    expect(confirm.disabled).toBe(false)
    await user.click(confirm)
    await waitFor(() =>
      expect(mock.state.audit.some((entry) => entry.action === "danger.revoke_all_sessions")).toBe(
        true,
      ),
    )
  })

  it("rotates the master key with its own phrase", async () => {
    const { user, mock } = await renderStudio("/settings")
    await user.click(await screen.findByRole("button", { name: "Rotate the master key" }))
    await user.type(
      lastDialog().getByLabelText("Type rotate master key to confirm"),
      "rotate master key",
    )
    await user.click(lastDialog().getByRole("button", { name: "Rotate the master key" }))
    await waitFor(() =>
      expect(mock.state.audit.some((entry) => entry.action === "danger.rotate_master_key")).toBe(
        true,
      ),
    )
  })

  it("is read only for viewers", async () => {
    await renderStudio("/settings", { admins: [viewer] })
    expect(await screen.findByText("Your role can view settings but not change them.")).toBeTruthy()
    expect((screen.getByLabelText("Public URL") as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByLabelText("New origin")).toBeNull()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  it("recognizes origins", () => {
    expect(isOrigin("https://app.example.com")).toBe(true)
    expect(isOrigin("http://localhost:5173")).toBe(true)
    expect(isOrigin("https://app.example.com/")).toBe(false)
    expect(isOrigin("ftp://files.example.com")).toBe(false)
    expect(isOrigin("app.example.com")).toBe(false)
  })
})
