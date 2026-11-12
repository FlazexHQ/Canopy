const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/

/** Whether `name` is a valid GraphQL name that does not use the reserved `__` prefix. */
export function isGraphqlName(name: string): boolean {
  return NAME.test(name) && !name.startsWith("__")
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
}

/** `user_profiles` and `userProfiles` become `UserProfiles`. */
export function pascalCase(name: string): string {
  return words(name)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
}

/** `user_profiles` becomes `userProfiles`; a name that starts with a digit gets a leading `_`. */
export function camelCase(name: string): string {
  const pascal = pascalCase(name)
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1)
  return /^[0-9]/.test(camel) ? `_${camel}` : camel
}

const IRREGULAR: Readonly<Record<string, string>> = {
  people: "person",
  children: "child",
  men: "man",
  women: "woman",
  mice: "mouse",
  geese: "goose",
  data: "datum",
  indices: "index",
  statuses: "status",
  addresses: "address",
}

const UNCOUNTABLE = new Set([
  "news",
  "series",
  "species",
  "sheep",
  "fish",
  "equipment",
  "information",
])

/** An English singular for a collection name: `todos` gives `todo`, `categories` gives `category`. */
export function singularize(word: string): string {
  const lower = word.toLowerCase()
  if (UNCOUNTABLE.has(lower)) return word
  const irregular = IRREGULAR[lower]
  if (irregular !== undefined) return word.slice(0, 1) + irregular.slice(1)
  if (/[^aeiou]ies$/i.test(word)) return `${word.slice(0, -3)}y`
  if (/(ss|sh|ch|x|z)es$/i.test(word)) return word.slice(0, -2)
  if (/ss$/i.test(word) || /us$/i.test(word) || /is$/i.test(word)) return word
  if (/s$/i.test(word)) return word.slice(0, -1)
  return word
}

/**
 * Turns a field name into a GraphQL name: valid names are kept, others have every invalid character
 * replaced by `_` and get a leading `_` when they start with a digit or the reserved `__`.
 */
export function fieldName(name: string): string {
  if (isGraphqlName(name)) return name
  let out = name.replace(/[^_0-9A-Za-z]/g, "_")
  if (out === "" || /^[0-9]/.test(out) || out.startsWith("__")) out = `_${out.replace(/^_+/, "")}`
  return out === "_" ? "_field" : out
}

/** The GraphQL names of one collection. */
export interface CollectionNames {
  /** The object type, such as `Todo`. */
  readonly type: string
  /** The list query, such as `todos`. */
  readonly list: string
  /** The query by `_id`, such as `todo`. */
  readonly one: string
  /** The count query, such as `todosCount`. */
  readonly count: string
  /** The singular used in mutation names, such as `Todo` in `insertTodo`. */
  readonly singular: string
  /** The plural used in bulk mutation names, such as `Todos` in `updateTodos`. */
  readonly plural: string
}

/**
 * Derives the names of a collection: `todos` becomes type `Todo` with queries `todos`, `todo` and
 * `todosCount`. `typeName` overrides the singular.
 */
export function collectionNames(collection: string, typeName?: string): CollectionNames {
  const type = typeName ?? pascalCase(singularize(collection.split(".").pop() ?? collection))
  const list = camelCase(collection)
  const singular = type.charAt(0).toLowerCase() + type.slice(1)
  const one = singular === list ? `${list}ById` : singular
  const plural = pascalCase(collection)
  return {
    type: type === "" ? "Document" : type,
    list,
    one,
    count: `${list}Count`,
    singular: type,
    plural: plural === type ? `${plural}List` : plural,
  }
}
