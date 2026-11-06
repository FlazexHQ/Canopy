import { describe, expect, it } from "vitest"
import { docKey, EchoWaiter } from "../src/index.ts"

const key = (id: number) => docKey("todos", id)

describe("EchoWaiter", () => {
  it("resolves once every id has an event at or after the write time", async () => {
    const waiter = new EchoWaiter()
    let done: boolean | undefined
    const wait = waiter.wait("todos", [1, 2], "100", 5000).then((echoed) => {
      done = echoed
    })
    waiter.processed([{ key: key(1), ct: "100" }])
    await Promise.resolve()
    expect(done).toBeUndefined()
    waiter.processed([{ key: key(2), ct: "100" }])
    await wait
    expect(done).toBe(true)
    expect(waiter.pending).toBe(0)
  })

  it("never takes an equal cluster time of another document as proof", async () => {
    const waiter = new EchoWaiter()
    let done: boolean | undefined
    void waiter.wait("todos", [1], "100", 5000).then((echoed) => {
      done = echoed
    })
    waiter.processed([
      { key: key(9), ct: "100" },
      { key: docKey("other", 1), ct: "100" },
      { key: key(1), ct: "99" },
    ])
    await Promise.resolve()
    expect(done).toBeUndefined()
    waiter.processed([{ key: key(7), ct: "101" }])
    await Promise.resolve()
    expect(done).toBe(true)
  })

  it("resolves on progress past the write time", async () => {
    const waiter = new EchoWaiter()
    const wait = waiter.wait("todos", [1], "100", 5000)
    waiter.advance("100")
    expect(waiter.pending).toBe(1)
    waiter.advance("101")
    expect(await wait).toBe(true)
  })

  it("resolves at once when the stream already passed the write", async () => {
    const waiter = new EchoWaiter()
    waiter.processed([
      { key: key(1), ct: "100" },
      { key: key(2), ct: "100" },
    ])
    expect(await waiter.wait("todos", [1, 2], "100", 5000)).toBe(true)
    expect(waiter.pending).toBe(0)
    waiter.processed([{ key: key(3), ct: "200" }])
    expect(await waiter.wait("todos", [1], "150", 5000)).toBe(true)
    const pending = waiter.wait("todos", [1], "200", 5000)
    expect(waiter.pending).toBe(1)
    waiter.close()
    expect(await pending).toBe(false)
  })

  it("compares cluster times numerically, not as text", async () => {
    const waiter = new EchoWaiter()
    waiter.processed([{ key: key(1), ct: "99" }])
    const wait = waiter.wait("todos", [1], "100", 5000)
    expect(waiter.pending).toBe(1)
    waiter.processed([{ key: key(2), ct: "1000" }])
    expect(await wait).toBe(true)
  })

  it("times out with false", async () => {
    const waiter = new EchoWaiter()
    expect(await waiter.wait("todos", [1], "100", 10)).toBe(false)
    expect(waiter.pending).toBe(0)
  })
})
