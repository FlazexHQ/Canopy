import { describe, expect, it } from "vitest"
import { parseToml } from "./toml.ts"

describe("parseToml", () => {
  it("reads tables, dotted keys, inline tables and arrays over several lines", () => {
    const text = [
      "# a comment",
      "[workspace]",
      'resolver = "3"',
      "members = [",
      '  "crates/*", # the core',
      "  'packages/native',",
      "]",
      "",
      "[workspace.package]",
      "publish = false",
      'description = "a \\"quoted\\" # not a comment"',
      "",
      "[package]",
      "version.workspace = true",
      "",
      "[dependencies]",
      'napi = { version = "3.16.2", default-features = false, features = ["napi4"] }',
      "",
      "[profile.release]",
      "codegen-units = 1",
      "opt-level = 3.5",
      "",
      "[[bin]]",
      'name = "a"',
      "[[bin]]",
      'name = "b"',
    ].join("\r\n")
    expect(parseToml(text)).toEqual({
      workspace: {
        resolver: "3",
        members: ["crates/*", "packages/native"],
        package: { publish: false, description: 'a "quoted" # not a comment' },
      },
      package: { version: { workspace: true } },
      dependencies: {
        napi: { version: "3.16.2", "default-features": false, features: ["napi4"] },
      },
      profile: { release: { "codegen-units": 1, "opt-level": 3.5 } },
      bin: [{ name: "a" }, { name: "b" }],
    })
  })

  it("refuses what it does not read instead of guessing", () => {
    expect(() => parseToml('a = """\nb\n"""')).toThrow(/line 1: multi line strings/)
    expect(() => parseToml("a = 1979-05-27")).toThrow(/line 1: unexpected/)
    expect(() => parseToml("a = [1, 2")).toThrow(/not closed/)
    expect(() => parseToml("a = 1\na = 2")).toThrow(/line 2: a is defined twice/)
    expect(() => parseToml("just words")).toThrow(/line 1: expected key = value/)
    expect(() => parseToml('a = "\\u0041"')).toThrow(/unsupported escape/)
    expect(() => parseToml("a = 1\n[a]")).toThrow(/line 2: a is not a table/)
  })
})
