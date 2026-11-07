import { waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { safeRedirect } from "../src/features/session/login.tsx"
import { adminOf, OWNER, renderStudio, screen, TOTP_CODE } from "./harness.tsx"

const DEVELOPER = { ...adminOf("developer"), totp: false }

describe("login", () => {
  it("shows the server error for a wrong password and stays on the login", async () => {
    const { user, router } = await renderStudio("/login", { signedInAs: false })
    await user.type(await screen.findByLabelText("Email"), OWNER.email)
    await user.type(screen.getByLabelText("Password"), "wrong password!")
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("Invalid email or password")).toBeTruthy()
    expect(router.state.location.pathname).toBe("/login")
  })

  it("asks owners for the authenticator code, then signs in", async () => {
    const { user, router, mock } = await renderStudio("/login", { signedInAs: false })
    await user.type(await screen.findByLabelText("Email"), OWNER.email)
    await user.type(screen.getByLabelText("Password"), OWNER.password)
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    const code = await screen.findByLabelText("Authenticator code")
    expect(document.activeElement).toBe(code)
    expect(mock.state.sessions.size).toBe(0)
    await user.type(code, "000000")
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("Invalid email or password")).toBeTruthy()
    expect(mock.state.sessions.size).toBe(0)
    await user.clear(code)
    await user.type(code, TOTP_CODE)
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
    expect(mock.state.sessions.size).toBe(1)
  })

  it("lands on the redirect target after signing in", async () => {
    const { user, router } = await renderStudio("/login?redirect=%2Fdoctor", {
      admins: [OWNER, DEVELOPER],
      signedInAs: false,
    })
    await user.type(await screen.findByLabelText("Email"), DEVELOPER.email)
    await user.type(screen.getByLabelText("Password"), DEVELOPER.password)
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/doctor"))
    expect(await screen.findByRole("heading", { name: "Doctor", level: 1 })).toBeTruthy()
  })

  it("points to the setup wizard while the server is unclaimed", async () => {
    await renderStudio("/login", { admins: [], signedInAs: false })
    const link = await screen.findByRole("link", { name: "Claim it with the setup token" })
    expect(link.getAttribute("href")).toBe("/studio/setup")
  })

  it("only follows redirects that stay inside Studio", () => {
    expect(safeRedirect("/policies/todos?x=1")).toBe("/policies/todos?x=1")
    expect(safeRedirect("//evil.example")).toBe("/")
    expect(safeRedirect("https://evil.example")).toBe("/")
    expect(safeRedirect("/login")).toBe("/")
    expect(safeRedirect(undefined)).toBe("/")
  })
})
