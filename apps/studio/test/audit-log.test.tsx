import { waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { LogEntry } from "../src/api/contract.ts"
import { groupDenials, restTarget, summarize } from "../src/features/logs-and-audit/denials.ts"
import { renderStudio, screen } from "./harness.tsx"

let counter = 0
const entry = (overrides: Partial<LogEntry>): LogEntry => ({
  id: `log_${counter++}`,
  at: "2026-11-07T10:00:00.000Z",
  surface: "rest",
  method: "GET",
  path: "/rest/v1/todos",
  status: 200,
  durationMs: 1,
  ...overrides,
})

describe("groupDenials", () => {
  it("counts only 401 and 403 answers, grouped by surface, collection, operation and status", () => {
    const groups = groupDenials([
      entry({
        status: 403,
        method: "PATCH",
        path: "/rest/v1/todos/abc",
        at: "2026-11-07T10:00:01.000Z",
      }),
      entry({
        status: 403,
        method: "PUT",
        path: "/rest/v1/todos/def",
        at: "2026-11-07T10:00:05.000Z",
      }),
      entry({ status: 403, method: "DELETE", path: "/rest/v1/todos/abc" }),
      entry({ status: 401, surface: "auth", method: "POST", path: "/auth/v1/sign-in/email" }),
      entry({ status: 404, method: "GET", path: "/rest/v1/todos/zzz" }),
      entry({ status: 500 }),
    ])
    expect(
      groups.map((group) => [
        group.surface,
        group.collection,
        group.operation,
        group.status,
        group.count,
      ]),
    ).toEqual([
      ["rest", "todos", "update", 403, 2],
      ["rest", "todos", "delete", 403, 1],
      ["auth", undefined, undefined, 401, 1],
    ])
    expect(groups[0]?.last).toBe("2026-11-07T10:00:05.000Z")
  })

  it("reads the collection only from Data API paths", () => {
    expect(restTarget({ surface: "rest", method: "GET", path: "/rest/v1/my%20coll/1" })).toEqual({
      collection: "my coll",
      operation: "read",
    })
    expect(restTarget({ surface: "rest", method: "GET", path: "/rest/v1/openapi.json" })).toEqual({
      collection: undefined,
      operation: undefined,
    })
    expect(
      restTarget({ surface: "admin", method: "GET", path: "/admin/v1/collections" }).collection,
    ).toBeUndefined()
  })
})

describe("summarize", () => {
  it("scales sampled requests by the sample rate over their time span, leaving out kept 5xx", () => {
    const summary = summarize({
      sampleRate: 0.1,
      entries: [
        entry({ at: "2026-11-07T10:00:00.000Z" }),
        entry({ at: "2026-11-07T10:00:05.000Z" }),
        entry({ at: "2026-11-07T10:00:10.000Z" }),
        entry({ at: "2026-11-07T10:00:30.000Z", status: 503 }),
      ],
    })
    expect(summary.estimatedPerSecond).toBeCloseTo(3, 10)
    expect(summary.serverErrorShare).toBe(0.25)
    expect(summary.sampled).toBe(4)
  })

  it("does not estimate with logging off or a single entry", () => {
    expect(
      summarize({ sampleRate: 0, entries: [entry({}), entry({})] }).estimatedPerSecond,
    ).toBeUndefined()
    expect(summarize({ sampleRate: 1, entries: [entry({})] }).estimatedPerSecond).toBeUndefined()
  })
})

describe("Logs and audit page", () => {
  it("shows the sampled requests with the sample settings, filtered on the server", async () => {
    const { user } = await renderStudio("/logs")
    expect(await screen.findAllByTestId("log-entry")).toHaveLength(36)
    expect(screen.getByText("Sample rate").parentElement?.querySelector("dd")?.textContent).toBe(
      "1%",
    )
    expect(screen.getByText("Kept for").parentElement?.querySelector("dd")?.textContent).toBe(
      "7 days",
    )
    await user.selectOptions(screen.getByLabelText("Status"), "4xx")
    await waitFor(() => expect(screen.getAllByTestId("log-entry")).toHaveLength(20))
    for (const row of screen.getAllByTestId("log-entry")) expect(row.textContent).toMatch(/40[13]/)
    await user.selectOptions(screen.getByLabelText("Surface"), "auth")
    await waitFor(() => expect(screen.getAllByTestId("log-entry")).toHaveLength(4))
    for (const row of screen.getAllByTestId("log-entry"))
      expect(row.textContent).toContain("/auth/v1/sign-in/email")
  })

  it("pages to older requests with the server's cursor", async () => {
    const { user } = await renderStudio("/logs", {
      prepare: (mock) => {
        const extra = Array.from({ length: 100 }, (_, index) => ({
          ...(mock.state.logs[0] as (typeof mock.state.logs)[number]),
          _id: { $oid: (0x100000 + index).toString(16).padStart(24, "0") },
          at: new Date(Date.parse("2026-01-01T00:00:00Z") - index * 1000),
        }))
        mock.state.logs.push(...extra)
      },
    })
    expect(await screen.findAllByTestId("log-entry")).toHaveLength(100)
    await user.click(screen.getByRole("button", { name: "Show older requests" }))
    await waitFor(() => expect(screen.getAllByTestId("log-entry")).toHaveLength(136))
    expect(screen.queryByRole("button", { name: "Show older requests" })).toBeNull()
  })

  it("says when request logging is off", async () => {
    await renderStudio("/logs", {
      prepare: (mock) => {
        mock.state.settings.requestLogSampleRate = 0
        mock.state.logs.splice(0)
      },
    })
    expect(
      await screen.findByText("Request logging is off. Set a sample rate above 0 in Settings."),
    ).toBeTruthy()
  })

  it("ranks the seeded denials by frequency, newest first on ties", async () => {
    const { user } = await renderStudio("/logs")
    await user.click(await screen.findByRole("tab", { name: "Denials" }))
    const rows = await screen.findAllByTestId("denial-group")
    const cells = rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))
    expect(cells.map((row) => row.slice(0, 5))).toEqual([
      ["4", "Data API", "todos", "update", "403 forbidden"],
      ["4", "Data API", "todos", "delete", "403 forbidden"],
      ["4", "Data API", "orders", "insert", "403 forbidden"],
      ["4", "Auth", "", "", "401 not signed in"],
      ["4", "Data API", "orders", "read", "401 not signed in"],
    ])
  })

  it("lists audit entries and filters them by action prefix", async () => {
    const { user, api } = await renderStudio("/logs")
    await api.updateCollection("todos", { exposed: true, expectedVersion: 0 })
    await user.click(await screen.findByRole("tab", { name: "Audit log" }))
    expect((await screen.findAllByTestId("audit-entry")).length).toBeGreaterThanOrEqual(2)
    await user.type(screen.getByLabelText("Action starts with"), "collection.")
    await screen.findByText("collection.update")
    const rows = await screen.findAllByTestId("audit-entry")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain("owner@example.com")
    expect(rows[0]?.textContent).toContain("todos")
  })
})
