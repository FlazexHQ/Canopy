import { waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { splitFix } from "../src/features/doctor/checks.tsx"
import { renderStudio, screen } from "./harness.tsx"

describe("doctor", () => {
  it("groups checks by severity and shows the oplog warning with a copyable fix", async () => {
    await renderStudio("/doctor")
    const warnings = await screen.findByRole("region", { name: /Warnings/ })
    const oplog = within(warnings).getByTestId("check-oplog")
    expect(within(oplog).getByText("The oplog covers 6 hours of writes")).toBeTruthy()
    expect(
      within(oplog).getByText("db.adminCommand({ replSetResizeOplog: 1, size: 4096 })"),
    ).toBeTruthy()
    expect(
      within(oplog).getByRole("button", { name: "Copy the fix to the clipboard" }),
    ).toBeTruthy()
    expect(
      within(oplog)
        .getByRole("link", { name: "Documentation for Oplog window" })
        .getAttribute("href"),
    ).toBe("https://canopy.dev/docs/operations/oplog")
    expect(screen.getByText("0 errors, 1 warnings, 7 passed")).toBeTruthy()
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(["Warnings (1)", "Notes (2)", "Passed (7)"])
  })

  it("reruns the checks and shows what changed", async () => {
    const { user, mock } = await renderStudio("/doctor")
    await screen.findByText("0 errors, 1 warnings, 7 passed")
    mock.state.settings.corsOrigins = []
    await user.click(screen.getByRole("button", { name: "Run again" }))
    await waitFor(() => expect(screen.getByText("0 errors, 2 warnings, 6 passed")).toBeTruthy())
    expect(
      screen.getByText("No CORS origins are configured, so browsers cannot call the API"),
    ).toBeTruthy()
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
