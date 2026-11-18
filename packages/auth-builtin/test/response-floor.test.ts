import { describe, expect, it } from "vitest"
import { ResponseFloor } from "../src/response-floor.ts"

describe("ResponseFloor", () => {
  it("holds answers to the floor while every answer is faster", () => {
    const floor = new ResponseFloor(80)
    expect(floor.target("/sign-up/email")).toBe(80)
    floor.record("/sign-up/email", 12)
    floor.record("/sign-up/email", 30)
    expect(floor.target("/sign-up/email")).toBe(80)
  })

  it("holds a fast answer as long as the slowest recent answer on the same route", () => {
    const floor = new ResponseFloor(80)
    floor.record("/sign-up/email", 135)
    floor.record("/sign-up/email", 20)
    expect(floor.target("/sign-up/email")).toBe(135)
    expect(floor.target("/sign-in/email")).toBe(80)
  })

  it("forgets a slow answer after 64 newer ones", () => {
    const floor = new ResponseFloor(80)
    floor.record("/sign-up/email", 400)
    for (let i = 0; i < 63; i++) floor.record("/sign-up/email", 10)
    expect(floor.target("/sign-up/email")).toBe(400)
    floor.record("/sign-up/email", 10)
    expect(floor.target("/sign-up/email")).toBe(80)
  })

  it("never holds an answer longer than one second, unless the floor itself is longer", () => {
    const floor = new ResponseFloor(80)
    floor.record("/sign-up/email", 5000)
    expect(floor.target("/sign-up/email")).toBe(1000)
    const long = new ResponseFloor(1500)
    long.record("/sign-up/email", 5000)
    expect(long.target("/sign-up/email")).toBe(1500)
  })
})
