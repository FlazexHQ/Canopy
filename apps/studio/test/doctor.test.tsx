import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { splitFix } from "../src/features/doctor/checks.tsx"
import { renderStudio, screen } from "./harness.tsx"

describe("doctor", () => {
  it("groups the server's checks by severity, with friendly titles", async () => {
    await renderStudio("/doctor", { environment: "production" })
    const warnings = await screen.findByRole("region", { name: /Warnings/ })
    const listener = within(warnings).getByTestId("check-admin-listener")
    expect(within(listener).getByRole("heading", { name: "Private admin listener" })).toBeTruthy()
    expect(
      within(listener).getByText(
        "/admin is served on the public listener; set CANOPY_ADMIN_LISTEN to keep it private",
      ),
    ).toBeTruthy()
    expect(screen.getByText("0 errors, 1 warnings, 6 passed")).toBeTruthy()
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(["Warnings (1)", "Passed (6)"])
  })

  it("shows every check passing in development and reruns them on demand", async () => {
    const { user, mock } = await renderStudio("/doctor")
    await screen.findByText("0 errors, 0 warnings, 7 passed")
    expect(screen.getByText("Bundle", { exact: false }).textContent).toContain("0 collection(s)")
    mock.state.connections.splice(0)
    await user.click(screen.getByRole("button", { name: "Run again" }))
    await waitFor(() => expect(screen.getByText("0 connection(s)")).toBeTruthy())
  })

  it("separates prose from the command in a fix", () => {
    expect(splitFix("canopy realtime enable-images <collection>")).toEqual({
      command: "canopy realtime enable-images <collection>",
    })
    expect(splitFix("Grow the oplog: db.adminCommand({})")).toEqual({
      prose: "Grow the oplog",
      command: "db.adminCommand({})",
    })
    expect(splitFix("Add your app's origin in Settings")).toEqual({
      prose: "Add your app's origin in Settings",
    })
  })
})
