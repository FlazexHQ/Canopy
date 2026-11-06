import { ObjectId } from "@canopy/protocol"
import { describe, expect, it } from "vitest"
import { immutableViolations, leafPaths } from "../src/index.ts"

describe("leafPaths", () => {
  it("walks subdocuments to their leaves", () => {
    expect(leafPaths({ a: 1, profile: { name: "x", address: { city: "y" } } }).sort()).toEqual([
      "a",
      "profile.address.city",
      "profile.name",
    ])
  })

  it("treats BSON values, dates and arrays of scalars as leaves", () => {
    expect(
      leafPaths({ id: new ObjectId(), at: new Date(0), tags: ["a", "b"], re: /x/ }).sort(),
    ).toEqual(["at", "id", "re", "tags"])
  })

  it("walks documents inside arrays and keeps the array path when it also holds scalars", () => {
    expect(leafPaths({ items: [{ sku: "a" }, { qty: 2 }] }).sort()).toEqual([
      "items.qty",
      "items.sku",
    ])
    expect(leafPaths({ items: [{ sku: "a" }, 3] }).sort()).toEqual(["items", "items.sku"])
  })

  it("counts empty documents and arrays as writes of their own path", () => {
    expect(leafPaths({ profile: {}, tags: [] }).sort()).toEqual(["profile", "tags"])
  })

  it("skips undefined values", () => {
    expect(leafPaths({ a: undefined, b: { c: undefined, d: 1 } })).toEqual(["b.d"])
  })
})

describe("immutableViolations", () => {
  it("flags the path itself, paths beneath it and its ancestors", () => {
    expect(
      immutableViolations(
        ["ownerId", "meta.createdAt.ms", "meta", "title", "ownerIdx"],
        ["ownerId", "meta.createdAt"],
      ),
    ).toEqual(["ownerId", "meta.createdAt.ms", "meta"])
  })

  it("flags array index paths beneath an immutable array", () => {
    expect(immutableViolations(["tags.0", "tagsCount"], ["tags"])).toEqual(["tags.0"])
  })
})
