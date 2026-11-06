import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { compileRegex, isLinearRegex, UnsupportedQueryError } from "../src/index.ts"

describe("compileRegex", () => {
  const cases: [string, string, string, boolean][] = [
    ["abc", "", "xxabcxx", true],
    ["^abc", "", "xabc", false],
    ["abc$", "", "abc\n", true],
    ["abc$", "", "abc\nx", false],
    ["^b", "m", "a\nb", true],
    ["a.c", "", "a\nc", false],
    ["a.c", "s", "a\nc", true],
    ["A", "i", "xa", true],
    ["[a-c]+z", "", "xxbbz", true],
    ["[^a-c]", "", "abc", false],
    ["\\d{3}", "", "ab123", true],
    ["\\d{3}", "", "ab12", false],
    ["^(ab|cd)+$", "", "abcdab", true],
    ["^(ab|cd)+$", "", "abcda", false],
    ["colou?r", "", "color", true],
    ["\\bcat\\b", "", "a cat!", true],
    ["\\bcat\\b", "", "concat", false],
    ["[[:digit:]]", "", "x9", true],
    ["a b # comment", "x", "ab", true],
    ["(?i)hello", "", "HELLO", true],
    ["\\x41", "", "A", true],
    ["^.$", "", "\u{1f600}", true],
    ["\\Aab\\z", "", "ab", true],
    ["\\Aab\\z", "", "ab\n", false],
    ["\\Aab\\Z", "", "ab\n", true],
    ["x{2,3}", "", "xx", true],
    ["^x{2,3}$", "", "xxxx", false],
    ["a{,2}", "", "a{,2}", true],
    ["\\s", "", "\u000b", true],
    ["", "", "", true],
  ]

  it.each(cases)("/%s/%s on %j is %s", (pattern, options, input, expected) => {
    expect(compileRegex(pattern, options).test(input)).toBe(expected)
  })

  it.each([
    ["(a)\\1", "a backreference"],
    ["(?=a)", "lookahead"],
    ["(?!a)", "negative lookahead"],
    ["(?<=a)b", "lookbehind"],
    ["(?>a)", "an atomic group"],
    ["a++", "a possessive quantifier"],
    ["(?R)", "recursion"],
    ["\\p{L}", "a Unicode property"],
    ["a{1001}", "a huge repetition"],
  ])("rejects %s (%s) as not linear", (pattern) => {
    expect(() => compileRegex(pattern)).toThrow(UnsupportedQueryError)
    expect(isLinearRegex(pattern)).toBe(false)
  })

  it.each(["(", "a)", "[a", "*a", "a**", "\\y", "[b-a]"])(
    "rejects the invalid pattern %s",
    (pattern) => {
      expect(() => compileRegex(pattern)).toThrow()
      expect(isLinearRegex(pattern)).toBe(false)
    },
  )

  it("runs patterns that make backtracking engines explode in linear time", () => {
    const input = `${"a".repeat(20_000)}!`
    const started = performance.now()
    expect(compileRegex("^(a+)+$").test(input)).toBe(false)
    expect(compileRegex("(a|aa)*b").test(input)).toBe(false)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it("agrees with the JavaScript engine on patterns both support", () => {
    const atoms = ["a", "b", ".", "[ab]", "[^a]", "\\d", "\\w", "\\s", "(a|b)", "(ab|c)", "x"]
    const quantifiers = ["", "*", "+", "?", "{1,2}", "{2}"]
    const pattern = fc
      .array(fc.tuple(fc.constantFrom(...atoms), fc.constantFrom(...quantifiers)), {
        minLength: 1,
        maxLength: 4,
      })
      .chain((parts) =>
        fc.tuple(fc.boolean(), fc.boolean()).map(([start, end]) => {
          const body = parts.map(([atom, quantifier]) => atom + quantifier).join("")
          return `${start ? "^" : ""}${body}${end ? "$" : ""}`
        }),
      )
    const input = fc.stringMatching(/^[abcx1 \n]{0,8}$/)
    fc.assert(
      fc.property(pattern, input, fc.constantFrom("", "i", "s", "m"), (source, text, flags) => {
        const reference = new RegExp(source, flags).test(text)
        const endsWithNewline = text.endsWith("\n") && source.endsWith("$") && flags !== "m"
        if (endsWithNewline) return
        expect(
          compileRegex(source, flags).test(text),
          `/${source}/${flags} on ${JSON.stringify(text)}`,
        ).toBe(reference)
      }),
      { numRuns: 2000 },
    )
  })
})
