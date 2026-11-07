import { waitFor, within } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { bodyOf, insertPlaceholder, missingPlaceholders } from "../src/features/auth/templates.tsx"
import { parseRoles, viewAsUser } from "../src/features/auth/users.tsx"
import { adminOf, renderStudio, screen } from "./harness.tsx"

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto["hasPointerCapture"] ??= () => false
  proto["releasePointerCapture"] ??= () => {}
  proto["scrollIntoView"] ??= () => {}
})

const lastDialog = () => {
  const dialog = screen.getAllByRole("dialog").at(-1)
  if (dialog === undefined) throw new Error("no dialog open")
  return within(dialog)
}

async function openUser(user: Awaited<ReturnType<typeof renderStudio>>["user"], email: string) {
  await user.click(await screen.findByRole("button", { name: `Details for ${email}` }))
  return lastDialog()
}

describe("Auth users", () => {
  it("lists app users with their total and narrows them by email prefix", async () => {
    const { user } = await renderStudio("/auth")
    expect(
      await screen.findByRole("button", { name: "Details for alice@example.com" }),
    ).toBeTruthy()
    expect(screen.getByText("Users 1 to 3 of 3")).toBeTruthy()
    await user.type(screen.getByLabelText("Find users by email"), "bo")
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Details for alice@example.com" })).toBeNull(),
    )
    expect(screen.getByRole("button", { name: "Details for bob@example.com" })).toBeTruthy()
    expect(screen.getByText("Users 1 to 1 of 1")).toBeTruthy()
  })

  it("bans a user with a reason through POST /users/{id}/ban, then unbans", async () => {
    const { user, mock } = await renderStudio("/auth")
    const dialog = await openUser(user, "alice@example.com")
    await user.click(dialog.getByRole("button", { name: "Ban" }))
    await user.type(lastDialog().getByLabelText(/^Reason/), "chargebacks")
    await user.click(lastDialog().getByRole("button", { name: "Ban" }))
    await waitFor(() =>
      expect(mock.state.users.find((u) => u.id === "u_alice")).toMatchObject({
        banned: true,
        banReason: "chargebacks",
      }),
    )
    expect(mock.state.userSessions.some((session) => session.userId === "u_alice")).toBe(false)
    expect(mock.state.audit.find((entry) => entry.action === "user.ban")?.target).toEqual({
      userId: "u_alice",
    })
    await user.click(await lastDialog().findByRole("button", { name: "Unban" }))
    await waitFor(() =>
      expect(mock.state.users.find((u) => u.id === "u_alice")?.banned).toBe(false),
    )
  })

  it("lists sessions and ends one, or all after confirmation", async () => {
    const { user, mock } = await renderStudio("/auth")
    const dialog = await openUser(user, "alice@example.com")
    expect(await dialog.findByText("Firefox 146")).toBeTruthy()
    expect(dialog.getByText("Safari 26")).toBeTruthy()
    const ends = dialog.getAllByRole("button", { name: /^End the session started/ })
    await user.click(ends[0] as HTMLElement)
    await waitFor(() =>
      expect(mock.state.userSessions.filter((s) => s.userId === "u_alice")).toHaveLength(1),
    )
    await user.click(lastDialog().getByRole("button", { name: "Sign out everywhere" }))
    await user.click(lastDialog().getByRole("button", { name: "Sign out everywhere" }))
    await waitFor(() =>
      expect(mock.state.userSessions.filter((s) => s.userId === "u_alice")).toHaveLength(0),
    )
    expect(
      mock.state.audit
        .filter((entry) => entry.action === "user.sessions.revoke")
        .map((e) => e.details),
    ).toEqual([{ count: 1 }, { count: 1 }])
  })

  it("edits roles and app metadata, and the server refuses reserved roles", async () => {
    const { user, mock } = await renderStudio("/auth")
    const dialog = await openUser(user, "bob@example.com")
    const roles = dialog.getByLabelText("Roles, separated by commas")
    await user.clear(roles)
    await user.type(roles, "editor, billing")
    await user.click(dialog.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(mock.state.users.find((u) => u.id === "u_bob")?.roles).toEqual(["editor", "billing"]),
    )
    const again = lastDialog().getByLabelText("Roles, separated by commas")
    await user.clear(again)
    await user.type(again, "service")
    await user.click(lastDialog().getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("The role service cannot be assigned")).toBeTruthy()
    expect(mock.state.users.find((u) => u.id === "u_bob")?.roles).toEqual(["editor", "billing"])
  })

  it("deletes a user only after typing their email", async () => {
    const { user, mock } = await renderStudio("/auth")
    const dialog = await openUser(user, "bob@example.com")
    await user.click(dialog.getByRole("button", { name: "Delete user" }))
    const confirm = lastDialog()
    const button = confirm.getByRole("button", { name: "Delete user" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.type(confirm.getByLabelText("Type bob@example.com to confirm"), "bob@example.com")
    await user.click(button)
    await waitFor(() => expect(mock.state.users.some((u) => u.id === "u_bob")).toBe(false))
    expect(mock.state.audit.find((entry) => entry.action === "user.delete")?.target).toEqual({
      userId: "u_bob",
      email: "bob@example.com",
    })
  })

  it("creates a user and invites one by email", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("button", { name: "Create user" }))
    await user.type(lastDialog().getByLabelText("Email"), "dan@example.com")
    await user.click(lastDialog().getByRole("button", { name: "Create user" }))
    await waitFor(() =>
      expect(mock.state.users.some((u) => u.email === "dan@example.com")).toBe(true),
    )
    await user.click(await screen.findByRole("button", { name: "Invite by email" }))
    await user.type(lastDialog().getByLabelText("Email"), "erin@example.com")
    await user.click(lastDialog().getByRole("button", { name: "Invite by email" }))
    await waitFor(() => expect(mock.state.mail.at(-1)?.to).toBe("erin@example.com"))
    expect(mock.state.mail.at(-1)?.subject).toBe("You are invited to Canopy")
  })

  it("views data as a user with the claims a built in auth token carries", async () => {
    const { user, router } = await renderStudio("/auth")
    const dialog = await openUser(user, "bob@example.com")
    await user.click(dialog.getByRole("button", { name: "View data as this user" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/data"))
    expect(await screen.findByText("Viewing as bob@example.com")).toBeTruthy()
  })

  it("lets developers see users but not change them, and hides users from viewers", async () => {
    const { user } = await renderStudio("/auth", { admins: [adminOf("developer")] })
    const dialog = await openUser(user, "alice@example.com")
    expect(dialog.getByText("Your role can view users but not change them.")).toBeTruthy()
    expect(dialog.queryByRole("button", { name: "Ban" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Create user" })).toBeNull()
  })

  it("shows that built in auth is not configured when the server answers 404", async () => {
    await renderStudio("/auth", { builtinAuth: false })
    expect(await screen.findByText("Not available on this server yet")).toBeTruthy()
    expect(screen.getByText(/does not provide built in auth/)).toBeTruthy()
  })

  it("builds view as identities and role lists", () => {
    expect(
      viewAsUser({
        id: "u_1",
        email: "a@example.com",
        emailVerified: true,
        isAnonymous: false,
        roles: ["editor"],
        appMetadata: { org_ids: ["o1"] },
        userMetadata: { theme: "dark" },
        banned: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      roles: ["authenticated", "editor"],
      claims: {
        sub: "u_1",
        email: "a@example.com",
        app_metadata: { org_ids: ["o1"] },
        roles: ["editor"],
      },
      label: "a@example.com",
    })
    expect(parseRoles(" a, b ,, a ,c")).toEqual(["a", "b", "c"])
  })
})

describe("Signing keys", () => {
  it("rotates now and shows the new states", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("tab", { name: "Signing keys" }))
    await user.click(await screen.findByRole("button", { name: "Rotate now" }))
    await user.click(lastDialog().getByRole("button", { name: "Rotate now" }))
    await waitFor(() =>
      expect(mock.state.signingKeys.map((key) => [key.kid, key.state]).slice(0, 2)).toEqual([
        ["k_2026_10", "retired"],
        ["k_2026_11", "active"],
      ]),
    )
    expect(await screen.findAllByText("Retired")).toHaveLength(1)
    expect(mock.state.audit.some((entry) => entry.action === "auth.keys.rotate")).toBe(true)
  })

  it("revokes a key only after typing its id", async () => {
    const { user, mock } = await renderStudio("/auth")
    await user.click(await screen.findByRole("tab", { name: "Signing keys" }))
    await user.click(await screen.findByRole("button", { name: "Revoke key k_2026_11" }))
    const confirm = lastDialog()
    await user.type(confirm.getByLabelText("Type k_2026_11 to confirm"), "k_2026_11")
    await user.click(confirm.getByRole("button", { name: "Revoke" }))
    await waitFor(() =>
      expect(mock.state.signingKeys.find((key) => key.kid === "k_2026_11")?.state).toBe("revoked"),
    )
    expect(mock.state.audit.find((entry) => entry.action === "auth.keys.revoke")?.target).toEqual({
      kid: "k_2026_11",
    })
  })

  it("is hidden from developers, who lack settings.read", async () => {
    const { user } = await renderStudio("/auth", { admins: [adminOf("developer")] })
    await user.click(await screen.findByRole("tab", { name: "Signing keys" }))
    expect(await screen.findByText("Your role cannot see this")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Rotate now" })).toBeNull()
  })
})

describe("Email templates", () => {
  const openTemplates = async () => {
    const harness = await renderStudio("/auth")
    await harness.user.click(await screen.findByRole("tab", { name: "Email templates" }))
    await screen.findByRole("form", { name: "Email verification" })
    return harness
  }

  it("shows the default template and previews it with test data", async () => {
    await openTemplates()
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
      "Confirm your email for {{appName}}",
    )
    expect(await screen.findByTestId("template-preview-subject")).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId("template-preview-subject").textContent).toBe(
        "Confirm your email for Canopy",
      ),
    )
    expect(screen.getByTestId("template-preview-text").textContent).toContain(
      "https://app.example.com/auth/v1/verify?token=preview",
    )
  })

  it("saves an edit as a new version that the next email uses, then resets it", async () => {
    const { user, mock } = await openTemplates()
    const subject = screen.getByLabelText("Subject")
    await user.clear(subject)
    await user.type(subject, "Welcome, confirm {{{{email}}")
    await waitFor(() =>
      expect(screen.getByTestId("template-preview-subject").textContent).toBe(
        "Welcome, confirm ada@example.com",
      ),
    )
    await user.type(screen.getByLabelText("Comment (optional)"), "Friendlier")
    await user.click(screen.getByRole("button", { name: "Save template" }))
    await waitFor(() => expect(mock.state.templates.version).toBe(1))
    expect(mock.state.templates.current.verification?.subject).toBe("Welcome, confirm {{email}}")
    expect(mock.state.templates.history[0]).toMatchObject({
      change: "update",
      comment: "Friendlier",
    })
    expect(
      await screen.findByText("Version 1: Edited Email verification by adm_owner"),
    ).toBeTruthy()

    await user.click(await screen.findByRole("button", { name: "Reset to default" }))
    await user.click(lastDialog().getByRole("button", { name: "Reset to default" }))
    await waitFor(() => expect(mock.state.templates.version).toBe(2))
    expect(mock.state.templates.current.verification).toBeUndefined()
    expect(mock.state.audit.map((entry) => entry.action).slice(0, 2)).toEqual([
      "auth.templates.reset",
      "auth.templates.update",
    ])
  })

  it("will not save a body without the link its kind needs", async () => {
    const { user, mock } = await openTemplates()
    const text = screen.getByLabelText("Text body")
    await user.clear(text)
    await user.type(text, "No link here")
    expect(
      (screen.getByRole("button", { name: "Save template" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(await screen.findByText(/The preview failed: .*must contain \{\{url\}\}/)).toBeTruthy()
    expect(mock.state.templates.version).toBe(0)
  })

  it("inserts a placeholder at the caret", async () => {
    const { user } = await openTemplates()
    const text = screen.getByLabelText("Text body") as HTMLTextAreaElement
    await user.clear(text)
    await user.type(text, "Go: ")
    await user.click(screen.getByRole("button", { name: "Insert {{url}}" }))
    await waitFor(() => expect(text.value).toBe("Go: {{url}}"))
  })

  it("explains a conflict when someone saved first, and reloads", async () => {
    const { user, mock } = await openTemplates()
    mock.state.templates.version = 4
    const subject = screen.getByLabelText("Subject")
    await user.type(subject, "!")
    await user.click(screen.getByRole("button", { name: "Save template" }))
    expect(await screen.findByText(/version 4 is in force/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(screen.getByText(/Version 4$/)).toBeTruthy())
  })

  it("is hidden from roles without settings.read", async () => {
    const { user } = await renderStudio("/auth", { admins: [adminOf("developer")] })
    await user.click(await screen.findByRole("tab", { name: "Email templates" }))
    expect(await screen.findByText("Your role cannot see this")).toBeTruthy()
  })

  it("computes missing placeholders, bodies and insertions", () => {
    const draft = { subject: "S {{url}}", text: "T", html: "<p>{{ url }}</p>" }
    expect(missingPlaceholders(draft, ["url"])).toEqual([])
    expect(missingPlaceholders({ ...draft, html: "" }, ["url"])).toEqual(["url"])
    expect(bodyOf({ subject: "S", text: "T", html: "  " })).toEqual({ subject: "S", text: "T" })
    expect(insertPlaceholder("ab", "otp", 1)).toEqual({ value: "a{{otp}}b", caret: 8 })
    expect(insertPlaceholder("abcd", "url", 1, 3)).toEqual({ value: "a{{url}}d", caret: 8 })
  })
})

describe("Auth audit", () => {
  it("lists only user and auth events", async () => {
    const { user, api } = await renderStudio("/auth")
    await api.banUser("u_bob", { reason: "spam" })
    await api.updateCollection("todos", { exposed: true, expectedVersion: 0 })
    await user.click(await screen.findByRole("tab", { name: "Auth audit" }))
    expect(await screen.findByText("user.ban")).toBeTruthy()
    expect(screen.queryByText("collection.update")).toBeNull()
  })
})
