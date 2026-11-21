import { describe, expect, it } from "vitest"
import {
  findDashes,
  findDashesInMarkdown,
  findDashesInRust,
  findDashesInScript,
  findDashesInText,
} from "./dashes.ts"

const EM = "\u2014"
const EN = "\u2013"
const SPACED = " \x2d "

describe("findDashesInText", () => {
  it("reports em and en dashes with 1 based positions", () => {
    expect(findDashesInText(`one${EM}two\nthree ${EN} four`)).toEqual([
      { line: 1, column: 4, kind: "em dash" },
      { line: 2, column: 7, kind: "en dash" },
    ])
  })

  it("reports a hyphen with a space on each side between words", () => {
    expect(findDashesInText(`fast${SPACED}and safe`)).toEqual([
      { line: 1, column: 6, kind: "spaced hyphen" },
    ])
  })

  it("accepts hyphenated words, flags, list markers and ranges", () => {
    const text = [
      "a well-known self-hostable tool",
      "run bun install --frozen-lockfile -v",
      "- a list item",
      "  - a nested item",
      "pages 3-5 and x -1",
      "| --- | --- |",
    ].join("\n")
    expect(findDashesInText(text)).toEqual([])
  })

  it("accepts a hyphen with a space on only one side", () => {
    expect(findDashesInText("word -word and word- word")).toEqual([])
  })

  it("reports every occurrence on the same line", () => {
    expect(findDashesInText(`a${SPACED}b${SPACED}c`).map((f) => f.column)).toEqual([3, 7])
  })

  it("handles CRLF text by counting lines on the line feed", () => {
    expect(findDashesInText(`first\r\nsecond${EM}`)).toEqual([
      { line: 2, column: 7, kind: "em dash" },
    ])
  })
})

describe("findDashesInMarkdown", () => {
  it("reports spaced hyphens in prose", () => {
    expect(findDashesInMarkdown(`# Title\n\nCanopy${SPACED}realtime`)).toEqual([
      { line: 3, column: 8, kind: "spaced hyphen" },
    ])
  })

  it("ignores spaced hyphens inside fenced code blocks", () => {
    const text = ["Before.", "```bash", `echo $((a${SPACED}b))`, "```", "After."].join("\n")
    expect(findDashesInMarkdown(text)).toEqual([])
  })

  it("resumes scanning prose after a fence closes", () => {
    const text = ["~~~", `x${SPACED}y`, "~~~", `a${SPACED}b`].join("\n")
    expect(findDashesInMarkdown(text)).toEqual([{ line: 4, column: 3, kind: "spaced hyphen" }])
  })

  it("does not close a backtick fence with a tilde fence", () => {
    const text = ["```", "~~~", `x${SPACED}y`, "```"].join("\n")
    expect(findDashesInMarkdown(text)).toEqual([])
  })

  it("treats an unclosed fence as code until the end of the file", () => {
    expect(findDashesInMarkdown(["```", `x${SPACED}y`].join("\n"))).toEqual([])
  })

  it("ignores spaced hyphens inside inline code spans, including double backticks", () => {
    expect(findDashesInMarkdown(`use \`a${SPACED}b\` or \`\`c${SPACED}\`d\`\` here`)).toEqual([])
  })

  it("still reports prose after an inline code span on the same line", () => {
    expect(findDashesInMarkdown(`\`code\` then x${SPACED}y`)).toEqual([
      { line: 1, column: 15, kind: "spaced hyphen" },
    ])
  })

  it("reports em dashes even inside code", () => {
    expect(findDashesInMarkdown(["```", `a${EM}b`, "```"].join("\n"))).toEqual([
      { line: 2, column: 2, kind: "em dash" },
    ])
  })
})

