import { en } from "./en/index.ts"

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>
}[keyof T & string]

/** A key of the message catalog, for example `data.title`. */
export type MessageKey = Leaves<typeof en>

/** Parameters substituted into `{name}` placeholders. */
export type MessageParams = Readonly<Record<string, string | number>>

const locale = "en"

function lookup(key: string): string {
  let node: unknown = en
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return key
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string" ? node : key
}

/**
 * Returns the message for a key with `{name}` placeholders filled in. Every user facing string goes through
 * this function so a later locale only adds a catalog.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const message = lookup(key)
  if (params === undefined) return message
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : typeof value === "number" ? formatNumber(value) : value
  })
}

const numberFormat = new Intl.NumberFormat(locale)
const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" })
const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat.format(date)
}

/** Formats a time relative to `now`, for example "3 minutes ago". */
export function formatRelative(value: string | number | Date, now: number = Date.now()): string {
  const date = value instanceof Date ? value : new Date(value)
  const seconds = Math.round((date.getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return relativeFormat.format(seconds, "second")
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute")
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), "hour")
  return relativeFormat.format(Math.round(seconds / 86_400), "day")
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}

export function formatPercent(ratio: number): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(ratio)
}
