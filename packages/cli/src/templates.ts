/** A starter policy template written by `canopy init`. */
export interface PolicyTemplate {
  /** The file name under `canopy/policies/templates/`. */
  readonly file: string
  readonly title: string
  /** The policy module for a collection, keyed on one field. */
  render(collection: string, field: string): string
}

const header = (title: string, lines: readonly string[]): string =>
  [`// ${title}`, ...lines.map((line) => (line === "" ? "//" : `// ${line}`))].join("\n")

/** Every document belongs to one user, who alone may read and change it. */
export const ownerOnly: PolicyTemplate = {
  file: "owner-only.ts",
  title: "Owner only",
  render: (collection, field) => `${header("Owner only", [
    `Every document belongs to the user in ${field}; nobody else can see or change it.`,
    "Set exposed: true once the policies below match your data.",
  ])}
import { allow, auth, collection } from "@canopy/policy"

export default collection(${JSON.stringify(collection)}, {
  exposed: false,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ${field}: auth("sub") })
      .named("owner reads"),
    allow
      .insert("authenticated")
      .check({ ${field}: auth("sub") })
      .named("owner creates"),
    allow
      .update("authenticated")
      .where({ ${field}: auth("sub") })
      .check({ ${field}: auth("sub") })
      .named("owner edits"),
    allow
      .delete("authenticated")
      .where({ ${field}: auth("sub") })
      .named("owner deletes"),
  ],
  immutable: [${JSON.stringify(field)}],
})
`,
}

/** Documents belong to a tenant named by a token claim; every member of the tenant may use them. */
export const tenantScoped: PolicyTemplate = {
  file: "tenant-scoped.ts",
  title: "Tenant scoped",
  render: (collection, field) => `${header("Tenant scoped", [
    `Documents belong to the tenant in ${field}; every member of that tenant may use them.`,
    "The tenant comes from the org_id claim of the token. When membership lives in MongoDB instead, declare",
    'a context lookup in policies/_context.ts and compare with ctx("tenantIds") using $in.',
    "Set exposed: true once the policies below match your data.",
  ])}
import { allow, auth, collection } from "@canopy/policy"

export default collection(${JSON.stringify(collection)}, {
  exposed: false,
  realtime: true,
  policies: [
    allow
      .ops(["read", "delete"], "authenticated")
      .where({ ${field}: auth("org_id") })
      .named("members read and delete"),
    allow
      .insert("authenticated")
      .check({ ${field}: auth("org_id") })
      .named("members create in their tenant"),
    allow
      .update("authenticated")
      .where({ ${field}: auth("org_id") })
      .check({ ${field}: auth("org_id") })
      .named("members edit"),
  ],
  immutable: [${JSON.stringify(field)}],
})
`,
}

/** Published documents are public; their author writes them. */
export const publicReadOwnerWrite: PolicyTemplate = {
  file: "public-read-owner-write.ts",
  title: "Public read, owner write",
  render: (collection, field) => `${header("Public read, owner write", [
    `Anyone, signed in or not, reads published documents. The user in ${field} writes them and also`,
    "sees their drafts.",
    "Set exposed: true once the policies below match your data.",
  ])}
import { allow, auth, collection } from "@canopy/policy"

export default collection(${JSON.stringify(collection)}, {
  exposed: false,
  realtime: true,
  policies: [
    allow.read("public").where({ published: true }).named("anyone reads published"),
    allow
      .read("authenticated")
      .where({ ${field}: auth("sub") })
      .named("author reads drafts"),
    allow
      .insert("authenticated")
      .check({ ${field}: auth("sub") })
      .named("author creates"),
    allow
      .update("authenticated")
      .where({ ${field}: auth("sub") })
      .check({ ${field}: auth("sub") })
      .named("author edits"),
    allow
      .delete("authenticated")
      .where({ ${field}: auth("sub") })
      .named("author deletes"),
  ],
  immutable: [${JSON.stringify(field)}],
})
`,
}

/** A drop box: anyone may submit, nobody reads back through Canopy. */
const writeOnlyIntake: PolicyTemplate = {
  file: "write-only-intake.ts",
  title: "Write only intake",
  render: (collection, field) => `${header("Write only intake", [
    "A contact form or feedback box: anyone may insert a document, nobody can read, change or delete",
    "one through Canopy. Read submissions with a secret key on your server.",
    "Set exposed: true once the policies below match your data.",
  ])}
import { allow, collection } from "@canopy/policy"

export default collection(${JSON.stringify(collection)}, {
  exposed: false,
  realtime: false,
  policies: [
    allow
      .insert("public")
      .check({ ${field}: { $type: "string" }, status: "new" })
      .named("anyone submits"),
  ],
  fields: {
    write: { default: { only: [${JSON.stringify(field)}, "message", "status"] } },
  },
})
`,
}

/** The starter templates with the collection and key field each example uses. */
export const TEMPLATES: readonly {
  readonly template: PolicyTemplate
  readonly collection: string
  readonly field: string
}[] = [
  { template: ownerOnly, collection: "notes", field: "ownerId" },
  { template: tenantScoped, collection: "projects", field: "orgId" },
  { template: publicReadOwnerWrite, collection: "posts", field: "authorId" },
  { template: writeOnlyIntake, collection: "feedback", field: "email" },
]

/** A collection with no policies, so nothing is exposed until someone writes them. */
export function closedPolicy(collection: string): string {
  return `// Nothing in ${collection} is reachable through Canopy yet. Copy a policy from ./templates,
// then set exposed: true.
import { collection } from "@canopy/policy"

export default collection(${JSON.stringify(collection)}, {
  exposed: false,
  policies: [],
})
`
}
