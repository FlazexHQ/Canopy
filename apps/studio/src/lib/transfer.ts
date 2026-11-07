import { columnsOf, displayValue } from "./ejson.ts"

/** Formats the import and export dialogs offer. */
export const TRANSFER_FORMATS = ["ejson", "json", "csv"] as const
export type TransferFormat = (typeof TRANSFER_FORMATS)[number]

function relaxed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relaxed)
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(value)
  const [first] = entries
  if (entries.length === 1 && first !== undefined && first[0].startsWith("$")) {
    const [key, inner] = first
    switch (key) {
      case "$oid":
      case "$numberDecimal":
      case "$uuid":
        return inner
      case "$date":
        return typeof inner === "object" && inner !== null && "$numberLong" in inner
          ? new Date(Number((inner as { $numberLong: string }).$numberLong)).toISOString()
          : inner
      case "$numberLong":
      case "$numberInt":
      case "$numberDouble":
        return Number(inner)
    }
  }
  return Object.fromEntries(entries.map(([key, inner]) => [key, relaxed(inner)]))
}

function csvCell(value: unknown): string {
  const text =
    value === undefined
      ? ""
      : typeof value === "object" && value !== null && !isWrapper(value)
        ? JSON.stringify(relaxed(value))
        : displayValue(value)
  return /[",\n\r]/.test(text) || text.startsWith(" ") || text.endsWith(" ")
    ? `"${text.replaceAll('"', '""')}"`
    : text
}

function isWrapper(value: object): boolean {
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0]?.startsWith("$") === true
}

/**
 * Serializes documents for download. EJSON keeps BSON types, JSON relaxes them to plain values, and CSV
 * writes one column per top level field with nested values as JSON.
 */
export function exportDocuments(
  documents: readonly Readonly<Record<string, unknown>>[],
  format: TransferFormat,
): string {
  switch (format) {
    case "ejson":
      return `${JSON.stringify(documents, null, 2)}\n`
    case "json":
      return `${JSON.stringify(documents.map(relaxed), null, 2)}\n`
    case "csv": {
      const columns = columnsOf(documents)
      const lines = [columns.map(csvCell).join(",")]
      for (const document of documents)
        lines.push(columns.map((column) => csvCell(document[column])).join(","))
      return `${lines.join("\r\n")}\r\n`
    }
  }
}

/** Splits CSV text into rows of cells, following RFC 4180 quoting. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += char
      continue
    }
    if (char === '"' && cell === "") quoted = true
    else if (char === ",") {
      row.push(cell)
      cell = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += char
  }
  if (quoted) throw new SyntaxError("Unterminated quoted CSV cell")
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function csvValue(text: string): unknown {
  if (text === "") return undefined
  if (text === "true") return true
  if (text === "false") return false
  if (text === "null") return null
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return Number(text)
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

/**
 * Reads documents from an import file. EJSON and JSON accept an array of documents or one document per
 * line; CSV takes the header row as field names and infers numbers, booleans, null and JSON values.
 */
export function importDocuments(text: string, format: TransferFormat): Record<string, unknown>[] {
  if (format === "csv") {
    const [header, ...rows] = parseCsv(text).filter((row) => row.some((cell) => cell !== ""))
    if (header === undefined) return []
    return rows.map((row) => {
      const document: Record<string, unknown> = {}
      header.forEach((name, index) => {
        const value = csvValue(row[index] ?? "")
        if (value !== undefined) document[name] = value
      })
      return document
    })
  }
  const trimmed = text.trim()
  if (trimmed === "") return []
  const values: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown)
  return values.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`Entry ${index + 1} is not a document`)
    }
    return value as Record<string, unknown>
  })
}
