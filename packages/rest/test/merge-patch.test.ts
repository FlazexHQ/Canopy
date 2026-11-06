import { applyUpdate } from "@canopy/matcher"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import { mergePatchToUpdate } from "../src/index.ts"

/** RFC 7396 section 2 MergePatch, for targets whose patched members are objects or absent. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch
  const out: Record<string, unknown> =
    typeof target === "object" && target !== null && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = mergePatch(out[key], value)
  }
  return out
}

describe("mergePatchToUpdate", () => {
  it("converts members to $set and null members to $unset", () => {
    expect(
      mergePatchToUpdate({ a: 1, b: null, c: { d: 2, e: null }, f: [1, { g: null }] }),
    ).toEqual({
      $set: { a: 1, "c.d": 2, f: [1, { g: null }] },
      $unset: { b: "", "c.e": "" },
    })
  })

  it("gives the result RFC 7396 defines when nested targets are objects", () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        {
          _id: 1,
          title: "Goodbye!",
          author: { givenName: "John", familyName: "Doe" },
          tags: ["a"],
        },
        {
          title: "Hello!",
          phoneNumber: "+01-123-456-7890",
          author: { familyName: null },
          tags: ["b"],
        },
      ],
      [{ _id: 1, a: { b: { c: 1, d: 2 } } }, { a: { b: { c: null, e: 3 } } }],
      [{ _id: 1, a: "x" }, { b: { c: 1 } }],
      [
        { _id: 1, a: 1 },
        { a: null, missing: null },
      ],
    ]
    for (const [target, patch] of cases) {
      expect(applyUpdate(target, mergePatchToUpdate(patch))).toEqual(mergePatch(target, patch))
    }
  })

  it("rejects patches that are not objects, change nothing or touch _id and operator keys", () => {
    const code = (patch: unknown): string => {
      try {
        mergePatchToUpdate(patch)
      } catch (error: unknown) {
        if (error instanceof CanopyError) return error.code
      }
      return "none"
    }
    expect(code([1])).toBe(ErrorCode.InvalidQuery)
    expect(code("x")).toBe(ErrorCode.InvalidQuery)
    expect(code({})).toBe(ErrorCode.InvalidQuery)
    expect(code({ a: {} })).toBe(ErrorCode.InvalidQuery)
    expect(code({ _id: 2 })).toBe(ErrorCode.InvalidQuery)
    expect(code({ $set: { a: 1 } })).toBe(ErrorCode.InvalidQuery)
    expect(code({ "a.b": 1 })).toBe(ErrorCode.InvalidQuery)
    expect(code({ a: { $inc: 1 } })).toBe(ErrorCode.InvalidQuery)
  })
})
