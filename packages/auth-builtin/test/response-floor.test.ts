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

  it("holds a fast answer as long as the slow answers on the same route", () => {
    const floor = new ResponseFloor(80)
    for (let i = 0; i < 6; i++) {
      floor.record("/sign-up/email", 135)
      floor.record("/sign-up/email", 20)
    }
    expect(floor.target("/sign-up/email")).toBe(135)
    expect(floor.target("/sign-in/email")).toBe(80)
  })

  it("is not set by one or two stalled answers among many", () => {
    const floor = new ResponseFloor(80)
    floor.record("/sign-up/email", 900)
    floor.record("/sign-up/email", 700)
    for (let i = 0; i < 20; i++) floor.record("/sign-up/email", 120)
    expect(floor.target("/sign-up/email")).toBe(120)
  })

  it("covers a slow path seen three times even when most answers take the fast one", () => {
    const floor = new ResponseFloor(80)
    for (let i = 0; i < 60; i++) floor.record("/sign-up/email", 15)
    for (let i = 0; i < 3; i++) floor.record("/sign-up/email", 140)
    expect(floor.target("/sign-up/email")).toBe(140)
  })

  it("forgets answers after 64 newer ones", () => {
    const floor = new ResponseFloor(80)
    for (let i = 0; i < 64; i++) floor.record("/sign-up/email", 300)
    expect(floor.target("/sign-up/email")).toBe(300)
    for (let i = 0; i < 64; i++) floor.record("/sign-up/email", 10)
    expect(floor.target("/sign-up/email")).toBe(80)
  })

  it("never holds an answer longer than one second, unless the floor itself is longer", () => {
    const floor = new ResponseFloor(80)
    for (let i = 0; i < 10; i++) floor.record("/sign-up/email", 5000)
    expect(floor.target("/sign-up/email")).toBe(1000)
    const long = new ResponseFloor(1500)
    for (let i = 0; i < 10; i++) long.record("/sign-up/email", 5000)
    expect(long.target("/sign-up/email")).toBe(1500)
  })
})
