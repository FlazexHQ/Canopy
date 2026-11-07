import { waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { OWNER, renderStudio, screen } from "./harness.tsx"

describe("Studio shell", () => {
  it("sends a signed out visitor to the first run claim while no admin exists", async () => {
    const { router } = await renderStudio("/data", { admins: [], signedInAs: false })
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"))
  })

  it("sends a signed out visitor to the login once an admin exists", async () => {
    const { router } = await renderStudio("/policies", { signedInAs: false })
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"))
    expect(router.state.location.search).toEqual({ redirect: "/policies" })
  })

  it("shows every area in the main navigation with the current page marked", async () => {
    await renderStudio("/doctor")
    const nav = await screen.findAllByRole("navigation", { name: "Main navigation" })
    const links = nav[0]?.querySelectorAll("a") ?? []
    expect([...links].map((link) => link.textContent)).toEqual([
      "Overview",
      "Data",
      "Policies",
      "Realtime",
      "Auth",
      "API",
      "Logs and audit",
      "Settings",
      "Doctor",
    ])
    const current = [...links].find((link) => link.getAttribute("aria-current") === "page")
    expect(current?.textContent).toBe("Doctor")
  })

  it("marks production clearly", async () => {
    await renderStudio("/doctor", { environment: "production" })
    expect(await screen.findByText("Production")).toBeTruthy()
  })

  it("offers a skip link to the main content", async () => {
    await renderStudio("/doctor")
    const skip = await screen.findByRole("link", { name: "Skip to content" })
    expect(skip.getAttribute("href")).toBe("#main")
    expect(document.getElementById("main")).not.toBeNull()
  })

  it("signs out and returns to the login", async () => {
    const { user, router, mock } = await renderStudio("/doctor")
    await user.click(await screen.findByRole("button", { name: "Account" }))
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"))
    expect(mock.state.sessions.size).toBe(0)
    expect(OWNER.email).toBe("owner@example.com")
  })
})
