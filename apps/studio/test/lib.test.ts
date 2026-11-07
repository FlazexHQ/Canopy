import { describe, expect, it } from "vitest"
import {
  array,
  boolean,
  date,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
} from "../src/api/schema.ts"
import { permissionsOf } from "../src/app/permissions.ts"
import { formatBytes, formatRelative, t } from "../src/i18n/index.ts"
import {
  columnsOf,
  displayValue,
  getPath,
  parseEjson,
  parseEjsonObject,
  typeOf,
} from "../src/lib/ejson.ts"
import { exportDocuments, importDocuments, parseCsv } from "../src/lib/transfer.ts"

describe("schema", () => {
  const shape = object({
    name: string,
    count: optional(number),
    kind: literal("a", "b"),
    tags: array(string),
    owner: nullable(object({ ok: boolean })),
  })

  it("keeps known members, drops unknown ones and leaves optional ones out when absent", () => {
    expect(shape.parse({ name: "x", kind: "a", tags: ["t"], owner: null, extra: 1 })).toEqual({
      name: "x",
      kind: "a",
      tags: ["t"],
      owner: null,
    })
  })

  it("reports the path of the first mismatch", () => {
    expect(() => shape.parse({ name: "x", kind: "c", tags: [], owner: null })).toThrow(
      /at kind: expected "a" \| "b", got string/,
    )
    expect(() => shape.parse({ name: "x", kind: "a", tags: [1], owner: null })).toThrow(
      /at tags\[0\]/,
    )
    expect(() => number.parse(Number.NaN)).toThrow()
  })

  it("normalizes ISO and EJSON dates", () => {
    expect(date.parse("2026-11-07T10:00:00.000Z")).toBe("2026-11-07T10:00:00.000Z")
    expect(date.parse({ $date: "2026-11-07T10:00:00Z" })).toBe("2026-11-07T10:00:00Z")
    expect(date.parse({ $date: { $numberLong: "0" } })).toBe("1970-01-01T00:00:00.000Z")
    expect(() => date.parse(5)).toThrow()
  })
})

describe("permissions", () => {
  it("lets developers publish and edit data only outside production", () => {
    expect(permissionsOf("developer", "development").publishPolicies).toBe(true)
    expect(permissionsOf("developer", "production").publishPolicies).toBe(false)
    expect(permissionsOf("developer", "production").writeData).toBe(false)
    expect(permissionsOf("developer", "production").draftPolicies).toBe(true)
    expect(permissionsOf("developer", "development").createKeys).toBe("publishable")
  })

  it("keeps owners and the danger zone for owners, and lets admins manage other admins", () => {
    for (const role of ["admin", "developer", "viewer"] as const) {
      expect(permissionsOf(role, "development").dangerZone).toBe(false)
      expect(permissionsOf(role, "development").manageOwners).toBe(false)
    }
    expect(permissionsOf("admin", "development").manageAdmins).toBe(true)
    expect(permissionsOf("developer", "development").manageAdmins).toBe(false)
    expect(permissionsOf("developer", "production").readUsers).toBe(true)
    expect(permissionsOf("developer", "development").manageUsers).toBe(false)
    expect(permissionsOf("viewer", "development").readUsers).toBe(false)
    expect(permissionsOf("owner", "production").dangerZone).toBe(true)
    expect(permissionsOf("admin", "production").publishPolicies).toBe(true)
  })

  it("makes viewers read only", () => {
    const viewer = permissionsOf("viewer", "development")
    expect(viewer.publishPolicies || viewer.writeData || viewer.draftPolicies).toBe(false)
    expect(viewer.createKeys).toBe("none")
    expect(viewer.impersonate).toBe(false)
  })

  it("requires comments and typed confirmation in production", () => {
    expect(permissionsOf("owner", "production").publishNeedsComment).toBe(true)
    expect(permissionsOf("owner", "production").confirmDataEdits).toBe(true)
    expect(permissionsOf("owner", "development").confirmDataEdits).toBe(false)
  })
})

describe("i18n", () => {
  it("fills placeholders and formats numbers", () => {
    expect(t("common.typeToConfirm", { value: "todos" })).toBe("Type todos to confirm")
    expect(t("common.showing", { from: 1, to: 1500 })).toBe("Showing 1 to 1,500")
  })

  it("formats sizes and relative times", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatRelative(Date.now() - 3 * 60_000)).toBe("3 minutes ago")
  })
})

