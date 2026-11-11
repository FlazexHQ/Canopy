import { describe, expect, it } from "vitest"
import type { Doc, NormalizedEvent } from "../src/event.ts"
import type { Observer } from "../src/observers.ts"
import { ObserverRegistry } from "../src/registry.ts"

/** The parts of an observer the registry reads. */
function observer(key: string, filter: Record<string, unknown> = { ownerId: key }): Observer {
  return {
    key,
    type: "filter",
    query: {
      coll: "todos",
      filter,
      sort: undefined,
      limit: undefined,
      readable: (doc: Doc) => doc,
    },
  } as unknown as Observer
}

function deleted(key: string): NormalizedEvent {
  return {
    ct: 1n as unknown as NormalizedEvent["ct"],
    token: undefined,
    wallTime: undefined,
    coll: "todos",
    op: "delete",
    id: key,
    key,
    pre: undefined,
    post: null,
    diff: undefined,
  }
}

describe("ObserverRegistry", () => {
  it("routes an event on a shared document only to the observers still registered", () => {
    const registry = new ObserverRegistry()
    const a = observer("a")
    const b = observer("b")
    registry.add(a)
    registry.add(b)
    registry.memberAdded(a, "d1")
    registry.memberAdded(b, "d1")
    registry.memberAdded(a, "d2")

    registry.remove(a)
    expect([...registry.candidates(deleted("d1"))]).toEqual([b])
    expect([...registry.candidates(deleted("d2"))]).toEqual([])

    registry.remove(b)
    expect([...registry.candidates(deleted("d1"))]).toEqual([])
  })

  it("forgets documents an observer released before it was removed", () => {
    const registry = new ObserverRegistry()
    const a = observer("a")
    registry.add(a)
    registry.memberAdded(a, "d1")
    registry.memberRemoved(a, "d1")
    registry.remove(a)

    const again = observer("a")
    registry.add(again)
    registry.memberAdded(again, "d2")
    expect([...registry.candidates(deleted("d1"))]).toEqual([])
    expect([...registry.candidates(deleted("d2"))]).toEqual([again])
  })

  it("removes an observer in time proportional to its own documents, not to every tracked one", () => {
    const registry = new ObserverRegistry()
    const big = observer("big")
    registry.add(big)
    for (let i = 0; i < 200_000; i += 1) registry.memberAdded(big, `big-${i}`)
    const small = Array.from({ length: 2000 }, (_, i) => observer(`s${i}`))
    for (const [i, each] of small.entries()) {
      registry.add(each)
      registry.memberAdded(each, `small-${i}`)
    }

    const started = performance.now()
    for (const each of small) registry.remove(each)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect([...registry.candidates(deleted("small-7"))]).toEqual([])
    expect([...registry.candidates(deleted("big-199999"))]).toEqual([big])
  })
})
