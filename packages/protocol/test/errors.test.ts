import { describe, expect, expectTypeOf, it } from "vitest"
import {
  AuthHookFailedError,
  CanopyError,
  ConflictError,
  ErrorCode,
  errorFromWire,
  isCanopyError,
  NotFoundError,
} from "../src/index.ts"

describe("hints", () => {
  it("gives the common codes a hint and a docs page, and lets an error override them", () => {
    const forbidden = new CanopyError(ErrorCode.Forbidden, "No policy grants read on 'todos'")
    expect(forbidden.hint).toMatch(/allow rule/)
    expect(forbidden.docs).toBe("forbidden")
    const custom = new CanopyError(ErrorCode.Forbidden, "x", {
      hint: "Ask an admin",
      docs: "custom",
    })
    expect([custom.hint, custom.docs]).toEqual(["Ask an admin", "custom"])
    for (const code of [
      ErrorCode.Unauthorized,
      ErrorCode.TokenExpired,
      ErrorCode.NotFound,
      ErrorCode.PolicyViolation,
      ErrorCode.InvalidQuery,
      ErrorCode.Conflict,
      ErrorCode.ValidationFailed,
      ErrorCode.RateLimited,
      ErrorCode.SubscriptionTooLarge,
    ]) {
      const error = new CanopyError(code, "m")
      expect(error.hint?.length ?? 0).toBeGreaterThan(20)
      expect(error.docs).toMatch(/^[a-z-]+$/)
    }
    expect(new CanopyError(ErrorCode.Internal, "m").hint).toBeUndefined()
    expect(new CanopyError(ErrorCode.Internal, "m").docs).toBeUndefined()
  })

  it("keeps the wire frame of realtime errors to the code and message", () => {
    expect(new CanopyError(ErrorCode.Forbidden, "no").toWire()).toEqual({
      code: ErrorCode.Forbidden,
      msg: "no",
    })
    expect(errorFromWire({ code: ErrorCode.Conflict, msg: "x" }).docs).toBe("conflict")
  })
})

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

  it("decodes CANOPY_AUTH_HOOK_FAILED as an AuthHookFailedError with status 500", () => {
    const error = errorFromWire({ code: ErrorCode.AuthHookFailed, msg: "hook timed out" })
    expect(error).toBeInstanceOf(AuthHookFailedError)
    expect(error).toMatchObject({
      name: "AuthHookFailedError",
      code: "CANOPY_AUTH_HOOK_FAILED",
      status: 500,
    })
    expect(isCanopyError(error, "CANOPY_AUTH_HOOK_FAILED")).toBe(true)
  })
})
