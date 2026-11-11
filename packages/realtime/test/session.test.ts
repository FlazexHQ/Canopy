import { encodeMessage, ObjectId, type SequencedMessage } from "@canopy/protocol"
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

  it("still sends the first ready when the subscription moves before its snapshot is ready", () => {
    const { session, sent } = open()
    const listener = session.listener("tasks", "s", (doc) => doc, FULL_COVERAGE)
    listener.added("tasks/t9", "t9", { _id: "t9" }, "1")
    session.rebind("s")
    listener.added("tasks/t1", "t1", { _id: "t1" }, "2")
    listener.ready("2")
    session.rebind("s")
    listener.added("tasks/t1", "t1", { _id: "t1" }, "3")
    listener.ready("3")
    session.flush()
    expect(sent.slice(1).map((m) => [m["t"], m["id"] ?? m["s"]])).toEqual([
      ["added", "t9"],
      ["added", "t1"],
      ["removed", "t9"],
      ["ready", "s"],
    ])
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

describe("Session frames shared between sessions", () => {
  function raw(caps: string[]): { session: Session; texts: string[] } {
    const texts: string[] = []
    const socket: RealtimeSocket = {
      send: (text) => texts.push(text),
      close: () => {},
      bufferedAmount: 0,
    }
    const session = new Session(`n1.${caps.join("")}`, new Set(caps), {
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
      caps,
      limits: { subs: 10 },
    })
    return { session, texts }
  }

  const first = { _id: new ObjectId("000000000000000000000001"), a: 1, at: new Date(0), b: "x" }
  const second = { _id: first._id, a: 2.5, at: new Date(0), b: "x", n: 2n ** 60n }
  const same = { ...second }
  const key = "tasks/1"

  /** Feeds the same document objects to every listener, as an observer does. */
  function drive(listeners: ReturnType<Session["listener"]>[]): void {
    for (const listener of listeners) listener.added(key, first._id, first, "5")
    for (const listener of listeners) listener.ready("5")
    for (const listener of listeners) listener.changed(key, first._id, second, "6")
    for (const listener of listeners) listener.changed(key, first._id, same, "7")
    for (const listener of listeners) listener.removed(key, first._id, "8")
  }

  const expected = (diffs: boolean, sub: string): string[] =>
    [
      { t: "added", c: "tasks", id: first._id, d: first, ct: "5", s: [sub], seq: 1 },
      { t: "ready", s: sub, ct: "5", seq: 2 },
      diffs
        ? {
            t: "changed",
            c: "tasks",
            id: first._id,
            ct: "6",
            set: { a: 2.5, n: 2n ** 60n },
            seq: 3,
          }
        : { t: "changed", c: "tasks", id: first._id, ct: "6", d: second, replace: true, seq: 3 },
      { t: "removed", c: "tasks", id: first._id, ct: "8", s: [sub], seq: 4 },
    ].map((message) => encodeMessage(message as SequencedMessage))

  it("writes the same bytes as encoding each message on its own, for every session", () => {
    const withDiff = [raw(["diff"]), raw(["diff"])]
    const plain = raw([])
    const sessions = [...withDiff, plain]
    drive(
      sessions.map(({ session }, index) =>
        session.listener("tasks", `s${index}`, (doc) => doc, FULL_COVERAGE),
      ),
    )
    for (const [index, { session, texts }] of sessions.entries()) {
      session.flush()
      expect(texts.slice(1)).toEqual(expected(index < 2, `s${index}`))
    }
  })

  it("replays the same bytes after a reconnect", () => {
    const { session, texts } = raw(["diff"])
    drive([session.listener("tasks", "s", (doc) => doc, FULL_COVERAGE)])
    session.flush()
    const sent = texts.slice(1)
    texts.length = 0
    expect(session.replayAfter(1)).toBe(true)
    expect(texts).toEqual(sent.slice(1))
  })

  it("merges overlapping subscriptions as before, sending only what changed", () => {
    const { session, texts } = raw(["diff"])
    const full = session.listener("tasks", "a", (doc) => doc, FULL_COVERAGE)
    const narrow = session.listener("tasks", "b", (doc) => ({ _id: doc["_id"], b: doc["b"] }), {
      covers: (field) => field === "_id" || field === "b",
    })
    full.added(key, first._id, first, "5")
    narrow.added(key, first._id, { _id: first._id, b: "x" }, "5")
    full.changed(key, first._id, second, "6")
    narrow.changed(key, first._id, { _id: first._id, b: "y" }, "7")
    session.flush()
    expect(texts.slice(1)).toEqual(
      [
        { t: "added", c: "tasks", id: first._id, d: first, ct: "5", s: ["a"], seq: 1 },
        { t: "added", c: "tasks", id: first._id, ct: "5", s: ["b"], seq: 2 },
        { t: "changed", c: "tasks", id: first._id, ct: "6", set: { a: 2.5, n: 2n ** 60n }, seq: 3 },
        { t: "changed", c: "tasks", id: first._id, ct: "7", set: { b: "y" }, seq: 4 },
      ].map((message) => encodeMessage(message as SequencedMessage)),
    )
  })
})
