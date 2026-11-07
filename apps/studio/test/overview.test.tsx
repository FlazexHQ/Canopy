import { within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { checklistOf } from "../src/features/overview/page.tsx"
import { renderStudio, screen } from "./harness.tsx"

function itemState(name: string): string | null | undefined {
  const list = screen.getByRole("list", { name: "Getting started" })
  const item = within(list).getByText(name).closest("li")
  return item?.getAttribute("data-done")
}

describe("overview", () => {
  it("shows health from the doctor and says what the server does not report", async () => {
    await renderStudio("/")
    expect(await screen.findByText("Replica set rs0")).toBeTruthy()
    expect(await screen.findByText("8.0.4")).toBeTruthy()
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0)
  })

  it("derives the getting started checklist from the server state", async () => {
    await renderStudio("/", {
      policies: [{ _id: "todos", exposed: true, realtime: false, policies: [] }],
    })
    expect(await screen.findByText("4 of 5 done")).toBeTruthy()
    expect(itemState("Expose a collection")).toBe("true")
    expect(itemState("Publish a policy")).toBe("true")
    expect(itemState("Create a publishable key")).toBe("true")
    expect(itemState("Fix the errors doctor reports")).toBe("true")
    expect(itemState("Turn on realtime for a collection")).toBe("false")
    const todo = screen.getByRole("link", { name: "Turn on realtime for a collection" })
    expect(todo.getAttribute("href")).toBe("/studio/data")
  })

  it("marks everything to do on a fresh server", () => {
    const items = checklistOf([{ name: "todos", exposed: false, realtime: false }], [], {
      checks: [{ id: "replica-set", title: "replica-set", status: "error", message: "standalone" }],
    })
    expect(items.map((item) => item.done)).toEqual([false, false, false, false, false])
    const revoked = checklistOf(
      undefined,
      [{ id: "k", kind: "publishable", name: "n", prefix: "p", revokedAt: "2026-01-01T00:00:00Z" }],
      undefined,
    )
    expect(revoked.find((item) => item.id === "key")?.done).toBe(false)
  })
})
