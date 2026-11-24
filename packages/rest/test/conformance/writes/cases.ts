/** One request of a case: what is sent, by whom. */
export interface Step {
  readonly method: string
  /** The path below the base path, with its query, exactly as sent. */
  readonly target: string
  readonly caller: string
  readonly headers?: Readonly<Record<string, string>>
  /** The body, sent as the JSON of this value, or as is when it is a string and `raw` is set. */
  readonly body?: unknown
  readonly raw?: boolean
}

/** One case: requests sent one after the other on a freshly seeded database, and what to observe after. */
interface WriteSpec {
  readonly id: string
  readonly title: string
  readonly steps: readonly Step[]
  /** The collections whose documents are recorded after the last step. */
  readonly observe: readonly string[]
  /** Whether the idempotency records are recorded after the last step. */
  readonly records?: boolean
}

/** A group of cases, written to one file. */
export interface WriteGroup {
  readonly name: string
  readonly description: string
  readonly specs: readonly WriteSpec[]
}

const JSON_TYPE = { "content-type": "application/json" }

function step(
  method: string,
  target: string,
  caller: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Step {
  return {
    method,
    target,
    caller,
    headers: body === undefined ? headers : { ...JSON_TYPE, ...headers },
    ...(body === undefined ? {} : { body }),
  }
}

function raw(method: string, target: string, caller: string, body: string, type: string): Step {
  return { method, target, caller, headers: { "content-type": type }, body, raw: true }
}

function one(
  id: string,
  title: string,
  request: Step,
  observe: readonly string[],
  records = false,
): WriteSpec {
  return { id, title, steps: [request], observe, ...(records ? { records } : {}) }
}

const insert: WriteGroup = {
  name: "insert",
  description:
    "POST /{coll}: inserts with check clauses, field rules, validators, unique indexes and the refusals of the route",
  specs: [
    one(
      "insert-own",
      "An owner inserts a document the check admits",
      step("POST", "/notes", "alice", { _id: "n9", ownerId: "alice", title: "new", done: false }),
      ["notes"],
    ),
    one(
      "insert-other-owner",
      "A document the check refuses is not written",
      step("POST", "/notes", "alice", { _id: "n9", ownerId: "bob", title: "new" }),
      ["notes"],
    ),
    one(
      "insert-anon",
      "A caller without a grant is refused",
      step("POST", "/notes", "anon", { _id: "n9", ownerId: "alice" }),
      ["notes"],
    ),
    one(
      "insert-denied-field",
      "A field the caller may not write is refused",
      step("POST", "/notes", "alice", { _id: "n9", ownerId: "alice", secret: "x" }),
      ["notes"],
    ),
    one(
      "insert-admin-field",
      "Field rules are per role",
      step("POST", "/notes", "carol", { _id: "n9", ownerId: "carol", n: 9 }),
      ["notes"],
    ),
    one(
      "insert-existing-id",
      "An _id that exists is a duplicate key",
      step("POST", "/notes", "alice", { _id: "n1", ownerId: "alice" }),
      ["notes"],
    ),
    one(
      "insert-unique-index",
      "A unique index refuses the document",
      step("POST", "/people", "alice", { _id: "u3", email: "ann@example.test" }),
      ["people"],
    ),
    one(
      "insert-validator",
      "The collection validator refuses the document",
      step("POST", "/counters", "alice", { _id: 3, n: "three" }),
      ["counters"],
    ),
    one(
      "insert-number-id",
      "A numeric _id is the Location of a collection of numbers",
      step("POST", "/counters", "alice", { _id: 3, n: 3 }),
      ["counters"],
    ),
    one(
      "insert-ejson",
      "An EJSON body keeps its types",
      raw(
        "POST",
        "/notes",
        "alice",
        '{"_id":"n9","ownerId":"alice","when":{"$date":"2026-05-01T00:00:00Z"},"big":{"$numberLong":"9007199254740993"}}',
        "application/ejson",
      ),
      ["notes"],
    ),
    one(
      "insert-unreadable",
      "A document the caller may not read comes back as null",
      step("POST", "/inbox", "alice", { _id: "m1", text: "hello" }),
      ["inbox"],
    ),
    one(
      "insert-hidden-collection",
      "A collection that is not exposed",
      step("POST", "/hidden", "alice", { _id: "h2" }),
      ["hidden"],
    ),
    one(
      "insert-service",
      "service bypasses the policies and the field rules",
      step("POST", "/notes", "service", { _id: "n9", ownerId: "nobody", secret: "s" }),
      ["notes"],
    ),
    one(
      "insert-minimal",
      "return=minimal answers 204 with the cluster time",
      step(
        "POST",
        "/notes",
        "alice",
        { _id: "n9", ownerId: "alice" },
        {
          prefer: "return=minimal",
        },
      ),
      ["notes"],
    ),
    one(
      "insert-many",
      "An array inserts every document",
      step("POST", "/notes", "alice", [
        { _id: "n8", ownerId: "alice" },
        { _id: "n9", ownerId: "alice", title: "nine" },
      ]),
      ["notes"],
    ),
    one(
      "insert-many-one-refused",
      "One refused document refuses all of them",
      step("POST", "/notes", "alice", [
        { _id: "n8", ownerId: "alice" },
        { _id: "n9", ownerId: "bob" },
      ]),
      ["notes"],
    ),
    one(
      "insert-not-document",
      "A body that is neither a document nor a list",
      step("POST", "/notes", "alice", 5),
      ["notes"],
    ),
    one(
      "insert-malformed",
      "A body that is not JSON",
      raw("POST", "/notes", "alice", "{", "application/json"),
      [],
    ),
    one(
      "insert-text",
      "A media type the route does not take",
      raw("POST", "/notes", "alice", "hello", "text/plain"),
      [],
    ),
    one("insert-no-body", "A request without a body", step("POST", "/notes", "alice"), []),
    one(
      "insert-parameter",
      "A query parameter on an insert",
      step("POST", "/notes?select=title", "alice", { _id: "n9", ownerId: "alice" }),
      ["notes"],
    ),
    one(
      "insert-expired",
      "An expired token",
      step("POST", "/notes", "expired", { _id: "n9", ownerId: "alice" }),
      ["notes"],
    ),
  ],
}

const update: WriteGroup = {
  name: "update",
  description:
    "PATCH /{coll}/{id}: updates with operators or a merge patch, compare and set, check clauses, immutable fields and the refusals",
  specs: [
    one(
      "update-set",
      "An owner sets fields of an own document",
      step("PATCH", "/notes/n1", "alice", { $set: { title: "changed", done: true } }),
      ["notes"],
    ),
    one(
      "update-merge-patch",
      "A merge patch sets and removes fields",
      raw(
        "PATCH",
        "/notes/n1",
        "alice",
        '{"title":"merged","done":null,"extra":{"a":1}}',
        "application/merge-patch+json",
      ),
      ["notes"],
    ),
    one(
      "update-operators",
      "Several operators in one update",
      step("PATCH", "/notes/n2", "alice", {
        $set: { title: "x" },
        $push: { tags: "c" },
        $unset: { done: "" },
      }),
      ["notes"],
    ),
    one(
      "update-other-owner",
      "A document of another owner is not found",
      step("PATCH", "/notes/n5", "alice", { $set: { title: "mine" } }),
      ["notes"],
    ),
    one(
      "update-check",
      "An update the check refuses is rolled back",
      step("PATCH", "/notes/n1", "alice", { $set: { ownerId: "bob" } }),
      ["notes"],
    ),
    one(
      "update-immutable",
      "An immutable field may not change",
      step("PATCH", "/notes/n1", "alice", {
        $set: { createdAt: { $date: "2027-01-01T00:00:00Z" } },
      }),
      ["notes"],
    ),
    one(
      "update-immutable-same",
      "An immutable field may not be named in an update, even with its own value",
      step("PATCH", "/notes/n1", "alice", {
        $set: { createdAt: { $date: "2026-01-01T00:00:00Z" }, title: "same" },
      }),
      ["notes"],
    ),
    one(
      "update-denied-field",
      "A field the caller may not write",
      step("PATCH", "/notes/n1", "alice", { $set: { secret: "x" } }),
      ["notes"],
    ),
    one(
      "update-admin",
      "A role with an update grant on every document",
      step("PATCH", "/notes/n5", "carol", { $inc: { n: 1 } }),
      ["notes"],
    ),
    one(
      "update-where-conflict",
      "A failed compare and set on a visible document is a conflict",
      step("PATCH", `/notes/n1?where=${encodeURIComponent('{"done":true}')}`, "alice", {
        $set: { title: "cas" },
      }),
      ["notes"],
    ),
    one(
      "update-where-match",
      "A compare and set that holds",
      step("PATCH", `/notes/n2?where=${encodeURIComponent('{"done":true}')}`, "alice", {
        $set: { title: "cas" },
      }),
      ["notes"],
    ),
    one(
      "update-not-found",
      "A missing document",
      step("PATCH", "/notes/n99", "alice", { $set: { title: "x" } }),
      ["notes"],
    ),
    one(
      "update-no-change",
      "An update that changes nothing",
      step("PATCH", "/notes/n1", "alice", { $set: { title: "note 1" } }),
      ["notes"],
    ),
    one(
      "update-not-operators",
      "A body that is not an update",
      step("PATCH", "/notes/n1", "alice", { title: "plain" }),
      ["notes"],
    ),
    one(
      "update-unknown-operator",
      "An operator Canopy does not take",
      step("PATCH", "/notes/n1", "alice", { $where: "1" }),
      ["notes"],
    ),
    one(
      "update-id-change",
      "An update may not change _id",
      step("PATCH", "/notes/n1", "alice", { $set: { _id: "other" } }),
      ["notes"],
    ),
    one(
      "update-restrictive",
      "A restrictive policy hides a locked post from updates",
      step("PATCH", "/posts/p4", "alice", { $set: { title: "unlock" } }),
      ["posts"],
    ),
    one(
      "update-check-values",
      "A check on values",
      step("PATCH", "/posts/p1", "alice", { $set: { status: "deleted" } }),
      ["posts"],
    ),
    one(
      "update-number-id",
      "A numeric _id in the path",
      step("PATCH", "/counters/2", "alice", { $inc: { n: 5 } }),
      ["counters"],
    ),
    one(
      "update-validator",
      "The validator refuses the result",
      step("PATCH", "/counters/1", "alice", { $set: { n: "one" } }),
      ["counters"],
    ),
    one(
      "update-unique-index",
      "A unique index refuses the result",
      step("PATCH", "/people/u2", "alice", { $set: { email: "ann@example.test" } }),
      ["people"],
    ),
    one(
      "update-collation",
      "A default collation finds the document",
      step("PATCH", "/folded/key", "alice", { $set: { v: 2 } }),
      ["folded"],
    ),
    one(
      "update-minimal",
      "return=minimal",
      step(
        "PATCH",
        "/notes/n1",
        "alice",
        { $set: { title: "min" } },
        {
          prefer: "return=minimal",
        },
      ),
      ["notes"],
    ),
    one(
      "update-unknown-parameter",
      "Only where is taken",
      step("PATCH", "/notes/n1?limit=1", "alice", { $set: { title: "x" } }),
      ["notes"],
    ),
  ],
}

const replace: WriteGroup = {
  name: "replace",
  description: "PUT /{coll}/{id}: replacements, upserts and their refusals",
  specs: [
    one(
      "replace-own",
      "A replacement the check and the immutable fields admit",
      step("PUT", "/posts/p1", "alice", {
        status: "published",
        title: "replaced",
        authorId: "alice",
      }),
      ["posts"],
    ),
    one(
      "replace-field-rules",
      "Write field rules refuse whole document replacements",
      step("PUT", "/notes/n1", "alice", {
        ownerId: "alice",
        title: "replaced",
        createdAt: { $date: "2026-01-01T00:00:00Z" },
      }),
      ["notes"],
    ),
    one(
      "replace-check",
      "A replacement the check refuses",
      step("PUT", "/posts/p1", "alice", { status: "deleted", authorId: "alice" }),
      ["posts"],
    ),
    one(
      "replace-immutable-fields",
      "Immutable fields refuse whole document replacements",
      step("PUT", "/frozen/f1", "alice", { kind: "a", v: 2 }),
      ["frozen"],
    ),
    one(
      "update-frozen",
      "An update that leaves the immutable field alone",
      step("PATCH", "/frozen/f1", "alice", { $set: { v: 2 } }),
      ["frozen"],
    ),
    one(
      "update-frozen-immutable",
      "An update of the immutable field",
      step("PATCH", "/frozen/f1", "alice", { $set: { kind: "b" } }),
      ["frozen"],
    ),
    one(
      "replace-upsert",
      "An upsert inserts a missing document",
      step("PUT", "/posts/p9?upsert=true", "alice", { status: "draft", title: "nine" }),
      ["posts"],
    ),
    one(
      "replace-upsert-existing",
      "An upsert of an existing document replaces it",
      step("PUT", "/posts/p1?upsert=true", "alice", {
        status: "published",
        title: "one",
        authorId: "alice",
      }),
      ["posts"],
    ),
    one(
      "replace-upsert-check",
      "An upsert the insert check refuses",
      step("PUT", "/posts/p9?upsert=true", "alice", { status: "deleted" }),
      ["posts"],
    ),
    one(
      "replace-missing",
      "Without upsert a missing document is not found",
      step("PUT", "/posts/p9", "alice", { status: "draft" }),
      ["posts"],
    ),
    one(
      "replace-upsert-bad",
      "upsert takes true or false",
      step("PUT", "/posts/p9?upsert=yes", "alice", { status: "draft" }),
      ["posts"],
    ),
    one(
      "replace-where-conflict",
      "A failed compare and set",
      step("PUT", `/posts/p1?where=${encodeURIComponent('{"status":"published"}')}`, "alice", {
        status: "draft",
        title: "x",
        authorId: "alice",
      }),
      ["posts"],
    ),
    one(
      "replace-id-mismatch",
      "A replacement with another _id",
      step("PUT", "/posts/p1", "alice", { _id: "p2", status: "draft", authorId: "alice" }),
      ["posts"],
    ),
    one(
      "replace-operators",
      "A replacement may not hold operators",
      step("PUT", "/posts/p1", "alice", { $set: { status: "draft" } }),
      ["posts"],
    ),
    one(
      "replace-locked",
      "A restrictive policy hides the document",
      step("PUT", "/posts/p4", "alice", { status: "draft", authorId: "alice" }),
      ["posts"],
    ),
    one(
      "replace-service",
      "service bypasses the check and the immutable fields",
      step("PUT", "/posts/p1", "service", { status: "gone" }),
      ["posts"],
    ),
  ],
}

const remove: WriteGroup = {
  name: "delete",
  description: "DELETE /{coll}/{id}: deletes, compare and set, and their refusals",
  specs: [
    one("delete-own", "An owner deletes an own document", step("DELETE", "/notes/n1", "alice"), [
      "notes",
    ]),
    one("delete-other-owner", "A document of another owner", step("DELETE", "/notes/n5", "alice"), [
      "notes",
    ]),
    one("delete-missing", "A missing document", step("DELETE", "/notes/n99", "alice"), ["notes"]),
    one(
      "delete-where-conflict",
      "A failed compare and set",
      step("DELETE", `/notes/n1?where=${encodeURIComponent('{"done":true}')}`, "alice"),
      ["notes"],
    ),
    one(
      "delete-admin",
      "A role allowed to delete every document",
      step("DELETE", "/notes/n5", "carol"),
      ["notes"],
    ),
    one(
      "delete-no-grant",
      "A caller without a delete grant",
      step("DELETE", "/posts/p1", "alice"),
      ["posts"],
    ),
    one(
      "delete-minimal",
      "return=minimal",
      step("DELETE", "/notes/n2", "alice", undefined, { prefer: "return=minimal" }),
      ["notes"],
    ),
    one("delete-number-id", "A numeric _id", step("DELETE", "/counters/1", "alice"), ["counters"]),
  ],
}

const bulk: WriteGroup = {
  name: "bulk",
  description: "PATCH and DELETE /{coll} with Prefer: bulk=true: writes to many documents",
  specs: [
    one(
      "bulk-update",
      "An update of every own document the filter matches",
      step(
        "PATCH",
        `/notes?filter=${encodeURIComponent('{"done":false}')}`,
        "alice",
        { $set: { title: "bulk" } },
        {
          prefer: "bulk=true",
        },
      ),
      ["notes"],
    ),
    one(
      "bulk-update-shorthand",
      "A shorthand filter",
      step("PATCH", "/notes?done=eq.true", "alice", { $inc: { n: 10 } }, { prefer: "bulk=true" }),
      ["notes"],
    ),
    one(
      "bulk-update-without-prefer",
      "A bulk write needs Prefer: bulk=true",
      step("PATCH", `/notes?filter=${encodeURIComponent('{"done":false}')}`, "alice", {
        $set: { title: "bulk" },
      }),
      ["notes"],
    ),
    one(
      "bulk-update-no-filter",
      "A bulk write needs a filter",
      step("PATCH", "/notes", "alice", { $set: { title: "all" } }, { prefer: "bulk=true" }),
      ["notes"],
    ),
    one(
      "bulk-update-check",
      "A bulk update the check refuses is rolled back whole",
      step(
        "PATCH",
        `/notes?filter=${encodeURIComponent('{"done":false}')}`,
        "alice",
        { $set: { ownerId: "bob" } },
        {
          prefer: "bulk=true",
        },
      ),
      ["notes"],
    ),
    one(
      "bulk-update-limit-param",
      "limit does not apply to bulk writes",
      step(
        "PATCH",
        "/notes?done=eq.true&limit=1",
        "alice",
        { $set: { title: "x" } },
        { prefer: "bulk=true" },
      ),
      ["notes"],
    ),
    one(
      "bulk-delete",
      "A delete of every own document the filter matches",
      step("DELETE", `/notes?filter=${encodeURIComponent('{"done":true}')}`, "alice", undefined, {
        prefer: "bulk=true",
      }),
      ["notes"],
    ),
    one(
      "bulk-delete-admin",
      "A role allowed to delete every document",
      step("DELETE", "/notes?done=eq.true", "carol", undefined, { prefer: "bulk=true" }),
      ["notes"],
    ),
  ],
}

const batch: WriteGroup = {
  name: "batch",
  description: "POST /_batch: atomic and non atomic batches",
  specs: [
    one(
      "batch-atomic",
      "Every operation of an atomic batch commits together",
      step("POST", "/_batch", "alice", {
        atomic: true,
        ops: [
          { op: "insert", c: "notes", doc: { _id: "n9", ownerId: "alice" } },
          { op: "update", c: "notes", id: "n1", update: { $set: { title: "b1" } } },
          { op: "update", c: "notes", id: "n9", update: { $set: { title: "b9" } } },
          { op: "delete", c: "notes", id: "n2" },
          { op: "replace", c: "posts", id: "p1", doc: { status: "draft", title: "r" } },
        ],
      }),
      ["notes", "posts"],
    ),
    one(
      "batch-atomic-refused",
      "One refused operation rolls the batch back and names its index",
      step("POST", "/_batch", "alice", {
        atomic: true,
        ops: [
          { op: "update", c: "notes", id: "n1", update: { $set: { title: "b1" } } },
          { op: "update", c: "notes", id: "n2", update: { $set: { ownerId: "bob" } } },
        ],
      }),
      ["notes"],
    ),
    one(
      "batch-atomic-mid",
      "An atomic batch takes its key from the header",
      step("POST", "/_batch", "alice", {
        atomic: true,
        ops: [{ op: "delete", c: "notes", id: "n1", mid: "abcdefgh1" }],
      }),
      ["notes"],
    ),
    one(
      "batch-atomic-minimal",
      "return=minimal",
      step(
        "POST",
        "/_batch",
        "alice",
        { atomic: true, ops: [{ op: "delete", c: "notes", id: "n1" }] },
        { prefer: "return=minimal" },
      ),
      ["notes"],
    ),
    one(
      "batch-each",
      "Each operation of a batch that is not atomic stands alone",
      step("POST", "/_batch", "alice", {
        ops: [
          { op: "update", c: "notes", id: "n1", update: { $set: { title: "e1" } } },
          { op: "update", c: "notes", id: "n2", update: { $set: { ownerId: "bob" } } },
          { op: "insert", c: "notes", doc: { _id: "n9", ownerId: "alice" } },
          { op: "nope", c: "notes" },
          { op: "delete", c: "notes", id: "n5" },
          { op: "insertMany", c: "notes", docs: [{ _id: "n8", ownerId: "alice" }] },
        ],
      }),
      ["notes"],
    ),
    one(
      "batch-each-bulk-without-prefer",
      "A bulk operation needs Prefer: bulk=true",
      step("POST", "/_batch", "alice", {
        ops: [{ op: "deleteMany", c: "notes", filter: { done: true } }],
      }),
      ["notes"],
    ),
    one(
      "batch-each-bulk",
      "A bulk operation with Prefer: bulk=true",
      step(
        "POST",
        "/_batch",
        "alice",
        {
          ops: [
            {
              op: "updateMany",
              c: "notes",
              filter: { done: true },
              update: { $set: { title: "u" } },
            },
            { op: "deleteMany", c: "notes", filter: { done: false } },
          ],
        },
        { prefer: "bulk=true" },
      ),
      ["notes"],
    ),
    one(
      "batch-empty",
      "A batch without operations",
      step("POST", "/_batch", "alice", { ops: [] }),
      [],
    ),
    one(
      "batch-unknown-field",
      "An unknown batch field",
      step("POST", "/_batch", "alice", { ops: [], parallel: true }),
      [],
    ),
    one(
      "batch-atomic-not-boolean",
      "atomic must be a boolean",
      step("POST", "/_batch", "alice", { atomic: "yes", ops: [] }),
      [],
    ),
    one(
      "batch-not-document",
      "A batch must be a document",
      step("POST", "/_batch", "alice", [{ op: "delete" }]),
      [],
    ),
    one(
      "batch-op-unknown-field",
      "An operation with an unknown field",
      step("POST", "/_batch", "alice", {
        atomic: true,
        ops: [{ op: "delete", c: "notes", id: "n1", filter: {} }],
      }),
      ["notes"],
    ),
    one(
      "batch-op-no-id",
      "An update without an id",
      step("POST", "/_batch", "alice", {
        atomic: true,
        ops: [{ op: "update", c: "notes", update: { $set: { a: 1 } } }],
      }),
      ["notes"],
    ),
  ],
}

const KEY = "conformance-key-1"
const OTHER = "conformance-key-2"

const idempotency: WriteGroup = {
  name: "idempotency",
  description:
    "Idempotency-Key: a repeated key answers the stored outcome, a reused key for another write or caller is a conflict",
  specs: [
    {
      id: "key-replay-insert",
      title: "The same insert twice with one key is written once",
      steps: [
        step(
          "POST",
          "/notes",
          "alice",
          { _id: "n9", ownerId: "alice" },
          { "idempotency-key": KEY },
        ),
        step(
          "POST",
          "/notes",
          "alice",
          { _id: "n9", ownerId: "alice" },
          { "idempotency-key": KEY },
        ),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-replay-update",
      title: "A replayed update answers the document as it is now",
      steps: [
        step("PATCH", "/notes/n1", "alice", { $push: { tags: "k" } }, { "idempotency-key": KEY }),
        step("PATCH", "/notes/n1", "alice", { $set: { title: "later" } }),
        step("PATCH", "/notes/n1", "alice", { $push: { tags: "k" } }, { "idempotency-key": KEY }),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-other-body",
      title: "A key reused for another write is a conflict",
      steps: [
        step("PATCH", "/notes/n1", "alice", { $set: { title: "a" } }, { "idempotency-key": KEY }),
        step("PATCH", "/notes/n1", "alice", { $set: { title: "b" } }, { "idempotency-key": KEY }),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-other-caller",
      title: "A key used by another caller is a conflict",
      steps: [
        step(
          "POST",
          "/notes",
          "alice",
          { _id: "n9", ownerId: "alice" },
          { "idempotency-key": KEY },
        ),
        step("POST", "/notes", "bob", { _id: "n9", ownerId: "bob" }, { "idempotency-key": KEY }),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-replay-delete",
      title: "A replayed delete has no document left to return",
      steps: [
        step("DELETE", "/notes/n1", "alice", undefined, { "idempotency-key": KEY }),
        step("DELETE", "/notes/n1", "alice", undefined, { "idempotency-key": KEY }),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-refused-write",
      title: "A refused write records nothing, so the key stays free",
      steps: [
        step(
          "PATCH",
          "/notes/n1",
          "alice",
          { $set: { ownerId: "bob" } },
          { "idempotency-key": KEY },
        ),
        step("PATCH", "/notes/n1", "alice", { $set: { title: "ok" } }, { "idempotency-key": KEY }),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-replay-batch",
      title: "An atomic batch under one key",
      steps: [
        step(
          "POST",
          "/_batch",
          "alice",
          {
            atomic: true,
            ops: [
              { op: "update", c: "notes", id: "n1", update: { $push: { tags: "k" } } },
              { op: "insert", c: "notes", doc: { _id: "n9", ownerId: "alice" } },
            ],
          },
          { "idempotency-key": OTHER },
        ),
        step(
          "POST",
          "/_batch",
          "alice",
          {
            atomic: true,
            ops: [
              { op: "update", c: "notes", id: "n1", update: { $push: { tags: "k" } } },
              { op: "insert", c: "notes", doc: { _id: "n9", ownerId: "alice" } },
            ],
          },
          { "idempotency-key": OTHER },
        ),
      ],
      observe: ["notes"],
      records: true,
    },
    {
      id: "key-each-mid",
      title: "Each operation of a batch that is not atomic has its own key",
      steps: [
        step("POST", "/_batch", "alice", {
          ops: [
            { op: "update", c: "notes", id: "n1", update: { $push: { tags: "k" } }, mid: KEY },
            { op: "update", c: "notes", id: "n2", update: { $push: { tags: "k" } } },
          ],
        }),
        step("POST", "/_batch", "alice", {
          ops: [
            { op: "update", c: "notes", id: "n1", update: { $push: { tags: "k" } }, mid: KEY },
            { op: "update", c: "notes", id: "n2", update: { $push: { tags: "k" } } },
          ],
        }),
      ],
      observe: ["notes"],
      records: true,
    },
    one(
      "key-invalid",
      "A key that is not 8 to 128 URL safe characters",
      step(
        "POST",
        "/notes",
        "alice",
        { _id: "n9", ownerId: "alice" },
        { "idempotency-key": "short" },
      ),
      ["notes"],
      true,
    ),
  ],
}

/** The groups of the writes oracle, recorded into `conformance/http/writes`. */
export const WRITE_GROUPS: readonly WriteGroup[] = [
  insert,
  update,
  replace,
  remove,
  bulk,
  batch,
  idempotency,
]
