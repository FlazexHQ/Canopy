import {
  type DocumentNode,
  type FragmentDefinitionNode,
  GraphQLError,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLSchema,
  getNamedType,
  isInterfaceType,
  isObjectType,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
  valueFromASTUntyped,
} from "graphql"

/** Limits on one GraphQL operation. */
export interface OperationLimits {
  /** The deepest field nesting. Defaults to 10. */
  readonly maxDepth: number
  /**
   * The largest cost: every field costs 1, multiplied by the `limit` of each list field above it (its
   * default when the argument is left out). Defaults to 5,000.
   */
  readonly maxComplexity: number
  /** The most aliased fields. Defaults to 30. */
  readonly maxAliases: number
}

/** Default operation limits. */
export const DEFAULT_OPERATION_LIMITS: OperationLimits = {
  maxDepth: 10,
  maxComplexity: 5000,
  maxAliases: 30,
}

/** What an operation measures. */
export interface OperationCost {
  readonly depth: number
  readonly complexity: number
  readonly aliases: number
}

interface Walk {
  readonly schema: GraphQLSchema
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>
  readonly variables: Readonly<Record<string, unknown>>
  aliases: number
  depth: number
}

function fieldOf(
  type: GraphQLNamedType | undefined,
  name: string,
): GraphQLField<unknown, unknown> | undefined {
  if (type === undefined) return undefined
  if (isObjectType(type) || isInterfaceType(type)) return type.getFields()[name]
  return undefined
}

function argumentValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  return valueFromASTUntyped(node, variables)
}

/**
 * The multiplier a field puts on its subtree: its `limit` argument, or that argument's default when the
 * argument is left out, null, or a variable without a value.
 */
function multiplier(
  field: GraphQLField<unknown, unknown> | undefined,
  args: readonly { readonly name: { readonly value: string }; readonly value: ValueNode }[],
  variables: Readonly<Record<string, unknown>>,
): number {
  const given = args.find((arg) => arg.name.value === "limit")
  const fallback = field?.args.find((arg) => arg.name === "limit")?.defaultValue
  const supplied = given === undefined ? undefined : argumentValue(given.value, variables)
  const value = supplied === undefined || supplied === null ? fallback : supplied
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1
}

function cost(
  walk: Walk,
  selections: SelectionSetNode,
  parent: GraphQLNamedType | undefined,
  factor: number,
  depth: number,
  visiting: Set<string>,
): number {
  let total = 0
  for (const selection of selections.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith("__")) continue
      if (selection.alias !== undefined) walk.aliases += 1
      walk.depth = Math.max(walk.depth, depth)
      total += factor
      if (selection.selectionSet === undefined) continue
      const field = fieldOf(parent, selection.name.value)
      const child = field === undefined ? undefined : getNamedType(field.type)
      total += cost(
        walk,
        selection.selectionSet,
        child,
        factor * multiplier(field, selection.arguments ?? [], walk.variables),
        depth + 1,
        visiting,
      )
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const condition = selection.typeCondition?.name.value
      const type = condition === undefined ? parent : (walk.schema.getType(condition) ?? undefined)
      total += cost(walk, selection.selectionSet, type, factor, depth, visiting)
    } else {
      const name = selection.name.value
      const fragment = walk.fragments.get(name)
      if (fragment === undefined || visiting.has(name)) continue
      visiting.add(name)
      const type = walk.schema.getType(fragment.typeCondition.name.value) ?? undefined
      total += cost(walk, fragment.selectionSet, type, factor, depth, visiting)
      visiting.delete(name)
    }
  }
  return total
}

/** Measures the depth, aliases and cost of the operation that will run. */
export function measureOperation(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables: Readonly<Record<string, unknown>> | null | undefined,
  operationName?: string | null,
): OperationCost {
  const fragments = new Map<string, FragmentDefinitionNode>()
  const operations: OperationDefinitionNode[] = []
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition)
    else if (definition.kind === Kind.OPERATION_DEFINITION) operations.push(definition)
  }
  const operation =
    operationName === undefined || operationName === null
      ? operations[0]
      : operations.find((candidate) => candidate.name?.value === operationName)
  if (operation === undefined) return { depth: 0, complexity: 0, aliases: 0 }
  const root =
    operation.operation === "query"
      ? schema.getQueryType()
      : operation.operation === "mutation"
        ? schema.getMutationType()
        : schema.getSubscriptionType()
  const effective: Record<string, unknown> = {}
  for (const definition of operation.variableDefinitions ?? [])
    if (definition.defaultValue !== undefined)
      effective[definition.variable.name.value] = valueFromASTUntyped(definition.defaultValue)
  const walk: Walk = {
    schema,
    fragments,
    variables: { ...effective, ...variables },
    aliases: 0,
    depth: 0,
  }
  const complexity = cost(walk, operation.selectionSet, root ?? undefined, 1, 1, new Set())
  return { depth: walk.depth, complexity, aliases: walk.aliases }
}

/**
 * Checks an operation against the limits and returns the errors, each with `extensions.code`
 * `CANOPY_INVALID_QUERY`; an empty list when it fits.
 */
export function checkOperation(
  schema: GraphQLSchema,
  document: DocumentNode,
  variables: Readonly<Record<string, unknown>> | null | undefined,
  operationName: string | null | undefined,
  limits: OperationLimits,
): GraphQLError[] {
  const measured = measureOperation(schema, document, variables, operationName)
  const errors: GraphQLError[] = []
  const fail = (message: string, limit: string, value: number, max: number): void => {
    errors.push(
      new GraphQLError(message, {
        extensions: { code: "CANOPY_INVALID_QUERY", details: { limit, value, max } },
      }),
    )
  }
  if (measured.depth > limits.maxDepth)
    fail(
      `The operation is ${measured.depth} fields deep; at most ${limits.maxDepth} are allowed`,
      "depth",
      measured.depth,
      limits.maxDepth,
    )
  if (measured.aliases > limits.maxAliases)
    fail(
      `The operation uses ${measured.aliases} aliases; at most ${limits.maxAliases} are allowed`,
      "aliases",
      measured.aliases,
      limits.maxAliases,
    )
  if (measured.complexity > limits.maxComplexity)
    fail(
      `The operation costs ${measured.complexity}; the budget is ${limits.maxComplexity}`,
      "complexity",
      measured.complexity,
      limits.maxComplexity,
    )
  return errors
}
