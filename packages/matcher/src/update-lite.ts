/**
 * The update engine of `@canopy/matcher/lite` as its own entry point, so browser bundles can load it
 * lazily (`import("@canopy/matcher/update")`) and keep it out of the entry chunk. Without the regex
 * translator, `$pull` with a regular expression throws `UnsupportedQueryError`.
 */
export { applyUpdate, isOperatorUpdate, type UpdateOptions } from "./update.ts"
