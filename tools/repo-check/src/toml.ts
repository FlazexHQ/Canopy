/** A TOML value as {@link parseToml} reads it. Dates are not supported. */
export type TomlValue = string | number | boolean | readonly TomlValue[] | TomlTable

/** A TOML table. */
export interface TomlTable {
  readonly [key: string]: TomlValue
}

type MutableTable = Record<string, TomlValue>

/**
 * Parses the TOML that Cargo manifests and `rust-toolchain.toml` use: tables, arrays of tables, dotted keys,
 * basic and literal strings, integers, floats, booleans, arrays (over several lines too) and inline tables.
 * Multi line strings and dates are refused.
 *
 * @throws Error naming the line when the text is not in that subset.
 */
export function parseToml(text: string): TomlTable {
  const root: MutableTable = {}
  let current = root
  const statements = joinStatements(text)
  for (const { line, source } of statements) {
    const fail = (message: string): never => {
      throw new Error(`line ${line}: ${message}`)
    }
    if (source.startsWith("[[")) {
      if (!source.endsWith("]]")) fail("an array of tables header must end with ]]")
      const path = parseKey(source.slice(2, -2), fail)
      const parent = descend(root, path.slice(0, -1), fail)
      const last = path.at(-1) ?? fail("empty header")
      const existing = parent[last]
      const list: TomlValue[] = Array.isArray(existing) ? [...existing] : []
      if (existing !== undefined && !Array.isArray(existing))
        fail(`${last} is not an array of tables`)
      const table: MutableTable = {}
      list.push(table)
      parent[last] = list
      current = table
    } else if (source.startsWith("[")) {
      if (!source.endsWith("]")) fail("a table header must end with ]")
      current = descend(root, parseKey(source.slice(1, -1), fail), fail)
    } else {
      const equals = keyEnd(source)
      if (equals === -1) fail("expected key = value")
      const path = parseKey(source.slice(0, equals), fail)
      const reader = new ValueReader(source.slice(equals + 1), fail)
      const value = reader.value()
      reader.end()
      const table = descend(current, path.slice(0, -1), fail)
      const last = path.at(-1) ?? fail("empty key")
      if (last in table) fail(`${path.join(".")} is defined twice`)
      table[last] = value
    }
  }
  return root
}

/** Splits the text into statements, joining arrays and inline tables that span lines and dropping comments. */
function joinStatements(text: string): { line: number; source: string }[] {
  const statements: { line: number; source: string }[] = []
  let pending = ""
  let start = 0
  let depth = 0
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = stripComment(raw, index + 1)
    if (pending === "" && line.trimStart().startsWith("[")) {
      statements.push({ line: index + 1, source: line.trim() })
      continue
    }
    if (pending === "") start = index + 1
    pending = pending === "" ? line.trim() : `${pending} ${line.trim()}`
    depth += bracketDelta(line)
    if (depth === 0 && pending !== "") {
      statements.push({ line: start, source: pending })
      pending = ""
    }
  }
  if (pending !== "") throw new Error(`line ${start}: an array or inline table is not closed`)
  return statements
}

function stripComment(line: string, number: number): string {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') i++
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      if (line.startsWith(char.repeat(3), i)) {
        throw new Error(`line ${number}: multi line strings are not supported`)
      }
      quote = char
    } else if (char === "#") return line.slice(0, i)
  }
  return line
}

function bracketDelta(line: string): number {
  let quote: string | undefined
  let delta = 0
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') i++
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === "[" || char === "{") delta++
    else if (char === "]" || char === "}") delta--
  }
  return delta
}

function keyEnd(source: string): number {
  let quote: string | undefined
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === "=") return i
  }
  return -1
}

function parseKey(source: string, fail: (message: string) => never): string[] {
  const parts: string[] = []
  const reader = new ValueReader(source, fail)
  for (;;) {
    parts.push(reader.keyPart())
    if (!reader.consume(".")) break
  }
  reader.end()
  return parts
}

function descend(
  table: MutableTable,
  path: readonly string[],
  fail: (message: string) => never,
): MutableTable {
  let current = table
  for (const part of path) {
    const next = current[part] ?? {}
    const target = Array.isArray(next) ? next.at(-1) : next
    if (typeof target !== "object" || target === null || Array.isArray(target)) {
      fail(`${part} is not a table`)
    }
    if (current[part] === undefined) current[part] = target as MutableTable
    current = target as MutableTable
  }
  return current
}

class ValueReader {
  private index = 0
  private readonly source: string
  private readonly fail: (message: string) => never

  constructor(source: string, fail: (message: string) => never) {
    this.source = source
    this.fail = fail
  }

  value(): TomlValue {
    this.skipSpace()
    const char = this.source[this.index]
    if (char === '"' || char === "'") return this.string()
    if (char === "[") return this.array()
    if (char === "{") return this.inlineTable()
    const match = /^(?:true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(
      this.source.slice(this.index),
    )
    if (match === null) return this.fail(`unsupported value ${this.source.slice(this.index)}`)
    this.index += match[0].length
    if (match[0] === "true") return true
    if (match[0] === "false") return false
    return Number(match[0].replaceAll("_", ""))
  }

  keyPart(): string {
    this.skipSpace()
    const char = this.source[this.index]
    if (char === '"' || char === "'") {
      const key = this.string()
      this.skipSpace()
      return key
    }
    const match = /^[A-Za-z0-9_-]+/.exec(this.source.slice(this.index))
    if (match === null) return this.fail(`invalid key ${this.source}`)
    this.index += match[0].length
    this.skipSpace()
    return match[0]
  }

  consume(char: string): boolean {
    this.skipSpace()
    if (this.source[this.index] !== char) return false
    this.index++
    return true
  }

  end(): void {
    this.skipSpace()
    if (this.index !== this.source.length) {
      this.fail(`unexpected ${this.source.slice(this.index)}`)
    }
  }

  private string(): string {
    const quote = this.source[this.index]
    this.index++
    let out = ""
    for (;;) {
      const char = this.source[this.index]
      if (char === undefined) return this.fail("a string is not closed")
      this.index++
      if (char === quote) return out
      if (char === "\\" && quote === '"') {
        const escaped = this.source[this.index]
        this.index++
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }
        const replacement = escaped === undefined ? undefined : simple[escaped]
        if (replacement === undefined) return this.fail(`unsupported escape \\${escaped ?? ""}`)
        out += replacement
      } else out += char
    }
  }

  private array(): TomlValue[] {
    this.index++
    const items: TomlValue[] = []
    for (;;) {
      if (this.consume("]")) return items
      items.push(this.value())
      if (!this.consume(",")) {
        if (!this.consume("]")) this.fail("expected , or ] in an array")
        return items
      }
    }
  }

  private inlineTable(): TomlTable {
    this.index++
    const table: MutableTable = {}
    if (this.consume("}")) return table
    for (;;) {
      const path: string[] = [this.keyPart()]
      while (this.consume(".")) path.push(this.keyPart())
      if (!this.consume("=")) this.fail("expected = in an inline table")
      const target = descend(table, path.slice(0, -1), this.fail)
      target[path.at(-1) ?? this.fail("empty key")] = this.value()
      if (this.consume("}")) return table
      if (!this.consume(",")) this.fail("expected , or } in an inline table")
    }
  }

  private skipSpace(): void {
    while (this.source[this.index] === " " || this.source[this.index] === "\t") this.index++
  }
}
