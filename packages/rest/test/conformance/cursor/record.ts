import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CanopyError, canonicalString, parse } from "@canopy/protocol"
import { cursorKeys, cursorQueryHash, encodeCursor, keysetFilter } from "../../../src/index.ts"

/** A case of `hashes.json`: the cursor hash of a collection, a filter and a sort. */
interface HashCase {
  readonly collection: string
  /** The caller's filter, as the EJSON a request carries. */
  readonly filter: unknown
  /** The sort the request carries. The `_id` tie breaker is appended. */
  readonly sort: unknown
  /** The first 32 hex digits of the hash of the canonical query. */
  readonly hash: string
}

/** A case of `keysets.json`: the keyset filter after a position, or why it is refused. */
interface KeysetCase {
  /** The sort the request carries, `null` for none. */
  readonly sort: unknown
  /** One sort value per key of the sort, the `_id` tie breaker last, as EJSON. */
  readonly position: unknown
  /** The canonical EJSON text of the filter, set when the position yields one. */
  readonly filter?: string
  /** The message of the refusal, set when it does not. */
  readonly error?: string
}

/** A case of `cursors.json`: a position and a query hash encoded as a cursor. */
interface CursorCase {
  readonly position: unknown
  readonly hash: string
  readonly cursor: string
}

const HASHES: readonly (readonly [string, string, string])[] = [
  ["todos", "{}", "{}"],
  ["todos", '{"status":"active"}', '{"createdAt":-1}'],
  ["todos", '{"a":1,"b":{"$in":[2,1]}}', "{}"],
  ["todos", '{"b":{"$in":[1,2]},"a":1}', "{}"],
  ["todos", '{"profile.name":{"$regex":"^a","$options":"i"}}', '{"a":1,"b":-1}'],
  [
    "todos",
    '{"$or":[{"done":false},{"n":{"$gte":2.5}}],"at":{"$date":"1970-01-01T00:00:00.000Z"}}',
    '{"createdAt":-1}',
  ],
  ["todos", '{"id":{"$oid":"000000000000000000000001"},"s":"ü\\u0000x"}', '{"a":1,"b":-1}'],
  ["todos", '{"n":{"$not":{"$lt":3}},"tags":{"$all":["x","y"]}}', '{"_id":-1}'],
  ["numbers", '{"n":{"$gt":{"$numberLong":"9007199254740993"}}}', '{"n":1}'],
  ["events", '{"$and":[{"a":1},{"b":2}]}', '{"when":1,"kind":-1}'],
  ["todos", '{"name":"日本語","emoji":"😀"}', '{"name":1}'],
  ["todos", '{"a":{"$numberDecimal":"1.50"},"b":{"$numberInt":"2"},"c":2.0}', '{"c":-1,"a":1}'],
]

const KEYSETS: readonly (readonly [string, string])[] = [
  ["null", "[3]"],
  ['{"score":1}', "[7,3]"],
  ['{"createdAt":-1}', '[{"$date":{"$numberLong":"1700000000000"}},80062]'],
  ['{"k":1}', '[{"$numberDouble":"NaN"},1]'],
  ['{"k":-1}', "[5,1]"],
  ['{"k":1}', "[null,1]"],
  ['{"k":-1}', '[{"$minKey":1},1]'],
  ['{"k":1}', '[{"$maxKey":1},1]'],
  ['{"a":1}', '[{"$gt":5},1]'],
  ['{"a":1,"b":-1}', '["x",{"$eq":{"y":1}},9]'],
  ['{"v":1}', '["sym","y1"]'],
  ['{"_id":-1}', '[{"$oid":"6f1000000000000000000003"}]'],
  ['{"k":-1,"j":1}', '[{"$numberDecimal":"NaN"},2,3]'],
  ['{"k":1}', "[true,1]"],
  ['{"k":-1}', '[{"$timestamp":{"t":5,"i":1}},1]'],
  ['{"k":1}', '[{"$binary":{"base64":"AQID","subType":"00"}},1]'],
  ['{"k":1}', '[{"$numberDouble":"-Infinity"},1]'],
  ['{"k":-1}', '[{"$numberDouble":"Infinity"},1]'],
  ['{"k":1}', '[{"$numberLong":"9007199254740993"},1]'],
  ['{"k":-1}', '[{"$numberDecimal":"-1.5"},1]'],
  ['{"k":1}', '["",1]'],
  ['{"k":1,"_id":-1}', '[0,{"$oid":"000000000000000000000002"}]'],
  ['{"_id":1,"k":1}', "[1,2]"],
  ['{"a":1}', '[{"$regularExpression":{"pattern":"x","options":""}},1]'],
  ['{"a":-1}', '[{"$regularExpression":{"pattern":"x","options":""}},1]'],
  ['{"a":1}', "[[],1]"],
]

