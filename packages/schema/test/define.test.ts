import { Binary, Decimal128, Long, ObjectId } from "@canopy/protocol"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  collection,
  type DocOf,
  defineSchema,
  type NewDocOf,
  type PatchOf,
  t,
  toCollectionSchemas,
} from "../src/define/index.ts"

const todos = collection("todos", {
  title: t.string(),
  done: t.bool().default(false),
  tags: t.array(t.string()).optional(),
  due: t.date().nullable(),
  ownerId: t.string(),
})

const notes = collection("notes", {
  _id: t.string(),
  title: t.string(),
  body: t.object({ text: t.string(), format: t.enum(["md", "plain"]) }),
})

const events = collection("events", { _id: t.uuid(), at: t.date() })
const counters = collection("counters", { _id: t.int(), n: t.long() })
let next = 0
const tickets = collection("tickets", {
  _id: t.int().generate(() => ++next),
  status: t.enum(["open", "closed"]).default("open"),
  meta: t.object({ views: t.int().default(0), labels: t.array(t.string()).default([]) }).optional(),
})

describe("collection types", () => {
  it("derives the stored document", () => {
    expectTypeOf<DocOf<typeof todos.fields>>().toEqualTypeOf<{
      _id: ObjectId
      title: string
      done: boolean
      due: Date | null
      ownerId: string
      tags?: string[]
    }>()
    expectTypeOf<DocOf<typeof notes.fields>>().toEqualTypeOf<{
      _id: string
      title: string
      body: { text: string; format: "md" | "plain" }
    }>()
    expectTypeOf<DocOf<typeof counters.fields>["n"]>().toEqualTypeOf<number | Long>()
  })

  it("makes generated ids and defaulted fields optional on insert, and caller ids required", () => {
    expectTypeOf<NewDocOf<typeof todos.fields>>().toEqualTypeOf<{
      _id?: ObjectId
      title: string
      due: Date | null
      ownerId: string
      done?: boolean
      tags?: string[]
    }>()
    expectTypeOf<NewDocOf<typeof notes.fields>["_id"]>().toEqualTypeOf<string>()
    expectTypeOf<NewDocOf<typeof events.fields>>().toEqualTypeOf<{ _id?: Binary; at: Date }>()
    expectTypeOf<NewDocOf<typeof counters.fields>>().toEqualTypeOf<{
      _id: number
      n: number | Long
    }>()
    expectTypeOf<NewDocOf<typeof tickets.fields>>().toEqualTypeOf<{
      _id?: number
      status?: "open" | "closed"
      meta?: { views: number; labels: string[] }
    }>()
    // @ts-expect-error notes needs a caller supplied _id
    const missing: NewDocOf<typeof notes.fields> = {
      title: "x",
      body: { text: "", format: "md" },
    }
    void missing
  })

  it("lets a merge patch null out only fields that may be absent", () => {
    expectTypeOf<PatchOf<typeof todos.fields>>().toEqualTypeOf<{
      title?: string
      done?: boolean
      tags?: string[] | null
      due?: Date | null
      ownerId?: string
    }>()
  })

  it("keys a schema by collection name", () => {
    const schema = defineSchema(todos, notes)
    expectTypeOf(schema.notes.name).toEqualTypeOf<"notes">()
    expect(Object.keys(schema)).toEqual(["todos", "notes"])
    expect(Object.isFrozen(schema)).toBe(true)
  })
})

describe("prepare", () => {
  it("generates an ObjectId and fills defaults before the insert is applied", () => {
    const doc = todos.prepare({ title: "a", ownerId: "u1", due: null })
    expect(doc["_id"]).toBeInstanceOf(ObjectId)
    expect(doc).toMatchObject({ title: "a", done: false, due: null })
    expect("tags" in doc).toBe(false)
  })

  it("keeps an explicit id and explicit values, including falsy ones", () => {
    const id = new ObjectId()
    expect(todos.prepare({ _id: id, title: "", ownerId: "u", due: null, done: true })).toEqual({
      _id: id,
      title: "",
      ownerId: "u",
      due: null,
      done: true,
    })
    expect(counters.prepare({ _id: 0, n: 0 })).toEqual({ _id: 0, n: 0 })
    expect(todos.prepare({ title: "a", ownerId: "u", due: null, done: false })["done"]).toBe(false)
  })

  it("generates a UUIDv7 for uuid ids", () => {
    const id = events.prepare({ at: new Date(0) })["_id"]
    expect(id).toBeInstanceOf(Binary)
    expect((id as Binary).subType).toBe(4)
    expect((id as Binary).bytes.length).toBe(16)
    expect(((id as Binary).bytes[6] ?? 0) >> 4).toBe(7)
  })

  it("throws for a missing caller id, before anything is sent", () => {
    expect(() => notes.prepare({ title: "x", body: { text: "", format: "md" } })).toThrow(
      /need an _id/,
    )
    expect(() => counters.prepare({ n: 1 })).toThrow(TypeError)
  })

  it("calls generate for each insert and fills nested defaults with fresh copies", () => {
    next = 0
    const a = tickets.prepare({ meta: {} })
    const b = tickets.prepare({ meta: { views: 3 } })
    expect(a).toEqual({ _id: 1, status: "open", meta: { views: 0, labels: [] } })
    expect(b).toEqual({ _id: 2, status: "open", meta: { views: 3, labels: [] } })
    expect((a["meta"] as { labels: unknown[] }).labels).not.toBe(
      (b["meta"] as { labels: unknown[] }).labels,
    )
    expect(tickets.prepare({})).toEqual({ _id: 3, status: "open" })
  })

  it("does not change the caller's object", () => {
    const input = { title: "a", ownerId: "u", due: null }
    todos.prepare(input)
    expect(input).toEqual({ title: "a", ownerId: "u", due: null })
  })
})