describe("EJSON helpers", () => {
  it("parses extended JSON into canonical form", () => {
    const result = parseEjson(
      '{"_id":{"$oid":"65f1a2b3c4d5e6f7a8b90001"},"n":{"$numberLong":"9007199254740993"}}',
    )
    expect(result).toEqual({
      ok: true,
      value: { _id: { $oid: "65f1a2b3c4d5e6f7a8b90001" }, n: { $numberLong: "9007199254740993" } },
    })
  })

  it("rejects malformed wrappers and reports syntax error positions", () => {
    expect(parseEjson('{"_id":{"$oid":"123"}}').ok).toBe(false)
    const syntax = parseEjson('{\n  "a": 1,\n  "b": }')
    expect(syntax.ok).toBe(false)
    if (!syntax.ok) expect([syntax.line, syntax.column]).toEqual([3, 8])
    const trailing = parseEjson('{"a": [1, 2,]}')
    if (!trailing.ok) expect([trailing.line, trailing.column]).toEqual([1, 13])
    expect(trailing.ok).toBe(false)
    expect(parseEjsonObject("[1]")).toEqual({ ok: false, message: "Expected a JSON object" })
  })

  it("renders typed values for grid cells", () => {
    expect(displayValue({ $oid: "65f1a2b3c4d5e6f7a8b90001" })).toBe(
      'ObjectId("65f1a2b3c4d5e6f7a8b90001")',
    )
    expect(displayValue({ $date: { $numberLong: "0" } })).toBe("1970-01-01T00:00:00.000Z")
    expect(displayValue({ $numberDecimal: "1.50" })).toBe("1.50m")
    expect(displayValue([1, 2, 3])).toBe("[3]")
    expect(displayValue({ a: 1, b: 2 })).toBe("{2}")
    expect(typeOf({ $numberLong: "1" })).toBe("long")
    expect(typeOf(1.5)).toBe("double")
    expect(getPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1)
    expect(getPath({ a: [{ b: 1 }] }, "a.b")).toBeUndefined()
    expect(columnsOf([{ b: 1 }, { _id: 1, a: 2 }])).toEqual(["_id", "b", "a"])
  })
})

describe("import and export", () => {
  const documents = [
    {
      _id: { $oid: "65f1a2b3c4d5e6f7a8b90001" },
      title: 'Say "hi", then go',
      n: { $numberLong: "5" },
      tags: ["a"],
    },
    { _id: { $oid: "65f1a2b3c4d5e6f7a8b90002" }, title: "Line\nbreak", done: true },
  ]

  it("exports EJSON losslessly and JSON relaxed", () => {
    expect(JSON.parse(exportDocuments(documents, "ejson"))).toEqual(documents)
    const relaxed = JSON.parse(exportDocuments(documents, "json")) as Record<string, unknown>[]
    expect(relaxed[0]).toEqual({
      _id: "65f1a2b3c4d5e6f7a8b90001",
      title: 'Say "hi", then go',
      n: 5,
      tags: ["a"],
    })
  })

  it("writes RFC 4180 CSV that reads back", () => {
    const csv = exportDocuments(documents, "csv")
    expect(csv.split("\r\n")[0]).toBe("_id,title,n,tags,done")
    const rows = parseCsv(csv)
    expect(rows[1]).toEqual([
      'ObjectId("65f1a2b3c4d5e6f7a8b90001")',
      'Say "hi", then go',
      "5",
      '["a"]',
      "",
    ])
    expect(rows[2]?.[1]).toBe("Line\nbreak")
  })

  it("imports CSV with inferred types and JSON lines or arrays", () => {
    expect(
      importDocuments('title,n,done,meta\nA,3,true,"{""x"":1}"\nB,,false,null\n', "csv"),
    ).toEqual([
      { title: "A", n: 3, done: true, meta: { x: 1 } },
      { title: "B", done: false, meta: null },
    ])
    expect(importDocuments('{"a":1}\n{"a":2}\n', "ejson")).toEqual([{ a: 1 }, { a: 2 }])
    expect(importDocuments('[{"a":1}]', "json")).toEqual([{ a: 1 }])
    expect(() => importDocuments("[1]", "json")).toThrow("Entry 1 is not a document")
    expect(() => parseCsv('"open')).toThrow(SyntaxError)
  })
})
