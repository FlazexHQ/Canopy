import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  allow,
  collection,
  contextsFromStored,
  createPolicySet,
  fromStored,
  PolicyEngine,
  toStored,
} from "@canopy/policy"
import { type CollectionSchema, fromJsonSchema, inferSchema } from "@canopy/schema"
import { getIntrospectionQuery, graphqlSync, introspectionFromSchema, printSchema } from "graphql"
import { BSON, type Document } from "mongodb"
import { buildSchema, type SchemaInput } from "../../../src/schema.ts"
import { buildGraphqlFixture } from "../fixture.ts"

const introspectionOptions = {
  specifiedByUrl: true,
  directiveIsRepeatable: true,
  schemaDescription: true,
  inputValueDeprecation: true,
  experimentalDirectiveDeprecation: true,
  oneOf: true,
}

const aliasQuery = `
  query Metadata($show: Boolean! = true) {
    input: __type(name: "PersonInsert") {
      option: isOneOf @include(if: $show)
      ...Option
      skipped: isOneOf @skip(if: $show)
      _canopyMetadata0: kind
    }
    named: __type(name: "Person") { ...Option }
    schema: __schema {
      directives(includeDeprecated: false) {
        name
        obsolete: isDeprecated
        reason: deprecationReason
        places: locations
      }
    }
  }
  fragment Option on __Type { option: isOneOf }
`

interface CaseInput {
  readonly name: string
  readonly policies: Awaited<ReturnType<typeof buildGraphqlFixture>>["policies"]
  readonly caller: {
    readonly roles: readonly string[]
    readonly claims: SchemaInput["ctx"]["claims"]
    readonly ctx: NonNullable<SchemaInput["ctx"]["ctx"]>
  }
  readonly collections: readonly string[]
  readonly schemas: readonly CollectionSchema[]
  readonly config: NonNullable<SchemaInput["config"]>
  readonly subscriptions: boolean
  readonly defaultLimit: number
  readonly maxLimit: number
}

async function fixtureCases(): Promise<CaseInput[]> {
  const fixture = await buildGraphqlFixture()
  const collections = Object.keys(fixture.collections).sort()
  const schemas = Object.entries(fixture.collections).map(([name, docs]) =>
    inferSchema(
      name,
      docs.map((doc) => BSON.EJSON.deserialize(doc as Document, { relaxed: false })),
    ),
  )
  return ["alice", "bob", "anon", "service"].map((name) => ({
    name,
    policies: fixture.policies,
    caller: {
      roles: [name === "alice" || name === "bob" ? "authenticated" : name],
      claims: name === "alice" || name === "bob" ? { sub: name } : null,
      ctx:
        name === "alice" || name === "bob"
          ? {
              projectIds: (fixture.collections["memberships"] ?? [])
                .map((doc) => doc as Document)
                .filter((doc) => doc["userId"] === name)
                .map((doc) => doc["projectId"]),
            }
          : {},
    },
    collections,
    schemas,
    config: fixture.relations,
    subscriptions: false,
    defaultLimit: fixture.readLimits.defaultLimit,
    maxLimit: fixture.readLimits.maxLimit,
  }))
}

