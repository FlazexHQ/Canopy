import { parse } from "@canopy/protocol"
import { encodeCursor } from "../../../src/cursor.ts"

/** What a spec may refer to while it is being turned into a request: the responses recorded before it. */
export interface Recorded {
  /** The `page.next` cursor of an earlier case. */
  next(id: string): string
  /** The `etag` header of an earlier case. */
  etag(id: string): string
  /**
   * A cursor of the query of the earlier case `id` (its `next` cursor names that query) at another position.
   * `values` are canonical Extended JSON values, one per sort key including the `_id` tie breaker.
   */
  forge(id: string, values: readonly unknown[]): string
  /** A cursor made of arbitrary text, encoded as base64url without any structure check. */
  raw(text: string): string
  /** The query hash (`q`) inside the `next` cursor of an earlier case. */
  hash(id: string): string
}

/** A value known only when the case is built. */
export type Value = string | ((recorded: Recorded) => string)
type Pair = readonly [string, Value]

/** One request to record. */
export interface Spec {
  readonly id: string
  readonly title: string
  readonly caller: string
  readonly method: string
  readonly path: string
  readonly query: readonly Pair[]
  readonly headers: Readonly<Record<string, Value>>
  /** Send no `X-Request-Id`, so the server mints one. */
  readonly minted: boolean
  readonly neverInBody: readonly string[]
  /** The error detail quotes text of the regular expression engine, so only its presence is pinned. */
  readonly engineDetail: boolean
  readonly known?: string
  /** The exact request body, for the routes that take one. */
  readonly body?: Value
}

/** One output file of cases. */
export interface Group {
  readonly name: string
  readonly description: string
  readonly specs: readonly Spec[]
}

interface Extra {
  readonly method?: string
  readonly headers?: Readonly<Record<string, Value>>
  readonly minted?: boolean
  readonly neverInBody?: readonly string[]
  readonly engineDetail?: boolean
  readonly known?: string
  readonly path?: string
}

type Query = Readonly<Record<string, Value>> | readonly Pair[]

const BASE = "/rest/v1"

function pairs(query: Query | undefined): readonly Pair[] {
  if (query === undefined) return []
  return Array.isArray(query) ? query : Object.entries(query as Record<string, Value>)
}

function find(
  id: string,
  title: string,
  caller: string,
  collection: string,
  query?: Query,
  extra: Extra = {},
): Spec {
  return {
    id,
    title,
    caller,
    method: extra.method ?? "GET",
    path: extra.path ?? `${BASE}/${collection}`,
    query: pairs(query),
    headers: extra.headers ?? {},
    minted: extra.minted ?? false,
    neverInBody: extra.neverInBody ?? [],
    engineDetail: extra.engineDetail ?? false,
    ...(extra.known === undefined ? {} : { known: extra.known }),
  }
}

/** Builds the cursor text of a position from canonical Extended JSON values and the query hash. */
export function forgeCursor(hash: string, values: readonly unknown[]): string {
  return encodeCursor({ values: values.map((value) => parse(JSON.stringify(value))) }, hash)
}

const oidOf = (hex: string) => ({ $oid: hex })
const todoId = (n: number): { $oid: string } => oidOf(`6f1${n.toString(16).padStart(21, "0")}`)
const JSON_OF = JSON.stringify
const after =
  (id: string): Value =>
  (r) =>
    r.next(id)

/** Text that only appears in a body when a hidden field or its value is returned; error texts may name a field. */
const HIDDEN = ['"internalNotes":', "secret-"]
const SCORE = ['"score":']
const SALARY = ['"salary":']

function chain(
  prefix: string,
  caller: string,
  collection: string,
  query: Record<string, string>,
  pages: number,
  title: string,
): Spec[] {
  const out: Spec[] = []
  for (let page = 1; page <= pages; page += 1) {
    const id = `${prefix}-page-${page}`
    out.push(
      find(
        id,
        `${title}, page ${page}`,
        caller,
        collection,
        page === 1 ? query : { ...query, after: after(`${prefix}-page-${page - 1}`) },
      ),
    )
  }
  return out
}

