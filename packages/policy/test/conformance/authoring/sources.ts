import { readdirSync, readFileSync } from "node:fs"
import ts from "typescript"

const root = new URL("../../../../../", import.meta.url)

function read(path: string): string {
  return readFileSync(new URL(path, root), "utf8").replaceAll("\r\n", "\n")
}

function fixtureSource(path: string): string {
  const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  const imports = file.statements.filter(ts.isImportDeclaration)
  const imported = imports.find((item) => item.moduleSpecifier.getText(file) === '"@canopy/policy"')
  if (imported === undefined) throw new Error(`Missing policy import in ${path}`)
  const collections: string[] = []
  const helpers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "collection") {
      collections.push(node.getText(file))
      return
    }
    if (
      path === "examples/todo-react/src/policies.ts" &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "visible"
    ) {
      helpers.push(`const ${node.getText(file)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (collections.length === 0) throw new Error(`Missing policy collections in ${path}`)
  return [
    imported
      .getText(file)
      .replace("@canopy/policy", "canopy.js/policy")
      .replace(", createPolicySet", ""),
    ...helpers,
    `export default { collections: [
${collections.join(",\n")}
], contexts: {} }`,
    "",
  ].join("\n")
}

const policyImports =
  'import { allow, auth, collection, context, createPolicyKit, ctx, now, restrict } from "canopy.js/policy"'
const testImports = 'import { as, describePolicies } from "canopy.js/policy/testing"'

export function sources() {
  const sdkDirectory = "packages/sdk-e2e/test/"
  const sdkFixtures = readdirSync(new URL(sdkDirectory, root))
    .filter((name) => name.endsWith(".e2e.test.ts"))
    .sort()
    .map((name) => sdkDirectory + name)
    .filter((path) => read(path).includes('from "@canopy/policy"'))
  const fixtures = [
    "deploy/dev/policies/notes.ts",
    "examples/auth-notes/src/policies.ts",
    "examples/express-dropin/canopy/policies/tickets.ts",
    "examples/graphql-vue/src/policies.ts",
    "examples/next-ssr/canopy/server.ts",
    "examples/todo-react/src/policies.ts",
    ...sdkFixtures,
  ]
  return {
    sets: [
      {
        name: "constructs",
        source: `${policyImports}
import { ObjectId } from "canopy.js/protocol"

const kit = createPolicyKit<{ roles: "editor" }>()
export default {
  collections: [
    collection("privateNotes"),
    collection("storage.objects", {
      policies: [{ name: "download", kind: "permissive", ops: ["read"], roles: ["anon"] }],
    }),
    kit.collection("projects", {
      exposed: true,
      realtime: true,
      policies: [
        kit.allow.read("editor", "authenticated").where({
          _id: { $in: ctx("projectIds") },
          owner: auth("sub", "objectId"),
          code: auth("profile.code", "string"),
          score: { $gte: auth("level", "number") },
          enabled: auth("enabled", "bool"),
          expires: { $gte: auth("expiry", "date") },
          group: auth("group", "uuid"),
        }),
        restrict.ops(["read", "update", "delete"], "authenticated")
          .where({ deadline: { $gt: now() }, createdAt: { $gte: now("-P7D") } })
          .named("active projects"),
        allow.insert("authenticated").check({
          owner: auth("sub"),
          tenant: new ObjectId("000000000000000000000001"),
          createdAt: { $gte: new Date("2026-01-01T00:00:00.000Z") },
          priority: { $gte: 2 },
        }),
        allow.update("authenticated").where({ owner: auth("sub") }).check({ owner: auth("sub") }),
        allow.delete("authenticated").where({ owner: auth("sub") }),
      ],
      fields: {
        read: { default: { omit: ["private.notes"] }, editor: { only: ["*"] } },
        write: { default: { only: ["title", "owner"] } },
        update: { default: { only: [] } },
      },
      immutable: ["owner", "tenant"],
    }),
  ],
  contexts: context({
    projectIds: {
      from: "memberships",
      where: { subject: auth("sub"), active: true },
      select: "projectId",
      max: 20,
      ttl: "30s",
    },
  }),
}
`,
      },
      ...fixtures.map((name) => ({ name, source: fixtureSource(name) })),
    ],
    suites: [
      {
        name: "actor helpers",
        policy: "deploy/dev/policies/notes.ts",
        source: `${testImports}
export default describePolicies("notes", ({ doc, expect }) => {
  const publicNote = doc({ _id: "a", public: true, text: "hello" })
  const privateNote = doc({ _id: "b", public: false })
  expect(as.anon()).can.read(publicNote).withFields(["text"]).withoutFields(["secret"])
  expect(as.anon()).cannot.read(privateNote)
  expect(as.anon()).can.insert(publicNote)
  expect(as.anon()).cannot.update(publicNote, { $set: { public: false } })
  expect(as.anon()).can.delete(publicNote)
  expect(as.service()).can.read(privateNote)
  expect(as.user({ sub: "alice", org: "canopy" }, { roles: ["editor"], ctx: { projects: ["p1"] } }))
    .cannot.read(publicNote)
}, "local notes")
`,
      },
      {
        name: "examples/express-dropin/canopy/policies/tickets.test.ts",
        policy: "examples/express-dropin/canopy/policies/tickets.ts",
        source: read("examples/express-dropin/canopy/policies/tickets.test.ts")
          .replace("@canopy/policy/testing", "canopy.js/policy/testing")
          .replace("\ndescribePolicies(", "\nexport default describePolicies("),
      },
    ],
    filterTests: [
      {
        name: "filter input",
        source: `${testImports}
export default {
  suite: "notes filters",
  collection: "notes",
  actor: as.anon(),
  action: "read",
  filter: { public: true, priority: { $gte: 2 } },
  expected: true,
}
`,
      },
    ],
    invalid: [
      {
        name: "service policy",
        kind: "set",
        path: "/collections/0/policies/0/roles/0",
        source: `${policyImports}
export default { collections: [collection("notes", { policies: [allow.read("service")] })], contexts: {} }
`,
      },
      {
        name: "ambiguous field rule",
        kind: "set",
        path: "/collections/0/fields/read/default",
        source: `${policyImports}
export default {
  collections: [collection("notes", { fields: { read: { default: { only: ["text"], omit: ["secret"] } } } })],
  contexts: {},
}
`,
      },
      {
        name: "zero context max",
        kind: "set",
        path: "/contexts/projectIds/max",
        source: `${policyImports}
export default {
  collections: [],
  contexts: context({ projectIds: { from: "memberships", where: { subject: auth("sub") }, select: "projectId", max: 0, ttl: "1m" } }),
}
`,
      },
      {
        name: "invalid claim path",
        kind: "set",
        path: "/collections/0/policies/0/using/owner/$auth",
        source: `${policyImports}
export default {
  collections: [collection("notes", { policies: [allow.read("anon").where({ owner: auth("bad..claim") })] })],
  contexts: {},
}
`,
      },
      {
        name: "function in clause",
        kind: "set",
        path: "/collections/0/policies/0/using/owner",
        source: `${policyImports}
export default {
  collections: [collection("notes", { policies: [allow.read("anon").where({ owner: () => "alice" })] })],
  contexts: {},
}
`,
      },
      {
        name: "custom assertion",
        kind: "test",
        path: "/assert",
        source: `${testImports}
const suite = describePolicies("notes", ({ expect }) => {
  expect(as.anon()).can.read({ public: true })
})
export default { ...suite.cases[0], assert: () => true }
`,
      },
      {
        name: "custom assertion descriptor",
        kind: "test",
        path: "/assert",
        source: `${testImports}
const suite = describePolicies("notes", ({ expect }) => {
  expect(as.anon()).can.read({ public: true })
})
export default { ...suite.cases[0], assert: "custom" }
`,
      },
    ],
  } as const
}
