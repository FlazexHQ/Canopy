import { timestampParts } from "./values.ts"

/**
 * Cluster time on the wire: the decimal string of the uint64 `(seconds << 32) | increment`.
 */
export type ClusterTime = string

const CT = /^\d{1,20}$/
const UINT64_MAX = (1n << 64n) - 1n

/** Returns true when `value` is a valid `ct` string. */
export function isClusterTime(value: unknown): value is ClusterTime {
  if (typeof value !== "string" || !CT.test(value)) return false
  return BigInt(value) <= UINT64_MAX
}

/** Converts a `ct` string to its uint64 value. */
export function ctToBigInt(ct: ClusterTime): bigint {
  if (!isClusterTime(ct)) throw new TypeError(`Invalid cluster time: ${ct}`)
  return BigInt(ct)
}

/** Builds a `ct` from seconds and increment. */
export function ctFromParts(t: number, i: number): ClusterTime {
  return ((BigInt(t >>> 0) << 32n) | BigInt(i >>> 0)).toString()
}

/** Splits a `ct` into seconds and increment. */
export function ctToParts(ct: ClusterTime): { t: number; i: number } {
  const value = ctToBigInt(ct)
  return { t: Number(value >> 32n), i: Number(value & 0xffffffffn) }
}

/** Compares two cluster times: negative when `a` is earlier, zero when equal, positive when later. */
export function compareCt(a: ClusterTime, b: ClusterTime): number {
  const x = ctToBigInt(a)
  const y = ctToBigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Returns the later of two cluster times. */
export function maxCt(a: ClusterTime, b: ClusterTime): ClusterTime {
  return compareCt(a, b) >= 0 ? a : b
}

/**
 * Converts a driver `Timestamp` (for example `session.operationTime`) into a `ct` string. Returns `undefined`
 * when `value` is not a timestamp.
 */
export function toCt(value: unknown): ClusterTime | undefined {
  const parts = timestampParts(value)
  return parts === undefined ? undefined : ctFromParts(parts.t, parts.i)
}

/** The zero cluster time, earlier than every real one. */
export const ZERO_CT: ClusterTime = "0"
