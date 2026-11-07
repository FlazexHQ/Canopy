import { act, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { RealtimeEvent } from "../src/api/contract.ts"
import { chartSummary } from "../src/features/realtime/lag-chart.tsx"
import { setTailSourceFactory, type TailSource } from "../src/features/realtime/tail-source.ts"
import { renderStudio, screen } from "./harness.tsx"

class FakeSource implements TailSource {
  static last: FakeSource | undefined
  readonly url: string
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly listeners = new Map<string, ((event: { readonly data?: unknown }) => void)[]>()
  constructor(url: string) {
    this.url = url
    FakeSource.last = this
  }
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close(): void {
    this.closed = true
  }
  push(event: RealtimeEvent): void {
    for (const listener of this.listeners.get("change") ?? [])
      listener({ data: JSON.stringify(event) })
  }
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
  FakeSource.last = undefined
})

const event = (id: string, coll: string, op: string): RealtimeEvent => ({
  id,
  ct: { $timestamp: { t: 1, i: 1 } },
  wallTime: "2026-11-07T10:00:00.000Z",
  coll,
  op,
  docId: { $oid: "65f1a2b3c4d5e6f7a8b90001" },
  fields: op === "update" ? ["done"] : null,
})

const READ_OWN = {
  _id: "todos",
  exposed: true,
  realtime: true,
  policies: [
    {
      name: "read own",
      kind: "permissive" as const,
      ops: ["read" as const],
      roles: ["authenticated"],
      using: '{"ownerId":{"$auth":"sub"}}',
    },
  ],
}

