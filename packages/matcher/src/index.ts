export {
  Bracket,
  type BsonType,
  bracketOf,
  bsonTypeOf,
  compareStrings,
  compareValues,
  valuesEqual,
} from './compare.ts'
export { equalityKey } from './equality-key.ts'
export { UnsupportedQueryError, UpdateError } from './errors.ts'
export { type CompiledFilter, compileFilter, type DocTest, isMatcherSafe } from './filter.ts'
export {
  compareNumeric,
  isInt32,
  type NumericKind,
  type NumericValue,
  readNumeric,
} from './numeric.ts'
export {
  anyPathValue,
  collectPathValues,
  getPath,
  isArrayIndex,
  type LeafTest,
  splitPath,
} from './path.ts'
export {
  buildTree,
  type CompiledProjection,
  compileProjection,
  exclusion,
  inclusion,
  type ProjectionTree,
} from './projection.ts'
export { compileRegex, isLinearRegex, type LinearRegex, REGEX_LIMITS } from './regex.ts'
export {
  compileSort,
  type DocComparator,
  parseSort,
  type SortKey,
  sortKeyOf,
  withIdTieBreaker,
} from './sort.ts'
export { applyUpdate, isOperatorUpdate, UPDATE_OPERATORS, type UpdateOptions } from './update.ts'
