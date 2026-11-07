import { describe, expect, it } from "vitest"
import {
  CanopyError,
  DiagnosticError,
  diagnoseMongoError,
  diagnosticOf,
  ErrorCode,
  featureCompatibilityDiagnostic,
  formatDiagnostic,
} from "../src/index.ts"

/** Builds an error shaped like the driver's, with the messages MongoDB 7 and 8 send. */
function serverError(message: string, code: number, codeName: string): Error {
  return Object.assign(new Error(message), { name: "MongoServerError", code, codeName })
}

describe("formatDiagnostic", () => {
  it("prints the code, summary, cause, fix and docs link in that order", () => {
    const text = formatDiagnostic(
      {
        code: ErrorCode.Unavailable,
        summary: "change streams are not available",
        cause: "MongoDB at localhost:27017 is a standalone server.",
        fix: "convert it to a replica set\nand add replicaSet=rs0.",
        docs: "standalone-mongodb",
      },
      { docsBase: "https://example.test/errors/" },
    )
    expect(text).toBe(
      [
        "error CANOPY_UNAVAILABLE: change streams are not available",
        "  MongoDB at localhost:27017 is a standalone server.",
        "  Fix: convert it to a replica set",
        "       and add replicaSet=rs0.",
        "  Docs: https://example.test/errors/standalone-mongodb",
      ].join("\n"),
    )
  })

  it("omits missing parts and prints warnings and docs slugs", () => {
    expect(
      formatDiagnostic(
        { code: ErrorCode.ConfigInvalid, summary: "unused setting", docs: "config" },
        { severity: "warning" },
      ),
    ).toBe("warning CANOPY_CONFIG_INVALID: unused setting\n  Docs: errors/config")
  })
})

describe("diagnoseMongoError", () => {
  const target = { host: "db:27017", database: "app" }

  it("recognizes a standalone server from a change stream or a transaction", () => {
    for (const error of [
      serverError(
        "The $changeStream stage is only supported on replica sets",
        40573,
        "Location40573",
      ),
      serverError(
        "Transaction numbers are only allowed on a replica set member or mongos",
        20,
        "IllegalOperation",
      ),
    ]) {
      const diagnostic = diagnoseMongoError(error, target)
      expect(diagnostic?.docs).toBe("standalone-mongodb")
      expect(diagnostic?.cause).toContain("MongoDB at db:27017 is a standalone server")
    }
  })

  it("recognizes failed authentication", () => {
    expect(
      diagnoseMongoError(serverError("Authentication failed.", 18, "AuthenticationFailed"))?.docs,
    ).toBe("authentication-failed")
  })

  it("names the missing action and database of a privilege error", () => {
    const watch = diagnoseMongoError(
      serverError(
        'not authorized on app to execute command { aggregate: 1, pipeline: [ { $changeStream: {} } ], cursor: {}, lsid: { id: UUID("...") }, $db: "app" }',
        13,
        "Unauthorized",
      ),
      target,
    )
    expect(watch?.docs).toBe("missing-privilege")
    expect(watch?.summary).toBe("the MongoDB user may not run changeStream on app")
    expect(watch?.fix).toContain("grant the changeStream action on the database app")
    const find = diagnoseMongoError(
      serverError(
        'not authorized on shop to execute command { find: "orders", filter: {}, $db: "shop" }',
        13,
        "Unauthorized",
      ),
    )
    expect(find?.summary).toBe("the MongoDB user may not run find on shop")
    const remove = diagnoseMongoError(
      serverError(
        'not authorized on shop to execute command { delete: "orders", $db: "shop" }',
        13,
        "Unauthorized",
      ),
    )
    expect(remove?.summary).toBe("the MongoDB user may not run remove on shop")
  })

  it("looks through causes and server selection reasons", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      name: "MongoNetworkError",
    })
    const selection = Object.assign(new Error("Server selection timed out after 100 ms"), {
      name: "MongoServerSelectionError",
      reason: { servers: new Map([["127.0.0.1:1", { error: refused }]]) },
    })
    expect(diagnoseMongoError(selection, target)?.docs).toBe("mongodb-unreachable")
    const wrapped = new CanopyError(ErrorCode.Unavailable, "MongoDB is unavailable", {
      cause: refused,
    })
    expect(diagnoseMongoError(wrapped)?.docs).toBe("mongodb-unreachable")
    const nameOnly = Object.assign(new Error("Server selection timed out after 100 ms"), {
      name: "MongoServerSelectionError",
      reason: { servers: new Map() },
    })
    expect(diagnoseMongoError(nameOnly)?.docs).toBe("no-primary")
  })

  it("recognizes TLS mismatches", () => {
    const tls = Object.assign(
      new Error("Client network socket disconnected before secure TLS connection was established"),
      { name: "MongoNetworkError" },
    )
    expect(diagnoseMongoError(tls)?.docs).toBe("tls-mismatch")
  })

  it("leaves unknown failures alone", () => {
    expect(diagnoseMongoError(serverError("E11000 duplicate key", 11000, "DuplicateKey"))).toBe(
      undefined,
    )
    expect(diagnoseMongoError("a string")).toBe(undefined)
    expect(diagnoseMongoError(null)).toBe(undefined)
  })
})

describe("diagnosticOf", () => {
  it("prefers a carried diagnostic, then the driver table, then the error itself", () => {
    const carried = featureCompatibilityDiagnostic("6.0", { host: "db:27017" })
    expect(carried.cause).toContain("featureCompatibilityVersion 6.0")
    const error = new DiagnosticError(carried)
    expect(error.code).toBe(ErrorCode.Unavailable)
    expect(error.details).toBe(undefined)
    expect(diagnosticOf(error)).toBe(carried)
    expect(
      diagnosticOf(serverError("Authentication failed.", 18, "AuthenticationFailed")).docs,
    ).toBe("authentication-failed")
    expect(diagnosticOf(new CanopyError(ErrorCode.Forbidden, "nope"))).toEqual({
      code: ErrorCode.Forbidden,
      summary: "nope",
    })
    expect(diagnosticOf(new TypeError("boom"))).toEqual({
      code: ErrorCode.Internal,
      summary: "boom",
    })
  })
})