const pages: Group = {
  name: "pages",
  description:
    "Plain pages without filters or sorts: the default limit, paging, empty results and what each kind of caller sees.",
  specs: [
    find(
      "alice-default-limit",
      "The default limit applies and the page has a next cursor",
      "alice",
      "todos",
      undefined,
      {
        neverInBody: HIDDEN,
      },
    ),
    find(
      "alice-limit-3",
      "An explicit limit of 3",
      "alice",
      "todos",
      { limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find(
      "alice-limit-3-page-2",
      "The second page of 3",
      "alice",
      "todos",
      { limit: "3", after: after("alice-limit-3") },
      { neverInBody: HIDDEN },
    ),
    find(
      "alice-limit-3-page-3",
      "The last page has fewer documents and no next cursor",
      "alice",
      "todos",
      { limit: "3", after: after("alice-limit-3-page-2") },
      { neverInBody: HIDDEN },
    ),
    find(
      "alice-exact-fit",
      "A limit equal to the number of visible documents leaves no next cursor",
      "alice",
      "todos",
      { limit: "8" },
      { neverInBody: HIDDEN },
    ),
    find(
      "alice-max-limit",
      "The maximum limit",
      "alice",
      "todos",
      { limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find("bob-default", "Another owner sees only their documents", "bob", "todos", undefined, {
      neverInBody: [...HIDDEN, '"alice"'],
    }),
    find(
      "anon-empty",
      "A caller without a read policy gets an empty page, not an error",
      "anon",
      "todos",
      undefined,
      { neverInBody: ["todo "] },
    ),
    find(
      "carol-admin",
      "A role with a policy without a filter sees every document, minus the hidden fields",
      "carol",
      "todos",
      { limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "service-all",
      "The service role sees every document and every field",
      "service",
      "todos",
      { limit: "10" },
    ),
    find(
      "service-hidden-collection",
      "The service role reaches a collection that is not exposed",
      "service",
      "hidden",
    ),
    find(
      "service-missing-collection",
      "The service role reading a collection that does not exist gets an empty page",
      "service",
      "ghosts",
    ),
    find(
      "sealed-alice",
      "A collection with only an insert policy reads as empty",
      "alice",
      "sealed",
      undefined,
      { neverInBody: ["s1", "s2"] },
    ),
    find(
      "trailing-slash",
      "A trailing slash on the path is ignored",
      "alice",
      "todos",
      { limit: "1" },
      { path: `${BASE}/todos/`, neverInBody: HIDDEN },
    ),
    find(
      "staff-alice",
      "A restrictive policy hides archived documents and a field rule hides the salary",
      "alice",
      "staff",
      { limit: "10" },
      { neverInBody: SALARY },
    ),
    find(
      "staff-service",
      "The service role sees archived documents and the salary",
      "service",
      "staff",
      { limit: "10" },
    ),
  ],
}

const filters: Group = {
  name: "filters",
  description:
    "Shorthand query parameters and the EJSON filter, alone and combined, over strings, numbers, dates, ObjectIds, arrays and nested paths.",
  specs: [
    find(
      "eq",
      "Shorthand equality",
      "alice",
      "todos",
      { status: "eq.active", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "ne",
      "Shorthand not equal",
      "alice",
      "todos",
      { status: "ne.active", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "range-same-path",
      "Two operators on one path",
      "alice",
      "todos",
      [
        ["priority", "gte.2"],
        ["priority", "lte.2"],
        ["limit", "10"],
      ],
      { neverInBody: HIDDEN },
    ),
    find(
      "two-paths",
      "Conditions on two paths",
      "alice",
      "todos",
      { status: "eq.active", priority: "gt.1", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "in-list",
      "A list of values",
      "alice",
      "todos",
      { status: "in.(done,blocked)", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "nin-list",
      "Values not in a list",
      "alice",
      "todos",
      { status: "nin.(done,blocked)", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "exists-false",
      "Missing fields",
      "alice",
      "todos",
      { dueAt: "exists.false", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "eq-null",
      "Equality with null matches null and missing",
      "alice",
      "todos",
      { dueAt: "eq.null", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "regex-literal",
      "A regular expression with options",
      "alice",
      "todos",
      { title: "regex./TODO 1/i", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "size",
      "An array of a given size",
      "alice",
      "todos",
      { tags: "size.2", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "quoted-string",
      "A quoted value stays a string",
      "alice",
      "todos",
      { title: 'eq."todo 3"', limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "date-ejson",
      "A date written as Extended JSON",
      "alice",
      "todos",
      { createdAt: 'gte.{"$date":"2026-01-06T00:00:00Z"}', limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "objectid-ejson",
      "An ObjectId written as Extended JSON",
      "alice",
      "todos",
      { _id: `eq.${JSON_OF(todoId(5))}` },
      { neverInBody: HIDDEN },
    ),
    find(
      "ejson-filter",
      "The filter parameter",
      "alice",
      "todos",
      { filter: '{"status":"active","priority":{"$gte":2}}', limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "ejson-or",
      "An $or filter",
      "alice",
      "todos",
      { filter: '{"$or":[{"status":"blocked"},{"priority":3}]}', limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "ejson-nested",
      "A path into a nested document",
      "alice",
      "todos",
      { filter: '{"meta.source":"web"}', limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "ejson-array-all",
      "An array containing all of several values",
      "alice",
      "todos",
      { filter: '{"tags":{"$all":["work","urgent"]}}', limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "ejson-in-objectids",
      "A list of ObjectIds",
      "alice",
      "todos",
      { filter: JSON_OF({ _id: { $in: [todoId(1), todoId(2), todoId(7)] } }), limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "filter-and-shorthand",
      "A filter and a shorthand condition are combined with and",
      "alice",
      "todos",
      { filter: '{"priority":{"$gte":2}}', status: "eq.active", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "no-match",
      "A filter that matches nothing",
      "alice",
      "todos",
      { status: "eq.nothing" },
      { neverInBody: HIDDEN },
    ),
    find(
      "numbers-eq-2",
      "The number 2 matches every numeric type that holds it",
      "alice",
      "numbers",
      { n: "eq.2", limit: "10" },
    ),
    find("numbers-gt-1", "Greater than 1 over mixed numeric types", "alice", "numbers", {
      n: "gt.1",
      limit: "10",
    }),
    find("numbers-eq-null", "Null equality over numbers, null and missing", "alice", "numbers", {
      n: "eq.null",
      limit: "10",
    }),
    find("numbers-nan", "Equality with NaN", "alice", "numbers", {
      filter: '{"n":{"$numberDouble":"NaN"}}',
      limit: "10",
    }),
    find("numbers-type-decimal", "A type test", "alice", "numbers", {
      filter: '{"n":{"$type":"decimal"}}',
      limit: "10",
    }),
    find("events-binary", "Equality with binary data", "alice", "events", {
      filter: '{"payload":{"$binary":{"base64":"AA==","subType":"00"}}}',
      limit: "10",
    }),
  ],
}

const sort: Group = {
  name: "sort",
  description:
    "Sorts over one or several keys in both directions, on strings, dates, numbers of every type, ObjectIds, binary data, timestamps, booleans and mixed or missing values. Every sort ends on _id ascending unless it names _id.",
  specs: [
    find(
      "todos-created-desc",
      "A descending sort; two documents share a timestamp and fall back to _id",
      "alice",
      "todos",
      { sort: "-createdAt", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "todos-two-keys",
      "Ascending then descending",
      "alice",
      "todos",
      { sort: "priority,-createdAt", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "todos-three-keys",
      "Three keys",
      "alice",
      "todos",
      { sort: "status,priority,-createdAt", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "todos-id-desc",
      "_id descending, without a second tie breaker",
      "alice",
      "todos",
      { sort: "-_id", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "todos-nested-path",
      "A nested path, where one document has no nested document",
      "carol",
      "todos",
      { sort: "meta.source,-_id", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "todos-due-asc",
      "Dates with null and missing values",
      "alice",
      "todos",
      { sort: "dueAt", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "numbers-asc",
      "Every numeric type, NaN, negative zero, infinities, null, missing and a string",
      "alice",
      "numbers",
      { sort: "n", limit: "10" },
    ),
    find("numbers-desc", "The same descending", "alice", "numbers", { sort: "-n", limit: "10" }),
    find("events-at-asc", "Dates, with a null, a string and equal values", "alice", "events", {
      sort: "at",
      limit: "10",
    }),
    find("events-kind-asc", "Strings compare by bytes, not by locale", "alice", "events", {
      sort: "kind",
      limit: "10",
    }),
    find("events-depth-asc", "Numbers of several types in a nested path", "alice", "events", {
      sort: "nested.depth",
      limit: "10",
    }),
    find(
      "events-payload-asc",
      "Binary data sorts by length, then subtype, then bytes",
      "alice",
      "events",
      { sort: "payload", limit: "10" },
    ),
    find("events-stamp-asc", "Timestamps", "alice", "events", { sort: "stamp", limit: "10" }),
  ],
}

const pagination: Group = {
  name: "pagination",
  description:
    "Keyset cursors: chains of pages over the awkward sort values, positions of documents that are gone, cursors of other queries and callers, malformed cursors, and skip.",
  specs: [
    ...chain(
      "numbers-asc",
      "alice",
      "numbers",
      { sort: "n", limit: "7" },
      3,
      "Numbers ascending by 7",
    ),
    ...chain(
      "numbers-desc",
      "alice",
      "numbers",
      { sort: "-n", limit: "7" },
      3,
      "Numbers descending by 7",
    ),
    ...chain(
      "events-at-desc",
      "alice",
      "events",
      { sort: "-at", limit: "7" },
      2,
      "Dates descending by 7",
    ),
    ...chain(
      "events-kind",
      "alice",
      "events",
      { sort: "kind", limit: "7" },
      2,
      "Strings ascending by 7",
    ),
    ...chain(
      "events-payload",
      "alice",
      "events",
      { sort: "payload", limit: "7" },
      2,
      "Binary data ascending by 7",
    ),
    ...chain(
      "todos-projected",
      "alice",
      "todos",
      { sort: "-createdAt", fields: "title", limit: "3" },
      3,
      "A projection that leaves out the sort field",
    ),
    find(
      "events-id-page-1",
      "The first page of events by _id, whose cursor the next cases forge positions of",
      "alice",
      "events",
      { sort: "_id", limit: "5" },
    ),
    find(
      "cursor-deleted-position",
      "A cursor at an _id no document has any more continues after that position",
      "alice",
      "events",
      { sort: "_id", limit: "5", after: (r) => r.forge("events-id-page-1", ["e035"]) },
    ),
    find(
      "cursor-past-end",
      "A cursor after the last document gives an empty last page",
      "alice",
      "events",
      { sort: "_id", limit: "5", after: (r) => r.forge("events-id-page-1", ["e99"]) },
    ),
    find(
      "cursor-before-start",
      "A cursor before the first document gives the first page",
      "alice",
      "events",
      { sort: "_id", limit: "5", after: (r) => r.forge("events-id-page-1", [""]) },
    ),
    find(
      "cursor-deleted-two-keys",
      "A two key position whose _id no document has",
      "alice",
      "events",
      { sort: "kind", limit: "5", after: (r) => r.forge("events-kind-page-1", ["beta", "e035"]) },
    ),
    find("cursor-null-position", "A position on a null sort value", "alice", "numbers", {
      sort: "n",
      limit: "5",
      after: (r) => r.forge("numbers-asc-page-1", [null, { $oid: "6f5000000000000000000008" }]),
    }),
    find("cursor-nan-position", "A position on NaN", "alice", "numbers", {
      sort: "n",
      limit: "5",
      after: (r) =>
        r.forge("numbers-asc-page-1", [
          { $numberDouble: "NaN" },
          { $oid: "6f5000000000000000000005" },
        ]),
    }),
    find(
      "cursor-negative-zero-position",
      "A position on negative zero, which equals zero",
      "alice",
      "numbers",
      {
        sort: "n",
        limit: "5",
        after: (r) =>
          r.forge("numbers-asc-page-1", [
            { $numberDouble: "-0.0" },
            { $oid: "6f5000000000000000000006" },
          ]),
      },
    ),
    find(
      "todos-priority-page-1",
      "The first page of todos by priority",
      "alice",
      "todos",
      { sort: "priority", limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find("cursor-other-sort", "A cursor of another sort", "alice", "todos", {
      sort: "-priority",
      limit: "3",
      after: after("todos-priority-page-1"),
    }),
    find("cursor-other-collection", "A cursor of another collection", "alice", "staff", {
      limit: "3",
      after: after("alice-limit-3"),
    }),
    find("cursor-other-filter", "A cursor of another filter", "alice", "todos", {
      status: "eq.done",
      limit: "3",
      after: after("alice-limit-3"),
    }),
    find(
      "service-id-page-1",
      "The service role reads seven documents, ending on one of bob's",
      "service",
      "todos",
      { sort: "_id", limit: "7" },
    ),
    find(
      "cursor-of-service-used-by-alice",
      "A cursor made for the service role does not widen what alice sees",
      "alice",
      "todos",
      { sort: "_id", limit: "7", after: after("service-id-page-1") },
      { neverInBody: [...HIDDEN, '"bob"'] },
    ),
    find("cursor-empty", "An empty cursor", "alice", "todos", { after: "" }),
    find("cursor-bad-characters", "A cursor with characters outside base64url", "alice", "todos", {
      after: "not*a*cursor",
    }),
    find("cursor-not-json", "A cursor that decodes to text that is not JSON", "alice", "todos", {
      after: (r) => r.raw("hello"),
    }),
    find("cursor-not-a-document", "A cursor that decodes to a JSON array", "alice", "todos", {
      after: (r) => r.raw("[1,2]"),
    }),
    find("cursor-missing-hash", "A cursor without a query hash", "alice", "todos", {
      after: (r) => r.raw('{"s":[1]}'),
    }),
    find("cursor-hash-not-text", "A cursor whose query hash is a number", "alice", "todos", {
      after: (r) => r.raw('{"s":[],"q":5}'),
    }),
    find("cursor-too-long", "A cursor longer than 4096 characters", "alice", "todos", {
      after: "a".repeat(4097),
    }),
    find(
      "cursor-wrong-value-count",
      "A cursor with more values than the sort has keys",
      "alice",
      "todos",
      { after: (r) => r.forge("alice-limit-3", [{ $oid: "6f1000000000000000000001" }, 2]) },
    ),
    find("cursor-array-value", "A cursor whose position holds an array", "alice", "todos", {
      after: (r) => r.forge("alice-limit-3", [[1]]),
    }),
    find(
      "cursor-operator-document",
      "A cursor whose position is a document with an operator",
      "alice",
      "todos",
      { after: (r) => r.raw(`{"s":[{"$gt":1}],"q":"${r.hash("alice-limit-3")}"}`) },
    ),
    find("cursor-twice", "Two cursors", "alice", "todos", [
      ["after", after("alice-limit-3")],
      ["after", after("alice-limit-3")],
    ]),
    find(
      "odd-regex-page-end",
      "A page that ends on a regular expression sort value still has a cursor",
      "alice",
      "odd",
      { sort: "v", w: "lt.6", limit: "2" },
    ),
    find(
      "odd-regex-next-page",
      "The next page cannot continue past a regular expression sort value and says so",
      "alice",
      "odd",
      { sort: "v", w: "lt.6", limit: "2", after: after("odd-regex-page-end") },
    ),
    find(
      "symbol-document",
      "A page holding BSON symbols returns them as strings, in order with the strings of equal value",
      "alice",
      "symbols",
      { sort: "v", limit: "10" },
    ),
    find(
      "symbol-default-order",
      "Without a sort the symbol documents come back in _id order, and a symbol reads as a plain string",
      "alice",
      "symbols",
    ),
    ...chain(
      "symbol-sort",
      "alice",
      "symbols",
      { sort: "v", limit: "1" },
      4,
      "A sort over symbols and strings, one document per page, so a cursor position is a symbol",
    ),
    ...chain(
      "symbol-sort-desc",
      "alice",
      "symbols",
      { sort: "-v", limit: "3" },
      2,
      "The same sort descending",
    ),
    find("symbol-eq", "A string filter matches a symbol of the same text", "alice", "symbols", {
      v: "eq.sym",
      sort: "_id",
    }),
    find("symbol-gt", "A comparison treats symbols as strings", "alice", "symbols", {
      v: "gt.sym",
      sort: "v",
    }),
    find(
      "symbol-forged-cursor",
      "A cursor whose position is the string a symbol was written as continues the same page chain",
      "alice",
      "symbols",
      { sort: "v", limit: "1", after: (r) => r.forge("symbol-sort-page-1", ["sym", "y1"]) },
    ),
    find(
      "skip",
      "skip instead of a cursor",
      "alice",
      "todos",
      { skip: "3", limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find(
      "skip-past-end",
      "skip beyond the last visible document",
      "alice",
      "todos",
      { skip: "15" },
      { neverInBody: HIDDEN },
    ),
    find("skip-and-after", "skip and a cursor together", "alice", "todos", {
      skip: "1",
      after: after("alice-limit-3"),
    }),
  ],
}

const fields: Group = {
  name: "fields",
  description: "Projections with fields, intersected with the fields the caller may read.",
  specs: [
    find(
      "include",
      "Inclusion keeps _id",
      "alice",
      "todos",
      { fields: "title,status", limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find(
      "exclude",
      "Exclusion",
      "alice",
      "todos",
      { fields: "-status,-tags", limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find(
      "nested-include",
      "A nested path",
      "alice",
      "todos",
      { fields: "title,meta.source", limit: "10" },
      { neverInBody: [...HIDDEN, ...SCORE] },
    ),
    find(
      "nested-exclude",
      "An excluded nested path",
      "alice",
      "todos",
      { fields: "-meta.source", limit: "10" },
      { neverInBody: [...HIDDEN, ...SCORE] },
    ),
    find(
      "without-id",
      "Without _id",
      "alice",
      "todos",
      { fields: "-_id,title", limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find(
      "hidden-include",
      "Asking for a hidden field",
      "alice",
      "todos",
      { fields: "title,internalNotes" },
      { neverInBody: HIDDEN },
    ),
    find(
      "hidden-nested-include",
      "Asking for a hidden nested path",
      "alice",
      "todos",
      { fields: "meta.score" },
      { neverInBody: SCORE },
    ),
    find("mixed", "Inclusion and exclusion mixed", "alice", "todos", { fields: "title,-status" }),
    find("empty-name", "An empty field name", "alice", "todos", { fields: ",title" }),
    find("service-hidden", "The service role may project a hidden field", "service", "todos", {
      fields: "internalNotes",
      limit: "2",
    }),
  ],
}

const count: Group = {
  name: "count",
  description: "page.total with count=exact, in the query or in Prefer, and what it counts.",
  specs: [
    find(
      "exact-alice",
      "The total counts only visible documents",
      "alice",
      "todos",
      { count: "exact", limit: "2" },
      { neverInBody: HIDDEN },
    ),
    find("exact-service", "The service total", "service", "todos", { count: "exact", limit: "2" }),
    find("exact-anon", "An empty page still reports a total of zero", "anon", "todos", {
      count: "exact",
    }),
    find(
      "exact-filter",
      "The total of a filtered page",
      "alice",
      "todos",
      { status: "eq.active", count: "exact", limit: "2" },
      { neverInBody: HIDDEN },
    ),
    find(
      "exact-page-2",
      "The total of a later page counts all matching documents, not the rest",
      "alice",
      "todos",
      { count: "exact", limit: "3", after: after("alice-limit-3") },
      { neverInBody: HIDDEN },
    ),
    find(
      "prefer-exact",
      "Prefer count=exact",
      "alice",
      "todos",
      { limit: "2" },
      { headers: { prefer: "count=exact" }, neverInBody: HIDDEN },
    ),
    find(
      "query-over-prefer",
      "The query parameter wins over Prefer",
      "alice",
      "todos",
      { count: "exact", limit: "2" },
      { headers: { prefer: "count=estimated" }, neverInBody: HIDDEN },
    ),
    find(
      "estimated",
      "count=estimated on a find",
      "alice",
      "todos",
      { count: "estimated", limit: "2" },
      { neverInBody: HIDDEN },
    ),
    find("invalid", "An unknown count mode", "alice", "todos", { count: "all" }),
  ],
}

const dls: Group = {
  name: "dls",
  description:
    "The document and field level security corpus of the read path: what a caller must never see, learn or probe through filters, sorts, projections, counts and cursors, and the service role that bypasses all of it. Cases name text no body may contain.",
  specs: [
    find(
      "filter-other-owner",
      "Asking for another owner's documents",
      "alice",
      "todos",
      { ownerId: "eq.bob" },
      { neverInBody: [...HIDDEN, '"bob"'] },
    ),
    find(
      "or-with-other-owner",
      "An $or that includes another owner's documents",
      "alice",
      "todos",
      { filter: '{"$or":[{"ownerId":"bob"},{"ownerId":"alice"}]}', limit: "10" },
      { neverInBody: [...HIDDEN, '"bob"'] },
    ),
    find(
      "not-equal-owner",
      "A negated condition cannot widen the policy",
      "alice",
      "todos",
      { filter: '{"ownerId":{"$ne":"alice"}}' },
      { neverInBody: [...HIDDEN, '"bob"'] },
    ),
    find(
      "hidden-eq",
      "Equality on a hidden field",
      "alice",
      "todos",
      { internalNotes: "eq.secret-1" },
      { neverInBody: HIDDEN },
    ),
    find(
      "hidden-nested-gt",
      "A range on a hidden nested path",
      "alice",
      "todos",
      { "meta.score": "gt.2" },
      { neverInBody: SCORE },
    ),
    find(
      "hidden-inside-or",
      "A hidden field inside an $or",
      "alice",
      "todos",
      { filter: '{"$or":[{"status":"done"},{"internalNotes":"secret-1"}]}' },
      { neverInBody: HIDDEN },
    ),
    find(
      "hidden-parent-equality",
      "Equality on a nested document that contains a hidden field",
      "alice",
      "todos",
      { filter: '{"meta":{"source":"web","score":1.5}}' },
      { neverInBody: SCORE },
    ),
    find(
      "hidden-sort",
      "A sort on a hidden field",
      "alice",
      "todos",
      { sort: "internalNotes" },
      { neverInBody: HIDDEN },
    ),
    find(
      "hidden-nested-sort",
      "A sort on a hidden nested path",
      "alice",
      "todos",
      { sort: "meta.score" },
      { neverInBody: SCORE },
    ),
    find(
      "hidden-expr",
      "$expr reading a hidden field",
      "alice",
      "todos",
      { filter: '{"$expr":{"$eq":["$internalNotes","secret-1"]}}' },
      { neverInBody: HIDDEN },
    ),
    find(
      "hidden-text",
      "A text search over a hidden field",
      "alice",
      "todos",
      { filter: '{"$text":{"$search":"secret"}}' },
      { neverInBody: HIDDEN },
    ),
    find(
      "where-javascript",
      "$where",
      "alice",
      "todos",
      { filter: '{"$where":"this.internalNotes == \'secret-1\'"}' },
      { neverInBody: HIDDEN },
    ),
    find("service-hidden-eq", "The service role may filter on a hidden field", "service", "todos", {
      internalNotes: "eq.secret-1",
    }),
    find(
      "admin-hidden-score-sort",
      "A role that may read meta.score may sort by it",
      "carol",
      "todos",
      { sort: "meta.score", limit: "10" },
      { neverInBody: HIDDEN },
    ),
    find(
      "admin-hidden-notes",
      "A role that may not read internalNotes may not filter on it",
      "carol",
      "todos",
      { internalNotes: "eq.secret-1" },
      { neverInBody: HIDDEN },
    ),
    find(
      "context-alice",
      "A policy built on a context lookup: alice belongs to two projects",
      "alice",
      "tasks",
      { limit: "10" },
    ),
    find("context-bob", "bob belongs to one project", "bob", "tasks", { limit: "10" }),
    find(
      "context-carol",
      "carol belongs to none",
      "carol",
      "tasks",
      { limit: "10" },
      { neverInBody: ["task "] },
    ),
    find("context-service", "The service role sees every task", "service", "tasks", {
      limit: "10",
    }),
    find(
      "context-other-project",
      "Asking for a project the caller is not in",
      "alice",
      "tasks",
      { projectId: `eq.${JSON_OF({ $oid: "6f4000000000000000000003" })}` },
      { neverInBody: ["task 5", "task 6"] },
    ),
    find(
      "staff-restrictive",
      "A restrictive policy narrows every permissive one",
      "carol",
      "staff",
      { limit: "10" },
      { neverInBody: ['"archived":true', ...SALARY] },
    ),
    find(
      "staff-archived-filter",
      "Asking for the documents the restrictive policy hides",
      "alice",
      "staff",
      { archived: "eq.true" },
      { neverInBody: ["Cy", "Fay"] },
    ),
    find(
      "staff-salary-filter",
      "Filtering on a field hidden by a field rule",
      "alice",
      "staff",
      { salary: "gt.100" },
      { neverInBody: SALARY },
    ),
  ],
}

const limits: Group = {
  name: "limits",
  description:
    "The page size and skip bounds of the fixture's configuration: a default of 5, a maximum of 10 and a skip of at most 20.",
  specs: [
    find(
      "limit-1",
      "The smallest limit",
      "alice",
      "todos",
      { limit: "1" },
      { neverInBody: HIDDEN },
    ),
    find("limit-above-max", "A limit above the maximum", "alice", "todos", { limit: "11" }),
    find("limit-zero", "A limit of zero", "alice", "todos", { limit: "0" }),
    find("limit-fraction", "A fractional limit", "alice", "todos", { limit: "1.5" }),
    find("limit-text", "A limit that is not a number", "alice", "todos", { limit: "ten" }),
    find("limit-huge", "A limit beyond the safe integers", "alice", "todos", {
      limit: "99999999999999999999",
    }),
    find("limit-twice", "limit given twice", "alice", "todos", [
      ["limit", "2"],
      ["limit", "3"],
    ]),
    find("skip-max", "The largest skip", "alice", "todos", { skip: "20" }),
    find("skip-above-max", "A skip above the maximum", "alice", "todos", { skip: "21" }),
    find("skip-negative", "A negative skip", "alice", "todos", { skip: "-1" }),
    find("skip-text", "A skip that is not a number", "alice", "todos", { skip: "some" }),
  ],
}

const errors: Group = {
  name: "errors",
  description:
    "Every error class of the route as Problem Details: addressing, filters, shorthand, sorts, credentials, roles and methods. The detail texts are part of the pinned bytes.",
  specs: [
    find("unknown-collection", "A collection that does not exist", "alice", "nothing"),
    find("not-exposed", "A collection that exists but is not exposed", "alice", "hidden"),
    find(
      "collection-name-operator",
      "A collection name that is a MongoDB operator",
      "alice",
      "$cmd",
    ),
    find("collection-name-system", "A system collection name", "alice", "system.users"),
    find("outside-base-path", "A path outside the base path", "alice", "todos", undefined, {
      path: "/other/todos",
    }),
    find(
      "bad-percent-encoding",
      "A path that is not validly percent encoded",
      "alice",
      "todos",
      undefined,
      { path: "/rest/v1/%E0%A4%A" },
    ),
    find("method-not-allowed", "A method the path does not allow", "alice", "todos", undefined, {
      method: "PUT",
    }),
    find("filter-malformed", "A filter that is not JSON", "alice", "todos", { filter: "{bad" }),
    find("filter-not-document", "A filter that is not a document", "alice", "todos", {
      filter: "[1,2]",
    }),
    find("filter-twice", "filter given twice", "alice", "todos", [
      ["filter", "{}"],
      ["filter", "{}"],
    ]),
    find("filter-expr", "$expr is refused", "alice", "todos", {
      filter: '{"$expr":{"$eq":[1,1]}}',
    }),
    find("filter-function", "$expr wrapping $function is refused", "alice", "todos", {
      filter: '{"$expr":{"$function":{"body":"function(){return true}","args":[],"lang":"js"}}}',
    }),
    find("filter-unknown-operator", "An operator that does not exist", "alice", "todos", {
      filter: '{"status":{"$bogus":1}}',
    }),
    find("filter-too-deep", "A filter nested past the depth limit", "alice", "todos", {
      filter: `${'{"$and":['.repeat(20)}{}${"]}".repeat(20)}`,
    }),
    find("filter-in-too-long", "An $in list past its limit", "alice", "todos", {
      filter: `{"priority":{"$in":[${Array.from({ length: 1001 }, () => "1").join(",")}]}}`,
    }),
    find(
      "filter-bad-regex",
      "A regular expression that does not compile",
      "alice",
      "todos",
      { title: "regex.(" },
      { engineDetail: true },
    ),
    find("shorthand-no-operator", "A shorthand value without an operator", "alice", "todos", {
      status: "active",
    }),
    find("shorthand-unknown-operator", "An unknown shorthand operator", "alice", "todos", {
      status: "like.act",
    }),
    find("shorthand-operator-twice", "One operator twice on a path", "alice", "todos", [
      ["priority", "gt.1"],
      ["priority", "gt.2"],
    ]),
    find("shorthand-unquoted-list", "A list without parentheses", "alice", "todos", {
      status: "in.a,b",
    }),
    find("shorthand-bad-quote", "A quoted value that never closes", "alice", "todos", {
      title: 'eq."open',
    }),
    find(
      "shorthand-document-value",
      "A shorthand value that is a plain document",
      "alice",
      "todos",
      { meta: 'eq.{"source":"web"}' },
    ),
    find(
      "shorthand-bad-exists",
      "exists with something other than true or false",
      "alice",
      "todos",
      { dueAt: "exists.maybe" },
    ),
    find("shorthand-where", "where is reserved for writes", "alice", "todos", { where: "{}" }),
    find("shorthand-upsert", "upsert is reserved for writes", "alice", "todos", { upsert: "true" }),
    find("sort-empty-key", "A sort with an empty key", "alice", "todos", { sort: ",title" }),
    find("sort-repeated", "A sort that repeats a path", "alice", "todos", { sort: "title,-title" }),
    find("sort-too-many", "More sort keys than the limit of 8", "alice", "todos", {
      sort: "a,b,c,d,e,f,g,h,i",
    }),
    find("sort-twice", "sort given twice", "alice", "todos", [
      ["sort", "title"],
      ["sort", "-title"],
    ]),
    find("missing-key", "No credentials at all", "none", "todos"),
    find("unknown-key", "An API key nobody issued", "unknown-key", "todos"),
    find("not-bearer", "An Authorization header that is not Bearer", "anon", "todos", undefined, {
      headers: { authorization: "Basic YWxpY2U6cGFzcw==" },
    }),
    find("expired-token", "An expired token", "expired", "todos"),
    find("tampered-token", "A token whose signature is wrong", "tampered", "todos"),
    find("wrong-issuer", "A token of another issuer", "wrong-issuer", "todos"),
    find(
      "secret-key-mismatch",
      "A secret key as bearer that differs from the apikey header",
      "anon",
      "todos",
      undefined,
      { headers: { authorization: "Bearer canopy_sk_conformance" } },
    ),
    find(
      "secret-key-bearer",
      "A secret key sent only as bearer is the service role",
      "service-bearer",
      "todos",
      { limit: "2" },
    ),
    find("service-role-claim", "A token that claims the service role", "service-claim", "todos"),
    find(
      "explain-header-service",
      "X-Canopy-Explain is ignored: the explanation is POST /{collection}/_explain",
      "service",
      "todos",
      { limit: "2" },
      { headers: { "x-canopy-explain": "true" } },
    ),
    find(
      "explain-header-owner",
      "X-Canopy-Explain reveals nothing to a caller DLS applies to",
      "alice",
      "todos",
      { limit: "2" },
      { headers: { "x-canopy-explain": "true" } },
    ),
    find(
      "minted-request-id-success",
      "Without X-Request-Id the server mints one",
      "alice",
      "todos",
      { limit: "1" },
      { minted: true, neverInBody: HIDDEN },
    ),
    find(
      "minted-request-id-error",
      "A minted request id also appears in a problem",
      "alice",
      "nothing",
      undefined,
      { minted: true },
    ),
    find(
      "unsafe-request-id",
      "A request id with unsafe characters is replaced",
      "alice",
      "nothing",
      undefined,
      { minted: true, headers: { "x-request-id": "bad id with spaces" } },
    ),
    find("given-request-id", "A safe request id is echoed", "alice", "nothing", undefined, {
      headers: { "x-request-id": "client-chosen.id:42" },
    }),
  ],
}

const encoding: Group = {
  name: "encoding",
  description:
    "Relaxed EJSON (application/json) and canonical EJSON (application/ejson) responses, where the numeric types, dates and binary data differ.",
  specs: [
    find("numbers-relaxed", "Numbers in relaxed Extended JSON", "alice", "numbers", {
      sort: "n",
      limit: "10",
    }),
    find(
      "numbers-canonical",
      "The same page in canonical Extended JSON, which keeps every numeric type",
      "alice",
      "numbers",
      { sort: "n", limit: "10" },
      { headers: { accept: "application/ejson" } },
    ),
    find(
      "symbols-relaxed",
      "BSON symbols as strings in relaxed Extended JSON",
      "alice",
      "symbols",
      { sort: "v", limit: "10" },
    ),
    find(
      "symbols-canonical",
      "The same page in canonical Extended JSON, where a symbol is also a plain string",
      "alice",
      "symbols",
      { sort: "v", limit: "10" },
      { headers: { accept: "application/ejson" } },
    ),
    find(
      "events-relaxed",
      "Dates, binary data and timestamps in relaxed Extended JSON",
      "alice",
      "events",
      { sort: "_id", limit: "10" },
    ),
    find(
      "events-canonical",
      "The same page in canonical Extended JSON",
      "alice",
      "events",
      { sort: "_id", limit: "10" },
      { headers: { accept: "application/ejson" } },
    ),
    find(
      "todos-canonical",
      "A todo page in canonical Extended JSON",
      "alice",
      "todos",
      { limit: "2" },
      { headers: { accept: "application/ejson" }, neverInBody: HIDDEN },
    ),
    find(
      "accept-list",
      "Canonical wins when listed anywhere in Accept",
      "alice",
      "todos",
      { limit: "1" },
      { headers: { accept: "text/html, application/ejson;q=0.1" }, neverInBody: HIDDEN },
    ),
    find(
      "accept-any",
      "A wildcard Accept gets relaxed",
      "alice",
      "todos",
      { limit: "1" },
      { headers: { accept: "*/*" }, neverInBody: HIDDEN },
    ),
    find(
      "error-canonical",
      "Problem Details do not depend on Accept",
      "alice",
      "nothing",
      undefined,
      { headers: { accept: "application/ejson" } },
    ),
  ],
}

const conditional: Group = {
  name: "conditional",
  description:
    "ETag validators over the page content (not its cluster time) and If-None-Match, which answers 304.",
  specs: [
    find(
      "first",
      "A page carries a weak ETag",
      "alice",
      "todos",
      { sort: "_id", limit: "3" },
      { neverInBody: HIDDEN },
    ),
    find(
      "match",
      "The same page with its ETag answers 304 and no body",
      "alice",
      "todos",
      { sort: "_id", limit: "3" },
      { headers: { "if-none-match": (r) => r.etag("first") }, neverInBody: HIDDEN },
    ),
    find(
      "match-in-list",
      "A list of validators that includes it",
      "alice",
      "todos",
      { sort: "_id", limit: "3" },
      { headers: { "if-none-match": (r) => `"x", ${r.etag("first")}` }, neverInBody: HIDDEN },
    ),
    find(
      "stale",
      "A validator of other content gets the page",
      "alice",
      "todos",
      { sort: "_id", limit: "3" },
      { headers: { "if-none-match": 'W/"00000000000000000000000000000000"' }, neverInBody: HIDDEN },
    ),
    find(
      "canonical-encoding",
      "The same page in canonical Extended JSON has another validator",
      "alice",
      "todos",
      { sort: "_id", limit: "3" },
      {
        headers: { accept: "application/ejson", "if-none-match": (r) => r.etag("first") },
        neverInBody: HIDDEN,
      },
    ),
    find(
      "other-caller",
      "Another caller does not share the validator",
      "bob",
      "todos",
      { sort: "_id", limit: "3" },
      { headers: { "if-none-match": (r) => r.etag("first") }, neverInBody: HIDDEN },
    ),
    find(
      "star",
      "If-None-Match with * is not a validator match",
      "alice",
      "todos",
      { sort: "_id", limit: "3" },
      { headers: { "if-none-match": "*" }, neverInBody: HIDDEN },
    ),
    find(
      "error-has-no-etag",
      "An error has no validator even when one is sent",
      "alice",
      "nothing",
      undefined,
      { headers: { "if-none-match": (r) => r.etag("first") } },
    ),
  ],
}

export const GROUPS: readonly Group[] = [
  pages,
  filters,
  sort,
  pagination,
  fields,
  count,
  dls,
  limits,
  errors,
  encoding,
  conditional,
]
