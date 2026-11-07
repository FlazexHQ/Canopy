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
  it("shows health from the doctor, realtime stats and the logs summary", async () => {
    await renderStudio("/")
    expect(await screen.findByText("replica set (rs0, 1 member)")).toBeTruthy()
    expect(await screen.findByText("8.0.4")).toBeTruthy()
    expect(await screen.findByText("0.4.0-mock")).toBeTruthy()
    expect(await screen.findByText("42.5")).toBeTruthy()
    expect(screen.getByText("Oplog window")).toBeTruthy()
  })

  it("derives the getting started checklist from the server state", async () => {
    await renderStudio("/", {
      policies: [{ _id: "todos", exposed: true, realtime: false, policies: [] }],
    })
    expect(await screen.findByText("4 of 5 done")).toBeTruthy()
    expect(itemState("Expose a collection")).toBe("true")
    expect(itemState("Publish a policy")).toBe("true")
    expect(itemState("Create a publishable key")).toBe("true")
    expect(itemState("Configure CORS origins for your app")).toBe("true")
    expect(itemState("Turn on realtime for a collection")).toBe("false")
    const todo = screen.getByRole("link", { name: "Turn on realtime for a collection" })
    expect(todo.getAttribute("href")).toBe("/studio/data")
  })

  it("marks everything to do on a fresh server", () => {
    const items = checklistOf([{ name: "todos", exposed: false, realtime: false }], [], {
      corsOrigins: [],
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
