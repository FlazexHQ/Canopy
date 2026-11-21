import { Int32 } from "bson"
import { describe, expect, it } from "vitest"
import {
  CanopyError,
  DiagnosticError,
  deploymentDiagnostic,
  diagnoseMongoError,
  diagnosticOf,
  ErrorCode,
  featureCompatibilityDiagnostic,
  formatDiagnostic,
  mongoTarget,
  serverErrorCode,
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

  it("calls a deployment unreachable when no listed server ever answered, even without a network error", () => {
    const selection = (servers: [string, Record<string, unknown>][]) =>
      Object.assign(new Error("Server selection timed out after 1500 ms"), {
        name: "MongoServerSelectionError",
        reason: { servers: new Map(servers) },
      })
    expect(
      diagnoseMongoError(selection([["127.0.0.1:1", { type: "Unknown" }]]), target)?.docs,
    ).toBe("mongodb-unreachable")
    const answeredOnce = selection([
      ["a:27017", { type: "Unknown" }],
      ["b:27017", { type: "RSSecondary" }],
    ])
    expect(diagnoseMongoError(answeredOnce, target)?.docs).toBe("no-primary")
    expect(diagnoseMongoError(selection([["a:27017", { type: "RSGhost" }]]), target)?.docs).toBe(
      "no-primary",
    )
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
    const carried = featureCompatibilityDiagnostic("7.0", { host: "db:27017" })
    expect(carried.cause).toContain("featureCompatibilityVersion 7.0")
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

describe("mongoTarget", () => {
  it("names the hosts and the database, never the credentials", () => {
    expect(
      mongoTarget("mongodb://user:secret@h1:27017,h2:27018/app?replicaSet=rs0", "shop"),
    ).toEqual({
      host: "h1:27017,h2:27018",
      database: "shop",
    })
    expect(mongoTarget("mongodb+srv://cluster0.example.net/")).toEqual({
      host: "cluster0.example.net",
    })
    expect(mongoTarget("not a uri")).toEqual({})
  })
})

describe("serverErrorCode", () => {
  it("reads a numeric code", () => {
    expect(
      serverErrorCode(serverError("operation exceeded time limit", 50, "MaxTimeMSExpired")),
    ).toBe(50)
  })

  it("unwraps a code decoded as an Int32, as commands with exact BSON types return it", () => {
    const error = Object.assign(new Error("operation exceeded time limit"), { code: new Int32(50) })
    expect(serverErrorCode(error)).toBe(50)
  })

  it("returns undefined without a numeric code", () => {
    expect(serverErrorCode(new Error("no code"))).toBeUndefined()
    expect(serverErrorCode(Object.assign(new Error("system"), { code: "ENOENT" }))).toBeUndefined()
    expect(
      serverErrorCode(Object.assign(new Error("odd"), { code: { valueOf: () => "50" } })),
    ).toBeUndefined()
    expect(serverErrorCode(null)).toBeUndefined()
    expect(serverErrorCode("50")).toBeUndefined()
  })

  it("lets diagnostics match a code decoded as an Int32", () => {
    const error = Object.assign(new Error("not supported"), {
      name: "MongoServerError",
      code: new Int32(40573),
      codeName: "Location40573x",
    })
    expect(diagnoseMongoError(error)?.docs).toBe("standalone-mongodb")
  })
})

describe("deploymentDiagnostic", () => {
  const target = { host: "db:27017" }

  it("accepts a replica set or a sharded cluster on MongoDB 8.0 or newer", () => {
    expect(deploymentDiagnostic({ setName: "rs0" }, "8.0.34", target)).toBeUndefined()
    expect(deploymentDiagnostic({ msg: "isdbgrid" }, "9.0.4", target)).toBeUndefined()
  })

  it("refuses a standalone server with the same advice as its driver error", () => {
    const found = deploymentDiagnostic({ isWritablePrimary: true }, "8.0.34", target)
    expect(found).toMatchObject({
      summary: "change streams are not available",
      docs: "standalone-mongodb",
    })
    expect(found?.cause).toContain("db:27017")
  })

  it("refuses MongoDB older than 8.0 and versions it cannot read", () => {
    expect(deploymentDiagnostic({ setName: "rs0" }, "7.0.45", target)).toMatchObject({
      code: ErrorCode.Unavailable,
      summary: "MongoDB is too old",
    })
    expect(deploymentDiagnostic({ setName: "rs0" }, "unknown", target)?.summary).toBe(
      "MongoDB is too old",
    )
  })
})