describe("definitions", () => {
  it("converts to the shape sampling and validators use", () => {
    const [notesSchema, todosSchema] = toCollectionSchemas(defineSchema(todos, notes))
    expect(notesSchema?.name).toBe("notes")
    expect(todosSchema?.shape.fields).toEqual({
      _id: { shape: { kind: "scalar", type: "objectId" }, required: true },
      done: { shape: { kind: "scalar", type: "bool" }, required: true },
      due: {
        shape: {
          kind: "union",
          of: [
            { kind: "scalar", type: "date" },
            { kind: "scalar", type: "null" },
          ],
        },
        required: true,
      },
      ownerId: { shape: { kind: "scalar", type: "string" }, required: true },
      tags: {
        shape: { kind: "array", items: { kind: "scalar", type: "string" } },
        required: false,
      },
      title: { shape: { kind: "scalar", type: "string" }, required: true },
    })
    expect(notesSchema?.shape.fields["body"]?.shape).toEqual({
      kind: "object",
      open: true,
      fields: {
        format: {
          shape: { kind: "scalar", type: "string", values: ["md", "plain"] },
          required: true,
        },
        text: { shape: { kind: "scalar", type: "string" }, required: true },
      },
    })
  })

  it("rejects invalid names, optional ids and duplicates", () => {
    expect(() => collection("", { a: t.string() })).toThrow(TypeError)
    expect(() => collection("a$b", { a: t.string() })).toThrow(TypeError)
    expect(() => collection("system.views", { a: t.string() })).toThrow(TypeError)
    expect(() => collection("x", { "a.b": t.string() })).toThrow(TypeError)
    expect(() => collection("x", { $a: t.string() })).toThrow(TypeError)
    expect(() => collection("x", { _id: t.string().optional() })).toThrow(/cannot be optional/)
    expect(() => defineSchema(todos, todos)).toThrow(/twice/)
    expect(() => t.enum([] as unknown as ["a"])).toThrow(TypeError)
  })

  it("records whether the client generates the id", () => {
    expect(todos.id.generated).toBe(true)
    expect(events.id.generated).toBe(true)
    expect(tickets.id.generated).toBe(true)
    expect(notes.id.generated).toBe(false)
    expect(counters.id.generated).toBe(false)
  })
})

describe("Standard Schema", () => {
  it("accepts a valid decoded document", async () => {
    const doc = { _id: new ObjectId(), title: "a", done: false, due: null, ownerId: "u" }
    const result = await todos["~standard"].validate(doc)
    expect(result).toEqual({ value: doc })
    expect(todos["~standard"]).toMatchObject({ version: 1, vendor: "canopy" })
  })

  it("reports each problem with its path", async () => {
    const result = await notes["~standard"].validate({
      _id: 3,
      title: "a",
      body: { text: 1, format: "rtf" },
    })
    expect(result.issues).toEqual([
      { message: "Expected string, got a number", path: ["_id"] },
      { message: 'Expected one of "md", "plain", got a string', path: ["body", "format"] },
      { message: "Expected string, got a number", path: ["body", "text"] },
    ])
  })

  it("checks BSON types, integer ranges, nulls and missing required fields", async () => {
    const values = collection("values", {
      i: t.int(),
      l: t.long(),
      d: t.decimal(),
      u: t.uuid().optional(),
      b: t.binary().optional(),
      list: t.array(t.int()).optional(),
      either: t.union(t.string(), t.int()).optional(),
    })
    const ok = {
      _id: new ObjectId(),
      i: 2 ** 31 - 1,
      l: new Long(9007199254740993n),
      d: new Decimal128("1.5"),
      either: 3,
    }
    expect((await values["~standard"].validate(ok)).issues).toBeUndefined()
    const bad = await values["~standard"].validate({
      _id: "x",
      i: 2 ** 31,
      l: 1.5,
      d: 1,
      u: new Binary(new Uint8Array(16), 0),
      b: "x",
      list: [1, "two"],
      either: true,
    })
    expect(bad.issues?.map((issue) => issue.path)).toEqual([
      ["_id"],
      ["b"],
      ["d"],
      ["either"],
      ["i"],
      ["l"],
      ["list", 1],
      ["u"],
    ])
    const missing = await values["~standard"].validate({ _id: new ObjectId() })
    expect(missing.issues?.map((issue) => [issue.message, issue.path])).toEqual([
      ["Required", ["d"]],
      ["Required", ["i"]],
      ["Required", ["l"]],
    ])
    expect((await values["~standard"].validate(null)).issues?.[0]?.message).toBe(
      "Expected an object, got null",
    )
  })
})
