export const bypassCorpus: [string, unknown][] = [
  ["$where with code", { $where: "sleep(1000) || true" }],
  ["$where nested in $or", { $or: [{ a: 1 }, { $where: "true" }] }],
  [
    "$function inside $expr",
    { $expr: { $function: { body: "return true", args: [], lang: "js" } } },
  ],
  ["$accumulator inside $expr", { $expr: { $accumulator: {} } }],
  ["$expr reading a hidden field", { $expr: { $gt: ["$salary", 100000] } }],
  ["$jsonSchema as an oracle", { $jsonSchema: { properties: { salary: { minimum: 100000 } } } }],
  ["an unknown top level operator", { $comment2: "x" }],
  ["an unknown field operator", { a: { $gtx: 1 } }],
  ["operators mixed with fields", { a: { $gt: 1, b: 2 } }],
  ["a $ prefixed path", { $a: 1 }],
  ["a positional path in a filter", { "a.$": 1 }],
  ["an empty path segment", { "a..b": 1 }],
  ["a NUL in a path", { "a\0b": 1 }],
  ["__proto__ as a path", JSON.parse('{"__proto__": {"admin": true}}')],
  ["constructor as a path segment", { "a.constructor.prototype": 1 }],
  ["prototype pollution in a value", { a: { $eq: JSON.parse('{"__proto__": {"x": 1}}') } }],
  ["a $ key inside a literal value", { a: { $eq: { $gt: "" } } }],
  ["a variable in a user filter", { ownerId: { $auth: "sub" } }],
  ["a $ctx variable in a user filter", { projectId: { $in: { $ctx: "projectIds" } } }],
  ["an empty $or", { $or: [] }],
  ["a non document $and branch", { $and: [1] }],
  ["$options without $regex", { a: { $options: "i" } }],
  ["bad regex options", { a: { $regex: "x", $options: "g" } }],
  ["$not with a literal", { a: { $not: 5 } }],
  ["a huge $in", { a: { $in: Array.from({ length: 5000 }, (_, i) => i) } }],
  ["$text below the top level", { $or: [{ $text: { $search: "x" } }] }],
]

/**
 * Attempts against `GET /rest/v1/{collection}` that the filter corpus above cannot express: the other
 * parameters of a read and the headers that change what it returns. `query` is the query string, `prefer` the
 * `Prefer` header. They run against the DLS equivalence suite's `items` collection, whose `secret` field is
 * hidden from every caller and whose documents each caller may read only in part.
 */
export interface BypassRequest {
  readonly name: string
  readonly query: Readonly<Record<string, string>>
  readonly prefer?: string
}

export const bypassRequests: readonly BypassRequest[] = [
  { name: "a filter on a hidden field", query: { filter: '{"secret":"s1"}' } },
  { name: "a hidden field inside $or", query: { filter: '{"$or":[{"level":0},{"secret":"s1"}]}' } },
  { name: "a hidden field in a shorthand filter", query: { secret: "s1" } },
  {
    name: "a hidden field as an oracle in $in",
    query: { filter: '{"secret":{"$in":["s1","s2"]}}' },
  },
  { name: "a sort by a hidden field", query: { sort: "secret" } },
  { name: "a descending sort by a hidden field", query: { sort: "-secret,_id" } },
  { name: "a projection of a hidden field", query: { fields: "secret" } },
  {
    name: "a projection of a hidden field next to a readable one",
    query: { fields: "level,secret" },
  },
  { name: "an exclusion that leaves the hidden field in", query: { fields: "-level" } },
  { name: "write parameters on a read: where", query: { where: '{"level":{"$gte":0}}' } },
  { name: "write parameters on a read: upsert", query: { upsert: "true" } },
  {
    name: "another owner's documents in a shorthand filter",
    query: { ownerId: "u2", limit: "100" },
  },
  { name: "every document with the largest page", query: { limit: "100" } },
  { name: "a page over the limit", query: { limit: "100000" } },
  { name: "a page of zero", query: { limit: "0" } },
  { name: "a negative page", query: { limit: "-1" } },
  { name: "a negative skip", query: { skip: "-1" } },
  { name: "a skip over the limit", query: { skip: "100000000" } },
  { name: "a skip and a cursor together", query: { skip: "1", after: "eyJzIjpbXSwicSI6IjAifQ" } },
  { name: "a cursor of nothing", query: { after: "e30" } },
  {
    name: "a forged cursor",
    query: { after: "eyJzIjpbIngiXSwicSI6ImZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIn0" },
  },
  {
    name: "a cursor with an operator in it",
    query: { after: "eyJzIjpbeyIkd2hlcmUiOiIxIn0sMV0sInEiOiIwIn0" },
  },
  { name: "a cursor that is not base64", query: { after: "%%%" } },
  { name: "a filter that is not JSON", query: { filter: "{" } },
  { name: "a filter that is an array", query: { filter: "[1]" } },
  { name: "a filter that is a string", query: { filter: '"x"' } },
  { name: "an unknown parameter", query: { internal: "1" } },
  {
    name: "a count of the documents the caller cannot read",
    query: { limit: "1" },
    prefer: "count=exact",
  },
  { name: "an estimated count", query: { limit: "1" }, prefer: "count=estimated" },
  {
    name: "a count with a filter on a hidden field",
    query: { filter: '{"secret":"s1"}' },
    prefer: "count=exact",
  },
  { name: "an explain request", query: { explain: "true" } },
]
