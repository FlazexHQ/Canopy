import { addressMatches, isAddressRule } from "@canopy/auth"

/** Whether `text` is a valid allowlist entry: an address or a CIDR range, IPv4 or IPv6. */
export function isAllowRule(text: string): boolean {
  return isAddressRule(text)
}

/**
 * Whether `address` may use the admin surface under `rules`. An empty list allows every address; otherwise
 * an unknown or unparsable address is refused, so the check fails closed.
 */
export function addressAllowed(address: string | undefined, rules: readonly string[]): boolean {
  if (rules.length === 0) return true
  return address !== undefined && addressMatches(address, rules)
}
