import { MAX_BODY_BYTES, PERSISTED_HASH, TODO_IDS } from "./fixture.ts"

/** One HTTP request before the target and request id are assigned. */
export interface Step {
  readonly caller: string
  readonly method: "POST" | "GET"
  readonly query?: readonly (readonly [string, string])[]
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

interface Spec {
  readonly id: string
  readonly title: string
  readonly steps: readonly Step[]
  readonly observe?: readonly string[]
  readonly generatedId?: { readonly collection: string; readonly title: string }
  readonly known?: string
}

/** A named file of GraphQL HTTP cases. */
export interface GraphqlGroup {
  readonly name: string
  readonly description: string
  readonly specs: readonly Spec[]
}

function post(body: unknown, caller = "alice"): Step {
  return {
    caller,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

function get(query: Record<string, string>, caller = "alice"): Step {
  return {
    caller,
    method: "GET",
    query: Object.entries(query),
    headers: { accept: "application/graphql-response+json" },
  }
}

function operation(
  id: string,
  title: string,
  query: string,
  options: { caller?: string; variables?: Record<string, unknown>; operationName?: string } = {},
): Spec {
  const { caller, ...params } = options
  return { id, title, steps: [post({ query, ...params }, caller)] }
}

function mutation(id: string, title: string, query: string): Spec {
  return { ...operation(id, title, query), observe: ["todos"] }
}

const insertId = "600000000000000000000007"
const insert = `mutation { insertTodo(doc: { _id: "${insertId}", title: "new", ownerId: "alice" }) { _id title } }`
const counted = { query: "{ todosCount }" }

function bodyOfSize(size: number): Step {
  const step = post(counted)
  return { ...step, body: step.body?.padEnd(size, " ") ?? "" }
}

/** The requests to send on independently seeded databases, grouped by behavior. */
export const GRAPHQL_GROUPS: readonly GraphqlGroup[] = [
  {
    name: "queries",
    description: "Typed queries, BSON scalars, pagination and operation selection",
    specs: [
      operation(
        "sorted-window",
        "Filter, sort, skip and limit a list, with its filtered count and snapshot time",
        "{ todos(filter: { priority: { gte: 2 } }, sort: [{ field: priority, direction: DESC }], skip: 1, limit: 1) { nodes { title priority } total ct } }",
      ),
      operation(
        "bson-and-nested",
        "Serialize an ObjectId, date, numbers, an array and a nested document",
        `{ todo(id: "${TODO_IDS[0]}") { _id createdAt priority estimate tags detail { note } } }`,
      ),
      operation(
        "variables-and-fragments",
        "Use an id variable, aliases and both kinds of fragments",
        "query Pick($id: ObjectId!) { picked: todo(id: $id) { ...Summary ... on Todo { priority } } } fragment Summary on Todo { label: title }",
        { variables: { id: TODO_IDS[1] } },
      ),
      operation(
        "select-operation",
        "Run the named operation from a document with two operations",
        "query All { todosCount } query Active($minimum: Int!) { todosCount(filter: { priority: { gt: $minimum } }) }",
        { operationName: "Active", variables: { minimum: 2 } },
      ),
      operation(
        "nested-relation",
        "Resolve the owner relation of a caller's document",
        `{ todo(id: "${TODO_IDS[0]}") { title owner { name } } }`,
      ),
      operation(
        "absent-by-id",
        "A missing document returns null",
        '{ todo(id: "600000000000000000000099") { title } }',
      ),
    ],
  },
  {
    name: "policies",
    description: "Caller specific schemas, document and field rules, and context lookups",
    specs: [
      operation(
        "other-owner",
        "A document owned by another caller returns null",
        `{ todo(id: "${TODO_IDS[4]}") { title } todosCount }`,
      ),
      operation(
        "restrictive-read",
        "A restrictive policy excludes archived staff",
        "{ staff(sort: [{ field: _id }], limit: 2) { nodes { name } total } }",
      ),
      operation(
        "field-hidden",
        "The authenticated schema omits the secret field",
        `{ todo(id: "${TODO_IDS[0]}") { title secret } }`,
      ),
      operation(
        "collection-hidden",
        "An unexposed collection is absent from the authenticated schema",
        "{ hiddenCount }",
      ),
      {
        id: "context-lookup",
        title: "Memberships scope tasks differently for Alice and Bob",
        steps: ["alice", "bob"].map((caller) =>
          post(
            { query: "{ tasks(sort: [{ field: _id }], limit: 3) { nodes { title } total } }" },
            caller,
          ),
        ),
      },
      operation(
        "anonymous-public",
        "The anonymous caller can read a public collection",
        "{ notices(limit: 1) { nodes { title } } }",
        { caller: "anon" },
      ),
      operation(
        "anonymous-private",
        "The anonymous schema omits private collections",
        "{ todosCount }",
        { caller: "anon" },
      ),
      operation(
        "service-bypass",
        "The service caller sees every owner and the secret field",
        `{ todo(id: "${TODO_IDS[4]}") { secret } todosCount }`,
        { caller: "service" },
      ),
      operation(
        "service-hidden",
        "The service caller can see the unexposed collection",
        "{ hiddenCount }",
        { caller: "service" },
      ),
      operation("missing-key", "A request without a key is rejected", "{ __typename }", {
        caller: "none",
      }),
      operation("expired-token", "A correctly signed expired token is rejected", "{ __typename }", {
        caller: "expired",
      }),
      operation("invalid-token", "A tampered token is rejected", "{ __typename }", {
        caller: "tampered",
      }),
    ],
  },
  {
    name: "mutations",
    description: "Write results, policy refusals and documents left behind",
    specs: [
      mutation("insert-owned", "Insert a document with a supplied ObjectId", insert),
      {
        ...mutation(
          "insert-generated",
          "Insert a document with a generated ObjectId",
          'mutation { insertTodo(doc: { title: "generated", ownerId: "alice" }) { _id title } }',
        ),
        generatedId: { collection: "todos", title: "generated" },
      },
      mutation(
        "insert-check",
        "Reject an insert with another owner",
        `mutation { insertTodo(doc: { _id: "${insertId}", title: "refused", ownerId: "bob" }) { _id } }`,
      ),
      mutation(
        "update-owned",
        "Update the caller's document and return its new value",
        `mutation { updateTodo(id: "${TODO_IDS[0]}", update: { inc: { priority: 2 } }) { _id priority } }`,
      ),
      mutation(
        "update-check",
        "Reject a change of owner and keep the original document",
        `mutation { updateTodo(id: "${TODO_IDS[0]}", update: { set: { ownerId: "bob" } }) { _id } }`,
      ),
      mutation(
        "update-outside-scope",
        "An update cannot touch another owner's document",
        `mutation { updateTodo(id: "${TODO_IDS[4]}", update: { set: { title: "changed" } }) { _id } }`,
      ),
      mutation(
        "bulk-update",
        "Update only the caller's matching documents and return the commit time",
        "mutation { updateTodos(filter: { priority: { gte: 3 } }, update: { inc: { priority: 1 } }) { matched modified ct } }",
      ),
      mutation(
        "replace-owned",
        "Replace a document owned by the caller",
        `mutation { replaceTodo(id: "${TODO_IDS[0]}", doc: { title: "replaced", ownerId: "alice" }) { _id title } }`,
      ),
      mutation(
        "delete-owned",
        "Delete a document owned by the caller",
        `mutation { deleteTodo(id: "${TODO_IDS[0]}") { _id title } }`,
      ),
      mutation(
        "delete-outside-scope",
        "A delete cannot touch another owner's document",
        `mutation { deleteTodo(id: "${TODO_IDS[4]}") { _id } }`,
      ),
      {
        id: "idempotent-insert",
        title: "An insert retried with the same key leaves one document",
        steps: [1, 2].map(() => ({
          ...post({ query: insert }),
          headers: { "content-type": "application/json", "idempotency-key": "graphql-insert-0001" },
        })),
        observe: ["todos"],
      },
    ],
  },
  {
    name: "limits",
    description: "Operations at the limit and one unit beyond it",
    specs: [
      operation(
        "depth-at-limit",
        "Three levels of fields fit the depth limit",
        "{ todos(limit: 1) { nodes { title } } }",
      ),
      operation(
        "depth-over-limit",
        "Four levels of fields exceed the depth limit",
        "{ todos(limit: 1) { nodes { detail { note } } } }",
      ),
      operation(
        "aliases-at-limit",
        "Three aliases fit the alias limit",
        "{ a: todosCount b: todosCount c: todosCount }",
      ),
      operation(
        "aliases-over-limit",
        "Four aliases exceed the alias limit",
        "{ a: todosCount b: todosCount c: todosCount d: todosCount }",
      ),
      operation(
        "complexity-at-limit",
        "A list operation with cost ten fits the complexity budget",
        "query Page($limit: Int!) { todos(limit: $limit) { nodes { title } total } }",
        { variables: { limit: 3 } },
      ),
      operation(
        "complexity-over-limit",
        "An additional root field raises the cost to eleven",
        "query Page($limit: Int!) { todos(limit: $limit) { nodes { title } total } todosCount }",
        { variables: { limit: 3 } },
      ),
      {
        id: "body-at-limit",
        title: `A JSON body of ${MAX_BODY_BYTES} bytes fits the body limit`,
        steps: [bodyOfSize(MAX_BODY_BYTES)],
      },
      {
        id: "body-over-limit",
        title: `A JSON body of ${MAX_BODY_BYTES + 1} bytes exceeds the body limit`,
        steps: [bodyOfSize(MAX_BODY_BYTES + 1)],
        known:
          "The early body limit response omits the request id and its content type varies by runtime.",
      },
    ],
  },
  {
    name: "transport",
    description: "GET, batching, persisted operations and introspection",
    specs: [
      {
        id: "get-with-params",
        title: "A GET request accepts a query, variables and the operation name",
        steps: [
          get({
            query:
              "query All { todosCount } query Pick($id: ObjectId!) { todo(id: $id) { title } }",
            variables: JSON.stringify({ id: TODO_IDS[0] }),
            operationName: "Pick",
          }),
        ],
      },
      {
        id: "get-mutation",
        title: "GET rejects a mutation without inserting a document",
        steps: [get({ query: insert })],
        observe: ["todos"],
      },
      {
        id: "batch-at-limit",
        title: "Two operations in one batch return results in request order",
        steps: [post([counted, { query: "{ __typename }" }])],
      },
      {
        id: "batch-over-limit",
        title: "A third operation exceeds the batch limit",
        steps: [post([counted, counted, counted])],
      },
      {
        id: "persisted-hit",
        title: "A registered hash resolves to its query without query text",
        steps: [
          post({ extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } } }),
        ],
      },
      {
        id: "persisted-miss",
        title: "An unregistered hash returns PersistedQueryNotFound",
        steps: [
          post({ extensions: { persistedQuery: { version: 1, sha256Hash: "0".repeat(64) } } }),
        ],
      },
      operation(
        "introspection-allowed",
        "An authenticated caller can inspect the schema root types",
        "{ __schema { queryType { name } mutationType { name } subscriptionType { name } } }",
      ),
      operation(
        "introspection-denied",
        "An anonymous caller cannot inspect the schema",
        '{ __type(name: "Query") { name } }',
        { caller: "anon" },
      ),
    ],
  },
  {
    name: "errors",
    description: "GraphQL validation and invalid HTTP request bodies",
    specs: [
      operation("unknown-field", "An unknown field fails validation", "{ unknownField }"),
      operation(
        "wrong-argument-type",
        "A list limit must be an integer",
        '{ todos(limit: "two") { nodes { title } } }',
      ),
      operation("missing-argument", "A single document query requires an id", "{ todo { title } }"),
      operation("syntax-error", "An unfinished selection fails parsing", "{ todosCount"),
      {
        id: "non-json-body",
        title: "Malformed JSON is refused",
        steps: [{ ...post(counted), body: "not JSON" }],
        known: "Yoga includes the runtime's native JSON parser message in the error extensions.",
      },
      {
        id: "wrong-content-type",
        title: "A JSON body sent as plain text is refused",
        steps: [{ ...post(counted), headers: { "content-type": "text/plain" } }],
      },
    ],
  },
]