describe("Realtime page", () => {
  it("shows engine counts and the lag samples as an accessible table", async () => {
    await renderStudio("/realtime")
    const stat = (label: string) =>
      screen
        .getAllByText(label)
        .find((element) => element.tagName === "DT")
        ?.parentElement?.querySelector("dd")?.textContent
    await screen.findByText("Subscriptions")
    expect(stat("Subscriptions")).toBe("4")
    expect(stat("Connections")).toBe("2")
    expect(stat("Sessions")).toBe("3")
    expect(stat("Change stream lag")).toMatch(/^\d+ ms$/)
    expect(await screen.findAllByTestId("lag-sample")).toHaveLength(60)
    expect(screen.getByText(/^60 samples\. Lag ranged from/)).toBeTruthy()
  })

  it("lists connections and observers from the engine", async () => {
    const { user } = await renderStudio("/realtime")
    await user.click(await screen.findByRole("tab", { name: "Connections" }))
    const rows = await screen.findAllByTestId("connection")
    expect(rows).toHaveLength(3)
    expect(rows[1]?.textContent).toContain("u_bob")
    expect(rows[1]?.textContent).toContain("sse")
    expect(within(rows[2] as HTMLElement).getByText("Waiting to resume")).toBeTruthy()
    await user.click(screen.getByRole("tab", { name: "Observers" }))
    const observers = await screen.findAllByTestId("observer")
    expect(observers.map((row) => row.querySelector("td")?.textContent)).toEqual([
      "obs_todos_alice",
      "obs_todos_bob",
      "obs_notes_bob",
      "obs_todos_anon",
    ])
  })

  it("tails change events from the tail endpoint and filters them", async () => {
    restore = setTailSourceFactory((url) => new FakeSource(url))
    const { user } = await renderStudio("/realtime")
    await user.click(await screen.findByRole("tab", { name: "Event tail" }))
    expect(FakeSource.last?.url).toBe("http://studio.test/admin/v1/realtime/tail")
    act(() => {
      FakeSource.last?.push(event("e1", "todos", "insert"))
      FakeSource.last?.push(event("e2", "notes", "update"))
      FakeSource.last?.push(event("e3", "todos", "delete"))
      FakeSource.last?.push(event("bad", "todos", "insert"))
    })
    act(() => {
      for (const listener of FakeSource.last?.listeners.get("change") ?? [])
        listener({ data: "{not json" })
    })
    expect(await screen.findAllByTestId("tail-event")).toHaveLength(4)
    await user.selectOptions(screen.getByLabelText("Collection"), "todos")
    expect(screen.getAllByTestId("tail-event")).toHaveLength(3)
    await user.selectOptions(screen.getByLabelText("Operation"), "delete")
    const rows = screen.getAllByTestId("tail-event")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain("delete")
    expect(screen.getByText("1 of 4 events shown")).toBeTruthy()
  })

  it("holds events while paused and shows them on resume", async () => {
    restore = setTailSourceFactory((url) => new FakeSource(url))
    const { user } = await renderStudio("/realtime")
    await user.click(await screen.findByRole("tab", { name: "Event tail" }))
    await user.click(screen.getByRole("button", { name: "Pause" }))
    act(() => FakeSource.last?.push(event("p1", "todos", "insert")))
    expect(await screen.findByText("Paused, 1 new events waiting")).toBeTruthy()
    expect(screen.queryAllByTestId("tail-event")).toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Resume" }))
    expect(await screen.findAllByTestId("tail-event")).toHaveLength(1)
  })

  it("traces an event to the subscribers that got it and those DLS filtered out", async () => {
    const { user, api, mock } = await renderStudio("/realtime", { policies: [READ_OWN] })
    await api.insertDocument("todos", { title: "Alice only", ownerId: "u_alice" })
    const id = mock.state.events[0]?.id ?? ""
    expect(id).not.toBe("")
    await user.click(await screen.findByRole("tab", { name: "Event trace" }))
    await user.type(screen.getByLabelText("Event id"), id)
    await user.click(screen.getByRole("button", { name: "Show trace" }))
    expect(await screen.findByText(/^insert on todos at/)).toBeTruthy()
    const candidates = await screen.findAllByTestId("trace-candidate")
    const alice = candidates.find((card) => card.textContent?.includes("obs_todos_alice"))
    expect(alice?.textContent).toContain("Entered the result")
    expect(alice?.textContent).toContain("u_alice (connection s_7f3a, subscription q1)")
    const bob = candidates.find((card) => card.textContent?.includes("obs_todos_bob"))
    expect(bob?.textContent).toContain("Did not match the effective filter")
    const filtered = within(bob as HTMLElement).getByTestId("filtered-out")
    expect(filtered.textContent).toContain("u_bob")
    expect(filtered.textContent).toContain("Policy: read own")
    const anon = candidates.find((card) => card.textContent?.includes("obs_todos_anon"))
    expect(within(anon as HTMLElement).getByTestId("filtered-out").textContent).toContain(
      "No read policy applies to this subscriber",
    )
  })

  it("opens the trace of an event picked in the tail", async () => {
    restore = setTailSourceFactory((url) => new FakeSource(url))
    const { user, api, mock } = await renderStudio("/realtime", { policies: [READ_OWN] })
    await api.insertDocument("todos", { title: "Picked", ownerId: "u_bob" })
    const picked = mock.state.events[0] as RealtimeEvent
    await user.click(await screen.findByRole("tab", { name: "Event tail" }))
    act(() => FakeSource.last?.push(picked))
    await user.click(await screen.findByRole("button", { name: `Trace event ${picked.id}` }))
    expect((screen.getByLabelText("Event id") as HTMLInputElement).value).toBe(picked.id)
    const candidates = await screen.findAllByTestId("trace-candidate")
    const bob = candidates.find((card) => card.textContent?.includes("obs_todos_bob"))
    expect(bob?.textContent).toContain("u_bob (connection s_91bc, subscription q1)")
  })

  it("says when an event left the trace buffer", async () => {
    const { user } = await renderStudio("/realtime")
    await user.click(await screen.findByRole("tab", { name: "Event trace" }))
    await user.type(screen.getByLabelText("Event id"), "evt_gone")
    await user.click(screen.getByRole("button", { name: "Show trace" }))
    await waitFor(() => expect(screen.getByText(/no longer in the trace buffer/)).toBeTruthy())
  })
})

describe("chartSummary", () => {
  it("describes range and the latest sample", () => {
    expect(
      chartSummary([
        { t: 1, lagMs: 30, eventsPerSecond: 2 },
        { t: 2, lagMs: 90, eventsPerSecond: 4 },
        { t: 3, lagMs: 45, eventsPerSecond: 3 },
      ]),
    ).toBe(
      "3 samples. Lag ranged from 30 ms to 90 ms and is 45 ms now. Throughput is 3 events per second.",
    )
    expect(chartSummary([])).toBe("No samples yet.")
  })
})