describe("findDashesInScript", () => {
  it("ignores the subtraction operator", () => {
    expect(findDashesInScript(`const total = price${SPACED}discount\n`)).toEqual([])
  })

  it("reports spaced hyphens in line and block comments", () => {
    const text = `// fast${SPACED}safe\n/** slow${SPACED}correct */\nconst x = 1\n`
    expect(findDashesInScript(text)).toEqual([
      { line: 1, column: 9, kind: "spaced hyphen" },
      { line: 2, column: 10, kind: "spaced hyphen" },
    ])
  })

  it("reports spaced hyphens in string literals", () => {
    expect(findDashesInScript(`throw new Error('denied${SPACED}no policy')\n`)).toEqual([
      { line: 1, column: 25, kind: "spaced hyphen" },
    ])
  })

  it("reports spaced hyphens in every part of a template literal but not in substitutions", () => {
    const text = `const s = \`a${SPACED}b \${x${SPACED}y} c${SPACED}d \${{ k: 1 }.k} e${SPACED}f\`\n`
    expect(findDashesInScript(text).map((f) => f.column)).toEqual([14, 29, 49])
  })

  it("handles nested template literals", () => {
    const text = `const s = \`outer \${\`inner${SPACED}text\`} end\`\n`
    expect(findDashesInScript(text)).toEqual([{ line: 1, column: 27, kind: "spaced hyphen" }])
  })

  it("does not mistake a regular expression containing a quote for a string", () => {
    const text = `const r = /it's/\nconst n = a${SPACED}b\n`
    expect(findDashesInScript(text)).toEqual([])
  })

  it("treats a slash after a value as division", () => {
    const text = `const half = total / 2 // a${SPACED}b\n`
    expect(findDashesInScript(text)).toEqual([{ line: 1, column: 29, kind: "spaced hyphen" }])
  })

  it("reports em dashes in code", () => {
    expect(findDashesInScript(`const label = 1 ${EM} 2\n`)).toEqual([
      { line: 1, column: 17, kind: "em dash" },
    ])
  })

  it("ignores escaped dashes in literals because only raw source text counts", () => {
    expect(findDashesInScript(`const s = 'a \\u2014 b \\x2d c'\n`)).toEqual([])
  })
})

describe("findDashesInRust", () => {
  it("ignores the subtraction operator", () => {
    expect(findDashesInRust(`let n = a${SPACED}b;\nlet m = x${SPACED}1;`)).toEqual([])
  })

  it("reports spaced hyphens in line, block and doc comments", () => {
    expect(
      findDashesInRust(
        `/// fast${SPACED}safe\nlet a = 1; // one${SPACED}two\n/* x /* y${SPACED}z */ */`,
      ),
    ).toEqual([
      { line: 1, column: 10, kind: "spaced hyphen" },
      { line: 2, column: 19, kind: "spaced hyphen" },
      { line: 3, column: 11, kind: "spaced hyphen" },
    ])
  })

  it("reports spaced hyphens in strings, byte strings and raw strings", () => {
    expect(
      findDashesInRust(`f("a${SPACED}b"); g(b"c${SPACED}d"); h(r#"e${SPACED}"f"#);`),
    ).toHaveLength(3)
  })

  it("does not mistake a quote in a character literal or a lifetime for a string", () => {
    expect(findDashesInRust(`let q = '"'; let n = a${SPACED}b; fn f<'a>(x: &'a str) {}`)).toEqual(
      [],
    )
    expect(findDashesInRust(`let e = '\\''; let n = a${SPACED}b; // x${SPACED}y`)).toHaveLength(1)
  })

  it("does not take an identifier ending in r for a raw string", () => {
    expect(findDashesInRust(`let n = ar${SPACED}b; let s = "x";`)).toEqual([])
  })

  it("reports em dashes in code", () => {
    expect(findDashesInRust(`let ${EM} = 1;`)).toHaveLength(1)
  })
})

describe("findDashes", () => {
  it("uses the Rust scanner for Rust files", () => {
    expect(findDashes("src/lib.rs", `let n = a${SPACED}b;`)).toEqual([])
    expect(findDashes("src/lib.rs", `// a${SPACED}b`)).toHaveLength(1)
  })

  it("uses the script scanner for TypeScript and JavaScript files", () => {
    const text = `const n = a${SPACED}b\n`
    for (const path of ["a.ts", "b.mts", "c.tsx", "d.js", "e.cjs", "dir/f.MJS"]) {
      expect(findDashes(path, text)).toEqual([])
    }
  })

  it("uses the Markdown scanner for Markdown files", () => {
    expect(findDashes("README.md", `\`a${SPACED}b\``)).toEqual([])
  })

  it("scans other files as plain text", () => {
    expect(findDashes("ci.yml", `name: build${SPACED}test`)).toHaveLength(1)
    expect(findDashes("Dockerfile", `RUN echo a${SPACED}b`)).toHaveLength(1)
    expect(findDashes(".ts", `x${SPACED}y`)).toHaveLength(1)
  })
})