function fieldCases(): CaseInput[] {
  const profile = {
    bsonType: "object",
    required: ["label", "private"],
    properties: { label: { bsonType: "string" }, private: { bsonType: "string" } },
  }
  const shape = fromJsonSchema({
    bsonType: "object",
    additionalProperties: false,
    required: ["_id", "label", "profile", "profiles", "score"],
    properties: {
      _id: { bsonType: "objectId" },
      label: { bsonType: "string" },
      profile,
      profiles: { bsonType: "array", items: profile },
      score: { bsonType: ["int", "double"] },
      nullable: { bsonType: ["bool", "null"] },
      mixed: { bsonType: ["string", "int"] },
      uuid: { bsonType: "uuid" },
      timestamp: { bsonType: "timestamp" },
      and: { bsonType: "int" },
      or: { bsonType: "bool" },
      raw: { bsonType: "string" },
      constructor: { bsonType: "string" },
      toString: { bsonType: "string" },
      _extra: { bsonType: "string" },
      "invalid.name": { bsonType: "int" },
      invalid_name: { bsonType: "double" },
      "2field": { bsonType: "string" },
      "x😀": { bsonType: "string" },
    },
  })
  if (shape.kind !== "object") throw new Error("Expected a validator object")
  const names = ["people", "person", "children", "geese", "indices", "news"]
  const limitedRead = { only: ["_id", "profile.label", "profiles.label"] }
  const limitedWrite = { only: ["label", "profile.label", "profiles.label"] }
  const people = (limited: boolean) =>
    collection("people", {
      exposed: true,
      realtime: true,
      policies: [
        allow.read("authenticated"),
        allow.insert("inserter"),
        allow.update("updater"),
        allow.delete("deleter"),
      ],
      fields: limited
        ? {
            read: { default: limitedRead },
            write: { default: limitedWrite },
            update: { default: limitedWrite },
          }
        : {
            read: { default: { omit: ["profile.private", "profiles.private"] } },
            update: { default: { omit: ["profile.private", "profiles.private", "raw"] } },
          },
    })
  const others = names
    .slice(1)
    .map((name) => collection(name, { exposed: true, policies: [allow.read("authenticated")] }))
  const settings = [
    { name: "insert-only", roles: ["inserter"], subscriptions: true },
    { name: "update-only", roles: ["updater"], subscriptions: true },
    { name: "delete-only", roles: ["deleter"], subscriptions: true },
    { name: "all-writes", roles: ["inserter", "updater", "deleter"], subscriptions: true },
    { name: "only-fields", roles: ["inserter", "updater"], subscriptions: false },
    { name: "empty", roles: ["anon"], subscriptions: true },
  ]
  return settings.map(({ name, roles, subscriptions }) => ({
    name,
    policies: {
      collections: [people(name === "only-fields"), ...others].map((definition) =>
        toStored(definition, { version: 1 }),
      ),
      contexts: {},
    },
    caller: {
      roles: roles.includes("anon") ? roles : ["authenticated", ...roles],
      claims: roles.includes("anon") ? null : { sub: "alice" },
      ctx: {},
    },
    collections: names,
    schemas: [
      { name: "people", shape, source: "validator" },
      ...names.slice(1).map((name) =>
        inferSchema(name, [
          {
            _id: name,
            owner: "alice",
            ...(name === "geese"
              ? {
                  uuid: new BSON.UUID("00000000-0000-4000-8000-000000000001"),
                  timestamp: new BSON.Timestamp({ t: 8, i: 3 }),
                }
              : {}),
          },
        ]),
      ),
    ],
    config: {
      children: { typeName: "Ward" },
      people: {
        relations: {
          lead: { to: "person", local: "label" },
          wards: { to: "children", local: "_id", foreign: "owner", many: true },
        },
      },
    },
    subscriptions,
    defaultLimit: 17,
    maxLimit: 88,
  }))
}

function answer(input: CaseInput) {
  const { policies, caller, schemas } = input
  const engine = new PolicyEngine(
    createPolicySet(policies.collections.map(fromStored), contextsFromStored(policies.contexts)),
  )
  const schema = buildSchema({
    ...input,
    engine,
    ctx: {
      ...caller,
      ctx: BSON.EJSON.deserialize({ ...caller.ctx }, { relaxed: false }),
      roles: new Set(caller.roles),
      now: new Date(0),
    },
    schemas: new Map(schemas.map((schema) => [schema.name, schema])),
  })
  const aliases =
    input.name === "all-writes" ? graphqlSync({ schema, source: aliasQuery }) : undefined
  if (aliases !== undefined && (aliases.data == null || aliases.errors !== undefined))
    throw new Error(JSON.stringify(aliases.errors))
  return {
    ...input,
    expected: {
      introspection: introspectionFromSchema(schema),
      sdl: printSchema(schema),
      ...(input.name === "alice" || input.name === "empty"
        ? {
            standard: introspectionFromSchema(schema, {
              specifiedByUrl: false,
              directiveIsRepeatable: false,
              schemaDescription: false,
              inputValueDeprecation: false,
              experimentalDirectiveDeprecation: false,
              oneOf: false,
            }),
          }
        : {}),
      ...(aliases === undefined ? {} : { aliases: aliases.data }),
    },
  }
}

/** Saves the graphql-js schema answers, or checks whether the saved answers are current. */
export async function recordGraphqlSchemas(options: {
  readonly file: string
  readonly check: boolean
}): Promise<boolean> {
  const vectors = {
    standardQuery: getIntrospectionQuery(),
    fullQuery: getIntrospectionQuery(introspectionOptions),
    aliasQuery,
    cases: [...(await fixtureCases()), ...fieldCases()].map(answer),
  }
  const content = `${JSON.stringify(vectors, null, 2).replaceAll(/\x20-\x20/g, " \\u002d ")}\n`
  if (options.check)
    return (await readFile(options.file, "utf8")).replaceAll("\r\n", "\n") !== content
  await mkdir(dirname(options.file), { recursive: true })
  await writeFile(options.file, content)
  return false
}
