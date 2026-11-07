import { describe, expect, it } from "vitest"
import type { LogEntry } from "../src/api/contract.ts"
import { groupDenials, matchesStatus } from "../src/features/logs-and-audit/denials.ts"
import { renderStudio, screen } from "./harness.tsx"

const entry = (overrides: Partial<LogEntry>): LogEntry => ({
  at: "2026-11-07T10:00:00.000Z",
  method: "GET",
  path: "/rest/v1/todos",
  status: 200,
  durationMs: 1,
  ...overrides,
})

describe("groupDenials", () => {
  it("counts only 401 and 403 answers, grouped by collection, operation, role, policy and code", () => {
    const groups = groupDenials([
      entry({
        status: 403,
        collection: "todos",
        operation: "update",
        role: "authenticated",
        policy: "edit own",
        code: "CANOPY_POLICY_VIOLATION",
        at: "2026-11-07T10:00:01.000Z",
      }),
      entry({
        status: 403,
        collection: "todos",
        operation: "update",
        role: "authenticated",
        policy: "edit own",
        code: "CANOPY_POLICY_VIOLATION",
        at: "2026-11-07T10:00:05.000Z",
      }),
      entry({
        status: 403,
        collection: "todos",
        operation: "update",
        role: "admin_role",
        policy: "edit own",
        code: "CANOPY_POLICY_VIOLATION",
      }),
      entry({
        status: 401,
        collection: "orders",
        operation: "read",
        role: "anon",
        code: "CANOPY_UNAUTHORIZED",
      }),
      entry({ status: 404, collection: "orders" }),
      entry({ status: 500, collection: "orders" }),
      entry({ status: 200, collection: "todos" }),
    ])
    expect(groups.map((group) => [group.collection, group.role, group.count])).toEqual([
      ["todos", "authenticated", 2],
      ["todos", "admin_role", 1],
      ["orders", "anon", 1],
    ])
    expect(groups[0]?.last).toBe("2026-11-07T10:00:05.000Z")
  })

  it("filters requests by status class", () => {
    expect(matchesStatus(entry({ status: 304 }), "success")).toBe(true)
    expect(matchesStatus(entry({ status: 404 }), "clientErrors")).toBe(true)
    expect(matchesStatus(entry({ status: 404 }), "serverErrors")).toBe(false)
    expect(matchesStatus(entry({ status: 503 }), "serverErrors")).toBe(true)
  })
})

describe("Logs and audit page", () => {
  it("shows the sampled requests with the summary and filters by status", async () => {
    const { user } = await renderStudio("/logs")
    expect(await screen.findAllByTestId("log-entry")).toHaveLength(40)
    expect(
      screen.getByText("Requests per second").parentElement?.querySelector("dd")?.textContent,
    ).toBe("42.5")
    await user.selectOptions(screen.getByLabelText("Show"), "clientErrors")
    const errors = screen.getAllByTestId("log-entry")
    expect(errors).toHaveLength(22)
    for (const row of errors) expect(row.textContent).toMatch(/40[13]/)
  })

  it("ranks the seeded denials by frequency, newest first on ties", async () => {
    const { user } = await renderStudio("/logs")
    await user.click(await screen.findByRole("tab", { name: "Denials" }))
    const rows = await screen.findAllByTestId("denial-group")
    const cells = rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))
    expect(cells.map((row) => [row[0], row[1], row[2], row[4]])).toEqual([
      ["6", "todos", "delete", "archived is permanent"],
      ["6", "orders", "read", "No policy grants it"],
      ["5", "orders", "insert", "No policy grants it"],
      ["5", "todos", "update", "edit own"],
    ])
  })

  it("lists audit entries and filters them by action prefix", async () => {
    const { user, api } = await renderStudio("/logs")
    await api.updateCollection("todos", { exposed: true })
    await user.click(await screen.findByRole("tab", { name: "Audit log" }))
    expect((await screen.findAllByTestId("audit-entry")).length).toBeGreaterThanOrEqual(2)
    await user.type(screen.getByLabelText("Action starts with"), "collection.")
    await screen.findByText("collection.update")
    const rows = await screen.findAllByTestId("audit-entry")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain("admin:owner@example.com")
    expect(rows[0]?.textContent).toContain("todos")
  })
})
