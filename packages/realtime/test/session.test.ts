import { describe, expect, it } from "vitest"
import { FULL_COVERAGE, type RealtimeSocket, Session } from "../src/session.ts"

function open(): { session: Session; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const socket: RealtimeSocket = {
    send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
    close: () => {},
    bufferedAmount: 0,
  }
  const session = new Session("n1.s", new Set(["diff"]), {
    resumeBufferBytes: 1 << 20,
    softQueueBytes: 1 << 20,
    hardQueueBytes: 1 << 22,
  })
  session.connect(socket, {
    t: "welcome",
    sid: "n1.s",
    v: 1,
    resumed: false,
    hb: 25_000,
    pv: "",
    ct: "1",
    caps: ["diff"],
    limits: { subs: 10 },
  })
  return { session, sent }
}

describe("Session merge box", () => {
  it("sends the difference when a known document is added again with new content", () => {
    const { session, sent } = open()
    const listener = session.listener("tasks", "s", (doc) => doc, FULL_COVERAGE)
    listener.added("tasks/t1", "t1", { _id: "t1", title: "old" }, "1")
    listener.ready("1")
    session.rebind("s")
    listener.added("tasks/t1", "t1", { _id: "t1", title: "new" }, "2")
    listener.ready("2")
    session.flush()
    expect(sent.slice(1).map((m) => m["t"])).toEqual(["added", "ready", "changed"])
    expect(sent.at(-1)).toMatchObject({ t: "changed", id: "t1", set: { title: "new" } })
  })

  it("sends nothing when the same document is added again unchanged", () => {
    const { session, sent } = open()
    const listener = session.listener("tasks", "s", (doc) => doc, FULL_COVERAGE)
    listener.added("tasks/t1", "t1", { _id: "t1", title: "same" }, "1")
    listener.added("tasks/t1", "t1", { _id: "t1", title: "same" }, "2")
    session.flush()
    expect(sent.slice(1).map((m) => m["t"])).toEqual(["added"])
  })
})