const CURSORS: readonly (readonly [string, string])[] = [
  [
    '[{"$date":{"$numberLong":"1234"}},{"$oid":"6728f0c2a1b2c3d4e5f60718"}]',
    "1cb4abd0e981f7e24003bfc0584f24ce",
  ],
  ["[null,1]", "1cb4abd0e981f7e24003bfc0584f24ce"],
  ['["aü",{"$numberDouble":"NaN"}]', "1cb4abd0e981f7e24003bfc0584f24ce"],
  ['["日本語😀","a\\u0000b"]', "a7e218460fd987933f624f42c17fc189"],
  [
    '[{"$numberLong":"-9007199254740993"},{"$numberDecimal":"0.10"}]',
    "ff9be26226f60ae5a10ef9598802f8ab",
  ],
]

type SortInput = Readonly<Record<string, 1 | -1>> | undefined

function sortOf(text: string): SortInput {
  return (JSON.parse(text) as SortInput | null) ?? undefined
}

function documentOf(text: string): Record<string, unknown> {
  return parse(text) as Record<string, unknown>
}

/** The three files, from the TypeScript `cursorQueryHash`, `keysetFilter` and `encodeCursor`. */
export function cursorFiles(): Map<string, string> {
  const hashes: HashCase[] = HASHES.map(([collection, filter, sort]) => ({
    collection,
    filter: JSON.parse(filter) as unknown,
    sort: JSON.parse(sort) as unknown,
    hash: cursorQueryHash(collection, documentOf(filter), cursorKeys(sortOf(sort))),
  }))
  const keysets: KeysetCase[] = KEYSETS.map(([sort, position]) => {
    const base = { sort: JSON.parse(sort) as unknown, position: JSON.parse(position) as unknown }
    try {
      const filter = keysetFilter(cursorKeys(sortOf(sort)), parse(position) as unknown[])
      return { ...base, filter: canonicalString(filter) }
    } catch (error: unknown) {
      if (error instanceof CanopyError) return { ...base, error: error.message }
      throw error
    }
  })
  const cursors: CursorCase[] = CURSORS.map(([position, hash]) => ({
    position: JSON.parse(position) as unknown,
    hash,
    cursor: encodeCursor({ values: parse(position) as unknown[] }, hash),
  }))
  const file = (description: string, cases: readonly unknown[]): string =>
    `${JSON.stringify({ description, cases }, null, 2)}\n`
  return new Map([
    [
      "hashes.json",
      file(
        "The cursor query hash: the first 32 hex digits of the SHA-256 of the canonical query (collection, filter, sort with the _id tie breaker). Equivalent filters hash alike.",
        hashes,
      ),
    ],
    [
      "keysets.json",
      file(
        "The keyset filter that selects the documents after a position, as canonical EJSON text, or the message of the refusal.",
        keysets,
      ),
    ],
    [
      "cursors.json",
      file(
        "A position and a query hash as a cursor: base64url of the canonical EJSON of { s: position, q: hash }.",
        cursors,
      ),
    ],
  ])
}

/**
 * Writes the cursor reference data to `dir`, or with `check` compares it with the files there instead.
 * Returns the files that differ from a fresh computation, which is none while the code is unchanged.
 */
export async function recordCursor(options: {
  readonly dir: string
  readonly check?: boolean
}): Promise<string[]> {
  const differing: string[] = []
  if (options.check !== true) await mkdir(options.dir, { recursive: true })
  for (const [name, content] of cursorFiles()) {
    const path = join(options.dir, name)
    const current = await readFile(path, "utf8").catch(() => undefined)
    if (current?.replaceAll("\r\n", "\n") !== content) differing.push(name)
    if (options.check !== true) await writeFile(path, content)
  }
  return differing
}
