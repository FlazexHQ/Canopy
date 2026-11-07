import { describe, expect, it } from "vitest"
import { checkCommitMessage, MAX_HEADER_LENGTH } from "./commit.ts"

const SIGN_OFF = "Signed-off-by: Ada Lovelace <ada@example.com>"

function message(...lines: string[]): string {
  return `${lines.join("\n")}\n`
}

describe("checkCommitMessage", () => {
  it("accepts a signed off Conventional Commit with a scope and a body", () => {
    expect(
      checkCommitMessage(
        message("feat(matcher): support $elemMatch", "", "Adds the operator.", "", SIGN_OFF),
      ),
    ).toEqual([])
  })

  it("accepts a breaking change marker and scopes with separators", () => {
    expect(checkCommitMessage(message("fix(realtime/ws)!: drop v0 frames", "", SIGN_OFF))).toEqual(
      [],
    )
    expect(
      checkCommitMessage(message("refactor(rest-api.v1)!: rename routes", "", SIGN_OFF)),
    ).toEqual([])
  })

  it("accepts a header without a scope", () => {
    expect(checkCommitMessage(message("chore: set up the monorepo", "", SIGN_OFF))).toEqual([])
  })

  it("rejects a message without a DCO sign off", () => {
    expect(checkCommitMessage(message("feat: add codec"))).toEqual([
      'missing DCO sign off: add "Signed-off-by: Name <email>" (use git commit -s)',
    ])
  })

  it("rejects a sign off without an email address", () => {
    expect(
      checkCommitMessage(message("feat: add codec", "", "Signed-off-by: Ada Lovelace")),
    ).toEqual(['missing DCO sign off: add "Signed-off-by: Name <email>" (use git commit -s)'])
  })

  it("rejects an unknown type", () => {
    expect(checkCommitMessage(message("feature: add codec", "", SIGN_OFF))).toEqual([
      'unknown commit type "feature"; use one of build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test',
    ])
  })

  it("rejects a header that is not Conventional Commits", () => {
    for (const header of [
      "Add codec",
      "feat add codec",
      "feat:add codec",
      "Feat: add codec",
      "feat(): add",
    ]) {
      expect(checkCommitMessage(message(header, "", SIGN_OFF))).toContain(
        'the header must look like "type(scope): subject" (Conventional Commits)',
      )
    }
  })

  it("rejects an upper case scope", () => {
    expect(checkCommitMessage(message("fix(Matcher): sort order", "", SIGN_OFF))).toEqual([
      'the scope "Matcher" must be lower case words joined by "-", "." or "/"',
    ])
  })

  it("rejects a subject that ends with a period or has extra whitespace", () => {
    expect(checkCommitMessage(message("fix: sort order.", "", SIGN_OFF))).toEqual([
      "the subject must not end with a period",
    ])
    expect(checkCommitMessage(message("fix:  sort order", "", SIGN_OFF))).toEqual([
      "the subject must not start or end with whitespace",
    ])
  })

  it("enforces the header length limit at exactly the boundary", () => {
    const prefix = "fix: "
    const atLimit = prefix + "a".repeat(MAX_HEADER_LENGTH - prefix.length)
    expect(checkCommitMessage(message(atLimit, "", SIGN_OFF))).toEqual([])
    expect(checkCommitMessage(message(`${atLimit}b`, "", SIGN_OFF))).toEqual([
      `the header is ${MAX_HEADER_LENGTH + 1} characters long; the limit is ${MAX_HEADER_LENGTH}`,
    ])
  })

  it("requires a blank line between the header and the body", () => {
    expect(checkCommitMessage(message("fix: sort order", "Body text.", "", SIGN_OFF))).toEqual([
      "the header must be followed by a blank line",
    ])
  })

  it("rejects punctuation dashes anywhere in the message", () => {
    expect(
      checkCommitMessage(message("fix: sort order", "", "Fast \x2d and correct.", "", SIGN_OFF)),
    ).toEqual(["line 3, column 6: spaced hyphen used as punctuation"])
    expect(checkCommitMessage(message("fix: sort\u2014order", "", SIGN_OFF))).toEqual([
      "line 1, column 10: em dash used as punctuation",
    ])
  })

  it("ignores Git comment lines and everything below the scissors line", () => {
    const raw = [
      "# Please enter the commit message",
      "fix: sort order",
      "",
      SIGN_OFF,
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
      "Not a header \x2d at all",
    ].join("\n")
    expect(checkCommitMessage(raw)).toEqual([])
  })

  it("accepts CRLF line endings", () => {
    expect(checkCommitMessage(`fix: sort order\r\n\r\n${SIGN_OFF}\r\n`)).toEqual([])
  })

  it("exempts Git merge commits from header rules but still requires a sign off", () => {
    expect(checkCommitMessage(message("Merge branch 'main' into feat/x", "", SIGN_OFF))).toEqual([])
    expect(checkCommitMessage(message("Merge branch 'main' into feat/x"))).toHaveLength(1)
  })

  it("rejects an empty message, including one with only comments", () => {
    expect(checkCommitMessage("")).toEqual(["the commit message is empty"])
    expect(checkCommitMessage("# only a comment\n\n")).toEqual(["the commit message is empty"])
  })
})
