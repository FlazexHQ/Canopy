import ts from "typescript"

/** The kinds of punctuation dash the repository forbids. */
export type DashKind = "em dash" | "en dash" | "spaced hyphen"

/** One forbidden dash, located by 1 based line and column. */
export interface DashFinding {
  readonly line: number
  readonly column: number
  readonly kind: DashKind
}

const EM_DASH = "\u2014"
const EN_DASH = "\u2013"
const SPACED_HYPHEN = /(?<=\S) -(?= \S)/g

const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"])

/**
 * Finds forbidden dashes in plain text: every em dash and en dash, and every hyphen used as a dash
 * (a hyphen with a space on each side between two words).
 */
export function findDashesInText(text: string): DashFinding[] {
  return collect(text, [{ start: 0, end: text.length }], true)
}

/**
 * Finds forbidden dashes in Markdown. Fenced code blocks and inline code spans are skipped for spaced
 * hyphens, because shell commands and expressions legitimately contain them. Em and en dashes are
 * reported everywhere.
 */
export function findDashesInMarkdown(text: string): DashFinding[] {
  return collect(text, proseRanges(text), false)
}

/**
 * Finds forbidden dashes in TypeScript or JavaScript source. Spaced hyphens are reported only inside
 * comments and string or template literals, so the subtraction operator is not affected. Em and en
 * dashes are reported everywhere.
 */
export function findDashesInScript(text: string, fileName = "file.ts"): DashFinding[] {
  return collect(text, literalAndCommentRanges(text, fileName), false)
}

/** Picks the scanner that fits the file extension of `path`. */
export function findDashes(path: string, text: string): DashFinding[] {
  const extension = extensionOf(path)
  if (SCRIPT_EXTENSIONS.has(extension)) return findDashesInScript(text, path)
  if (MARKDOWN_EXTENSIONS.has(extension)) return findDashesInMarkdown(text)
  return findDashesInText(text)
}

interface Range {
  readonly start: number
  readonly end: number
}

function collect(text: string, hyphenRanges: readonly Range[], everywhere: boolean): DashFinding[] {
  const offsets: { offset: number; kind: DashKind }[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === EM_DASH) offsets.push({ offset: i, kind: "em dash" })
    else if (ch === EN_DASH) offsets.push({ offset: i, kind: "en dash" })
  }
  const ranges = everywhere ? [{ start: 0, end: text.length }] : hyphenRanges
  for (const range of ranges) {
    const slice = text.slice(range.start, range.end)
    for (const match of slice.matchAll(SPACED_HYPHEN)) {
      offsets.push({ offset: range.start + match.index + 1, kind: "spaced hyphen" })
    }
  }
  offsets.sort((a, b) => a.offset - b.offset)
  const lineStarts = lineStartOffsets(text)
  return offsets.map(({ offset, kind }) => ({ ...position(lineStarts, offset), kind }))
}

function lineStartOffsets(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1)
  }
  return starts
}

function position(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((lineStarts[mid] ?? 0) <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - (lineStarts[low] ?? 0) + 1 }
}

function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot).toLowerCase()
}

function proseRanges(text: string): Range[] {
  const ranges: Range[] = []
  const fence = /^ {0,3}(`{3,}|~{3,})/
  let offset = 0
  let openFence: string | undefined
  let proseStart = 0
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length
    const marker = fence.exec(line)?.[1]
    if (openFence === undefined && marker !== undefined) {
      ranges.push(...withoutCodeSpans(text, proseStart, offset))
      openFence = marker
    } else if (
      openFence !== undefined &&
      marker !== undefined &&
      marker[0] === openFence[0] &&
      marker.length >= openFence.length &&
      line.trim() === marker
    ) {
      openFence = undefined
      proseStart = lineEnd + 1
    }
    offset = lineEnd + 1
  }
  if (openFence === undefined) ranges.push(...withoutCodeSpans(text, proseStart, text.length))
  return ranges
}

function withoutCodeSpans(text: string, start: number, end: number): Range[] {
  const ranges: Range[] = []
  let cursor = start
  let i = start
  while (i < end) {
    if (text[i] !== "`") {
      i++
      continue
    }
    let ticks = 0
    while (i + ticks < end && text[i + ticks] === "`") ticks++
    const delimiter = "`".repeat(ticks)
    let close = text.indexOf(delimiter, i + ticks)
    while (close !== -1 && close < end && text[close + ticks] === "`") {
      close = text.indexOf(delimiter, close + ticks + 1)
    }
    if (close === -1 || close >= end) {
      i += ticks
      continue
    }
    ranges.push({ start: cursor, end: i })
    cursor = close + ticks
    i = cursor
  }
  ranges.push({ start: cursor, end })
  return ranges
}

function literalAndCommentRanges(text: string, fileName: string): Range[] {
  const variant = /\.(?:tsx|jsx)$/i.test(fileName)
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, text)
  const ranges: Range[] = []
  const templateDepths: number[] = []
  let braceDepth = 0
  let previous: ts.SyntaxKind | undefined
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
      regexMayFollow(previous)
    ) {
      token = scanner.reScanSlashToken()
    }
    if (!TRIVIA.has(token)) previous = token
    switch (token) {
      case ts.SyntaxKind.SingleLineCommentTrivia:
      case ts.SyntaxKind.MultiLineCommentTrivia:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateTail:
        ranges.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() })
        break
      case ts.SyntaxKind.TemplateHead:
        ranges.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() })
        templateDepths.push(braceDepth)
        break
      case ts.SyntaxKind.OpenBraceToken:
        braceDepth++
        break
      case ts.SyntaxKind.CloseBraceToken:
        if (templateDepths.at(-1) === braceDepth) {
          const resumed = scanner.reScanTemplateToken(false)
          ranges.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() })
          if (resumed === ts.SyntaxKind.TemplateTail) templateDepths.pop()
        } else {
          braceDepth--
        }
        break
    }
  }
  return ranges
}

const TRIVIA = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
])

const EXPRESSION_ENDS = new Set([
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
])

function regexMayFollow(previous: ts.SyntaxKind | undefined): boolean {
  return previous === undefined || !EXPRESSION_ENDS.has(previous)
}
