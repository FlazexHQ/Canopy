/**
 * The matcher without the regex translator, for browser bundles. It evaluates the same operators as
 * `@canopy/matcher` with the same results, except that `$regex` (and regular expression values) throw
 * `UnsupportedQueryError`, so callers fall back to the server for those queries.
 */
export {
  Bracket,
  type BsonType,
  bracketOf,
  bsonTypeOf,
  compareValues,
  valuesEqual,
} from "./compare.ts"
export { UnsupportedQueryError, UpdateError } from "./errors.ts"
export { type CompiledFilter, compileFilter, type DocTest, isMatcherSafe } from "./filter.ts"
export { type CompiledProjection, compileProjection } from "./projection.ts"
export { compileSort, type DocComparator, parseSort, type SortKey } from "./sort.ts"
export { applyUpdate, isOperatorUpdate, type UpdateOptions } from "./update.ts"
