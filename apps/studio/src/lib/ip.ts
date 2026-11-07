/**
 * IP address and CIDR matching for the admin allowlist, the same rules as the server (`@canopy/server`):
 * IPv4 and IPv6, IPv4 mapped addresses count as IPv4, an empty list allows everything.
 */
/** A parsed address: IPv4 mapped IPv6 addresses (`::ffff:10.0.0.1`) count as IPv4. */
interface Address {
  readonly version: 4 | 6
  readonly value: bigint
}

/** An allowlist entry: an address, or a network in CIDR notation. */
interface Rule extends Address {
  readonly bits: number
}

function ipv4(text: string): bigint | undefined {
  const parts = text.split(".")
  if (parts.length !== 4) return undefined
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined
    value = value * 256n + BigInt(part)
  }
  return value
}

function ipv6(text: string): bigint | undefined {
  let head = text
  let tail: bigint | undefined
  const lastColon = head.lastIndexOf(":")
  if (head.slice(lastColon + 1).includes(".")) {
    tail = ipv4(head.slice(lastColon + 1))
    if (tail === undefined) return undefined
    head = `${head.slice(0, lastColon + 1)}0:0`
  }
  const halves = head.split("::")
  if (halves.length > 2) return undefined
  const groups = (part: string): string[] | undefined =>
    part === ""
      ? []
      : part.split(":").every((g) => /^[0-9a-f]{1,4}$/i.test(g))
        ? part.split(":")
        : undefined
  const left = groups(halves[0] ?? "")
  const right = halves.length === 2 ? groups(halves[1] ?? "") : []
  if (left === undefined || right === undefined) return undefined
  const missing = 8 - left.length - right.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const all = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
  let value = 0n
  for (const group of all) value = value * 65536n + BigInt(Number.parseInt(group, 16))
  if (tail !== undefined) value = ((value >> 32n) << 32n) | tail
  return value
}

const MAPPED = 0xffffn << 32n

/** Parses an IPv4 or IPv6 address (brackets and a zone suffix are ignored). */
function parseAddress(text: string): Address | undefined {
  const bare = text
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
  const four = ipv4(bare)
  if (four !== undefined) return { version: 4, value: four }
  const six = ipv6(bare)
  if (six === undefined) return undefined
  if (six >> 32n === MAPPED >> 32n) return { version: 4, value: six & 0xffffffffn }
  return { version: 6, value: six }
}

/** Parses an allowlist entry such as `203.0.113.7`, `10.0.0.0/8` or `2001:db8::/32`. */
function parseRule(text: string): Rule | undefined {
  const slash = text.indexOf("/")
  const address = parseAddress(slash < 0 ? text : text.slice(0, slash))
  if (address === undefined) return undefined
  const width = address.version === 4 ? 32 : 128
  if (slash < 0) return { ...address, bits: width }
  const bitsText = text.slice(slash + 1)
  if (!/^\d{1,3}$/.test(bitsText)) return undefined
  const bits = Number(bitsText)
  if (bits > width) return undefined
  return { ...address, bits }
}

/** Whether `text` is a valid allowlist entry. */
export function isAllowRule(text: string): boolean {
  return parseRule(text) !== undefined
}

/**
 * Whether `address` may use the admin surface under `rules`. An empty list allows every address; otherwise
 * an unknown or unparsable address is refused, so the check fails closed.
 */
export function addressAllowed(address: string | undefined, rules: readonly string[]): boolean {
  if (rules.length === 0) return true
  const parsed = address === undefined ? undefined : parseAddress(address)
  if (parsed === undefined) return false
  const width = parsed.version === 4 ? 32 : 128
  for (const text of rules) {
    const rule = parseRule(text)
    if (rule === undefined || rule.version !== parsed.version) continue
    const shift = BigInt(width - rule.bits)
    if (parsed.value >> shift === rule.value >> shift) return true
  }
  return false
}
