import { describe, expect, expectTypeOf, it } from "vitest"
import {
  AuthHookFailedError,
  CanopyError,
  ConflictError,
  DiagnosticError,
  ErrorCode,
  errorFromWire,
  isCanopyError,
  NotFoundError,
  toCanopyError,
  UnauthorizedError,
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
    const fields = { code: "CANOPY_CONFLICT", name: "ConflictError", message: "x" }
    for (const error of [fields, Object.assign(new Error("x"), fields)]) {
      expect(error instanceof CanopyError).toBe(false)
      expect(error instanceof ConflictError).toBe(false)
      expect(isCanopyError(error)).toBe(false)
    }
    expect(isCanopyError(null)).toBe(false)
    expect(isCanopyError("CANOPY_CONFLICT")).toBe(false)
  })

  it("recognizes errors from another copy of the package through the shared brand", () => {
    class Foreign extends Error {
      readonly code = ErrorCode.Conflict
      override name = "ConflictError"
    }
    const foreign = new Foreign("changed first")
    expect(foreign instanceof CanopyError).toBe(false)
    Object.defineProperty(foreign, Symbol.for("canopy.error"), { value: true })
    expect(foreign instanceof CanopyError).toBe(true)
    expect(foreign instanceof ConflictError).toBe(true)
    expect(foreign instanceof NotFoundError).toBe(false)
    expect(isCanopyError(foreign, ErrorCode.Conflict)).toBe(true)
    expect(toCanopyError(foreign)).toBe(foreign)
  })

  it("distinguishes errors with a shared code and supports errors with multiple codes", () => {
    const diagnostic = new DiagnosticError({ code: ErrorCode.Conflict, summary: "changed first" })
    expect(diagnostic instanceof ConflictError).toBe(false)
    expect(new CanopyError(ErrorCode.Conflict, "changed first")).not.toBeInstanceOf(ConflictError)
    expect(new UnauthorizedError("missing token")).toBeInstanceOf(UnauthorizedError)
    expect(new UnauthorizedError("expired token", undefined, true)).toBeInstanceOf(
      UnauthorizedError,
    )
  })

  it("preserves native inheritance for subclasses without a registered type", () => {
    class CustomConflict extends ConflictError {}
    const error = new CustomConflict("changed first")
    expect(error).toBeInstanceOf(CustomConflict)
    expect(error).toBeInstanceOf(ConflictError)
    expect(new ConflictError("changed first")).not.toBeInstanceOf(CustomConflict)
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
