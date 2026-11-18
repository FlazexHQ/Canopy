import { describe, expect, it } from "vitest"
import { parseCron } from "../src/index.ts"

const at = (iso: string): Date => new Date(iso)
const next = (expression: string, after: string): string =>
  parseCron(expression).next(at(after)).toISOString()
const previous = (expression: string, before: string): string =>
  parseCron(expression).previous(at(before)).toISOString()

describe("parseCron", () => {
  it("finds the next minute, strictly after the given time", () => {
    expect(next("* * * * *", "2026-11-18T10:15:00.000Z")).toBe("2026-11-18T10:16:00.000Z")
    expect(next("* * * * *", "2026-11-18T10:15:59.999Z")).toBe("2026-11-18T10:16:00.000Z")
  })

  it("handles steps, ranges and lists", () => {
    expect(next("*/15 * * * *", "2026-11-18T10:15:00Z")).toBe("2026-11-18T10:30:00.000Z")
    expect(next("5-10/2 * * * *", "2026-11-18T10:07:00Z")).toBe("2026-11-18T10:09:00.000Z")
    expect(next("5-10/2 * * * *", "2026-11-18T10:09:00Z")).toBe("2026-11-18T11:05:00.000Z")
    expect(next("0 9,17 * * *", "2026-11-18T09:00:00Z")).toBe("2026-11-18T17:00:00.000Z")
    expect(next("30 2/6 * * *", "2026-11-18T09:00:00Z")).toBe("2026-11-18T14:30:00.000Z")
  })

  it("rolls over days, months and years", () => {
    expect(next("0 0 * * *", "2026-12-31T12:00:00Z")).toBe("2027-01-01T00:00:00.000Z")
    expect(next("0 0 1 * *", "2026-11-18T00:00:00Z")).toBe("2026-12-01T00:00:00.000Z")
    expect(next("0 0 31 * *", "2026-11-18T00:00:00Z")).toBe("2026-12-31T00:00:00.000Z")
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z")
  })

  it("reads month and day names, and 7 as Sunday", () => {
    // 2026-11-18 is a Wednesday.
    expect(next("0 12 * * mon", "2026-11-18T00:00:00Z")).toBe("2026-11-23T12:00:00.000Z")
    expect(next("0 12 * * 7", "2026-11-18T00:00:00Z")).toBe("2026-11-22T12:00:00.000Z")
    expect(next("0 12 * * MON-FRI", "2026-11-20T13:00:00Z")).toBe("2026-11-23T12:00:00.000Z")
    expect(next("0 0 1 jan *", "2026-11-18T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z")
  })

  it("matches either day field when both are restricted, as cron does", () => {
    // The 1st of the month or any Friday: Friday 2026-11-20 comes first.
    expect(next("0 0 1 * 5", "2026-11-18T00:00:00Z")).toBe("2026-11-20T00:00:00.000Z")
    // With an unrestricted day of week, only the 1st matches.
    expect(next("0 0 1 * *", "2026-11-18T00:00:00Z")).toBe("2026-12-01T00:00:00.000Z")
    // A stepped star counts as unrestricted, so both must match: an odd day that is a Monday (not the 19th).
    expect(next("0 0 */2 * mon", "2026-11-18T00:00:00Z")).toBe("2026-11-23T00:00:00.000Z")
  })

  it("expands the macros", () => {
    expect(next("@hourly", "2026-11-18T10:15:00Z")).toBe("2026-11-18T11:00:00.000Z")
    expect(next("@daily", "2026-11-18T10:15:00Z")).toBe("2026-11-19T00:00:00.000Z")
    expect(next("@weekly", "2026-11-18T10:15:00Z")).toBe("2026-11-22T00:00:00.000Z")
    expect(next("@monthly", "2026-11-18T10:15:00Z")).toBe("2026-12-01T00:00:00.000Z")
    expect(next("@yearly", "2026-11-18T10:15:00Z")).toBe("2027-01-01T00:00:00.000Z")
  })

  it("finds the previous fire time at or before the given time", () => {
    expect(previous("0 * * * *", "2026-11-18T10:00:00Z")).toBe("2026-11-18T10:00:00.000Z")
    expect(previous("0 * * * *", "2026-11-18T10:59:59Z")).toBe("2026-11-18T10:00:00.000Z")
    expect(previous("0 3 * * *", "2026-11-18T02:00:00Z")).toBe("2026-11-17T03:00:00.000Z")
    expect(previous("0 0 1 * *", "2026-11-18T00:00:00Z")).toBe("2026-11-01T00:00:00.000Z")
    expect(previous("0 0 1 jan *", "2026-11-18T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z")
    expect(previous("0 0 29 2 *", "2027-01-01T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z")
  })

  it("agrees with itself: previous of next is next", () => {
    for (const expression of ["*/7 * * * *", "15 4 * * 1-5", "0 0 1,15 * *", "0 22 * * sun"]) {
      const schedule = parseCron(expression)
      let t = at("2026-11-18T00:00:00Z")
      for (let i = 0; i < 20; i += 1) {
        const fire = schedule.next(t)
        expect(schedule.previous(fire).getTime()).toBe(fire.getTime())
        expect(schedule.previous(new Date(fire.getTime() - 60_000)).getTime()).toBeLessThanOrEqual(
          t.getTime(),
        )
        t = fire
      }
    }
  })

  it("refuses malformed expressions with the reason", () => {
    expect(() => parseCron("* * * *")).toThrow(/five fields/)
    expect(() => parseCron("60 * * * *")).toThrow(/minute 60 is outside 0 to 59/)
    expect(() => parseCron("* 24 * * *")).toThrow(/hour 24/)
    expect(() => parseCron("* * 0 * *")).toThrow(/day of month 0/)
    expect(() => parseCron("* * * 13 *")).toThrow(/month 13/)
    expect(() => parseCron("* * * * 8")).toThrow(/day of week 8/)
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/)
    expect(() => parseCron("10-5 * * * *")).toThrow(/backwards/)
    expect(() => parseCron("* * * * funday")).toThrow(/not a day of week/)
    expect(() => parseCron("1,,2 * * * *")).toThrow(/malformed/)
  })

  it("refuses an expression that never fires", () => {
    expect(() => parseCron("0 0 30 2 *")).toThrow(/never fires/)
    expect(() => parseCron("0 0 31 4,6,9,11 *")).toThrow(/never fires/)
  })
})
