import { waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { querySnippet, reactSnippet, setupSnippet } from "../src/features/api/snippets.ts"
import { renderStudio, screen } from "./harness.tsx"

const scalar = vi.hoisted(() => ({ imported: false, mounts: [] as unknown[][] }))

vi.mock("../src/features/api/scalar.ts", () => {
  scalar.imported = true
  return {
    mountReference: (...args: unknown[]) => {
      scalar.mounts.push(args)
      return () => {}
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const lastDialog = () => {
  const dialog = screen.getAllByRole("dialog").at(-1)
  if (dialog === undefined) throw new Error("no dialog open")
  return within(dialog)
}

const PUBLISHABLE = "canopy_pk_8f2KQmTfE1c9xZ0aW3bYdL5nR7sVuH2j"
const exposedTodos = {
  _id: "todos",
  exposed: true,
  realtime: true,
  policies: [
    {
      name: "read all",
      kind: "permissive" as const,
      ops: ["read" as const],
      roles: ["authenticated"],
    },
  ],
}

describe("API keys", () => {
  it("shows a new secret key exactly once, then only its prefix", async () => {
    const { user, mock } = await renderStudio("/api")
    await user.click(await screen.findByRole("button", { name: "Create key" }))
    await user.type(lastDialog().getByLabelText("Name"), "Billing worker")
    await user.click(lastDialog().getByRole("radio", { name: /^Secret/ }))
    await user.click(lastDialog().getByRole("button", { name: "Create" }))
    const value = (await screen.findByLabelText("Key value")) as HTMLInputElement
    expect(value.value).toMatch(/^canopy_sk_/)
    expect(screen.getByText(/This is the only time the secret key is shown/)).toBeTruthy()
    const secret = value.value
    const stored = mock.state.apiKeys.find((key) => key.name === "Billing worker")
    expect(stored?.kind).toBe("secret")
    await user.click(screen.getByRole("button", { name: "I stored the key" }))
    await waitFor(() => expect(screen.queryByLabelText("Key value")).toBeNull())
    expect(await screen.findByText("Billing worker")).toBeTruthy()
    expect(document.body.textContent).not.toContain(secret)
    expect(stored?.prefix).toBe(secret.slice(10, 18))
    expect(document.body.textContent).toContain(`${secret.slice(0, 18)}…`)
  })

  it("lets developers create publishable keys only", async () => {
    const developer = {
      id: "adm_d",
      email: "dev@example.com",
      role: "developer" as const,
      password: "a long password 1",
    }
    const { user } = await renderStudio("/api", { admins: [developer] })
    await user.click(await screen.findByRole("button", { name: "Create key" }))
    expect(
      (lastDialog().getByRole("radio", { name: /^Secret/ }) as HTMLInputElement).disabled,
    ).toBe(true)
    expect(lastDialog().getByText("Your role can create publishable keys only.")).toBeTruthy()
    await user.click(lastDialog().getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("button", { name: "Revoke Backend" })).toBeNull()
    expect(screen.getByRole("button", { name: "Revoke Default publishable key" })).toBeTruthy()
  })

  it("hides key creation from viewers", async () => {
    const viewer = {
      id: "adm_v",
      email: "viewer@example.com",
      role: "viewer" as const,
      password: "a long password 1",
    }
    await renderStudio("/api", { admins: [viewer] })
    expect(await screen.findByText("Your role cannot create or revoke keys.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Create key" })).toBeNull()
  })

  it("revokes a key after confirmation", async () => {
    const { user, mock } = await renderStudio("/api")
    await user.click(await screen.findByRole("button", { name: "Revoke Backend" }))
    expect(mock.state.apiKeys.find((key) => key.id === "key_sk_1")?.revokedAt).toBeUndefined()
    await user.click(lastDialog().getByRole("button", { name: "Revoke Backend" }))
    await waitFor(() =>
      expect(mock.state.apiKeys.find((key) => key.id === "key_sk_1")?.revokedAt).toBeTruthy(),
    )
    expect(
      mock.state.audit.some(
        (entry) => entry.action === "key.revoke" && entry.target?.["keyId"] === "key_sk_1",
      ),
    ).toBe(true)
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke Backend" })).toBeNull())
  })
})

describe("API reference and snippets", () => {
  it("loads Scalar only when the reference tab opens, with the server's OpenAPI document", async () => {
    scalar.imported = false
    scalar.mounts.length = 0
    const { user, mock } = await renderStudio("/api", { policies: [exposedTodos] })
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      mock.fetch(new Request(input, init)),
    )
    await screen.findByRole("button", { name: "Create key" })
    expect(scalar.imported).toBe(false)
    await user.click(screen.getByRole("tab", { name: "REST reference" }))
    await waitFor(() => expect(scalar.mounts.length).toBe(1))
    expect(scalar.imported).toBe(true)
    const [element, spec] = scalar.mounts[0] as [Element, Record<string, unknown>]
    expect(element).toBe(screen.getByTestId("scalar-reference"))
    expect(spec["openapi"]).toBe("3.1.0")
    expect(Object.keys(spec["paths"] as object)).toContain("/rest/v1/todos")
  })

  it("explains when the server has no OpenAPI document", async () => {
    const { user } = await renderStudio("/api")
    vi.stubGlobal("fetch", async () => new Response("Not found", { status: 404 }))
    await user.click(await screen.findByRole("tab", { name: "REST reference" }))
    expect(await screen.findByText(/does not provide the OpenAPI document/)).toBeTruthy()
  })

  it("fills the publishable key and the collection into the SDK snippets", async () => {
    const { user } = await renderStudio("/api", { policies: [exposedTodos] })
    await user.click(await screen.findByRole("tab", { name: "SDK snippets" }))
    expect(await screen.findByText(/canopy\.from\("todos"\)\.find/)).toBeTruthy()
    expect(document.body.textContent).toContain(`publishableKey: "${PUBLISHABLE}"`)
  })

  it("asks to expose a collection before showing snippets", async () => {
    const { user } = await renderStudio("/api")
    await user.click(await screen.findByRole("tab", { name: "SDK snippets" }))
    expect(await screen.findByText(/No collection is exposed yet/)).toBeTruthy()
  })

  it("builds snippets that name the collection and fall back to a placeholder key", () => {
    const input = {
      url: "https://api.example.com",
      collection: "audit_events",
      publishableKey: undefined,
    }
    expect(setupSnippet(input)).toContain('publishableKey: "canopy_pk_YOUR_PUBLISHABLE_KEY"')
    expect(setupSnippet(input)).toContain('url: "https://api.example.com"')
    expect(querySnippet(input)).toContain('const auditEvents = canopy.from("audit_events")')
    expect(reactSnippet(input)).toContain("function AuditEventsList()")
  })

  it("shows the type generation commands", async () => {
    const { user } = await renderStudio("/api")
    await user.click(await screen.findByRole("tab", { name: "Types" }))
    expect(await screen.findByText("canopy gen types --check")).toBeTruthy()
    expect(screen.getByText("canopy gen types --role authenticated")).toBeTruthy()
  })
})
