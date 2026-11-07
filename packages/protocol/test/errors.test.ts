import { describe, expect, expectTypeOf, it } from "vitest"
import {
  CanopyError,
  ConflictError,
  ErrorCode,
  errorFromWire,
  isCanopyError,
  NotFoundError,
} from "../src/index.ts"

describe("isCanopyError", () => {
  it("recognizes Canopy errors and narrows by code", () => {
    const error: unknown = new ConflictError("changed first")
    expect(isCanopyError(error)).toBe(true)
    expect(isCanopyError(error, ErrorCode.Conflict)).toBe(true)
    expect(isCanopyError(error, ErrorCode.NotFound)).toBe(false)
    if (isCanopyError(error, "CANOPY_CONFLICT"))
      expectTypeOf(error.code).toEqualTypeOf<"CANOPY_CONFLICT">()
  })

  it("rejects look alikes that are not Canopy errors", () => {
    expect(isCanopyError({ code: "CANOPY_CONFLICT", message: "x" })).toBe(false)
    expect(isCanopyError(Object.assign(new Error("x"), { code: "CANOPY_CONFLICT" }))).toBe(false)
    expect(isCanopyError(null)).toBe(false)
    expect(isCanopyError("CANOPY_CONFLICT")).toBe(false)
  })

  it("recognizes errors from another copy of the package through the shared brand", () => {
    class Foreign extends Error {
      readonly code = "CANOPY_NOT_FOUND"
    }
    const foreign = new Foreign("gone")
    expect(isCanopyError(foreign)).toBe(false)
    Object.defineProperty(foreign, Symbol.for("canopy.error"), { value: true })
    expect(foreign instanceof CanopyError).toBe(false)
    expect(isCanopyError(foreign, ErrorCode.NotFound)).toBe(true)
  })

  it("decodes CANOPY_NOT_FOUND as a NotFoundError", () => {
    const error = errorFromWire({ code: ErrorCode.NotFound, msg: "Document not found" })
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({ name: "NotFoundError", code: "CANOPY_NOT_FOUND", status: 404 })
  })
})
