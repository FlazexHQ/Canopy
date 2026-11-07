import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { MongoClient } from "mongodb"
import type { Output } from "./output.ts"
import {
  closedPolicy,
  ownerOnly,
  type PolicyTemplate,
  publicReadOwnerWrite,
  TEMPLATES,
  tenantScoped,
} from "./templates.ts"

/** Options of `canopy init`. */
export interface InitOptions {
  /** The project root, which must already have a `package.json`. */
  readonly cwd: string
  /** Introspect this database to write one closed policy file per collection. */
  readonly mongodbUri?: string
  /** The database to introspect. Required with `mongodbUri`. */
  readonly database?: string
}

/** A package manager and the commands it uses. */
export interface PackageManager {
  readonly name: "bun" | "pnpm" | "yarn" | "npm"
  readonly add: string
  readonly addDev: string
  readonly exec: string
}

const MANAGERS: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", { name: "bun", add: "bun add", addDev: "bun add -d", exec: "bunx" }],
  ["bun.lockb", { name: "bun", add: "bun add", addDev: "bun add -d", exec: "bunx" }],
  ["pnpm-lock.yaml", { name: "pnpm", add: "pnpm add", addDev: "pnpm add -D", exec: "pnpm exec" }],
  ["yarn.lock", { name: "yarn", add: "yarn add", addDev: "yarn add -D", exec: "yarn" }],
  ["package-lock.json", { name: "npm", add: "npm install", addDev: "npm install -D", exec: "npx" }],
]

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Detects the package manager from the lockfile in `cwd`, falling back to npm. */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  for (const [lockfile, manager] of MANAGERS) if (await exists(join(cwd, lockfile))) return manager
  const npm = MANAGERS.at(-1)
  if (npm === undefined) throw new TypeError("no package managers are defined")
  return npm[1]
}

const CONFIG = `import { defineConfig, env } from "@canopy/config"

export default defineConfig({
  mongodb: { uri: env.secret("MONGODB_URI") },
  keys: {
    publishable: env.list.optional("CANOPY_PUBLISHABLE_KEYS"),
    secret: env.list.optional("CANOPY_SECRET_KEYS"),
  },
  policies: { dir: "./policies" },
  // Verify user tokens from your identity provider, for example:
  // auth: external.auth0({ domain: env("AUTH0_DOMAIN"), audience: "https://api.example.com" }),
  // (import external from "@canopy/config" as well)
})
`

const ENV_EXAMPLE = `# Copy to canopy/.env.local and fill in. canopy dev reads .env, .env.local, .env.development and
# .env.development.local next to canopy.config.ts; real environment variables always win.

# A replica set: change streams and transactions do not work on a standalone server.
# The database in the path is the app database.
MONGODB_URI=mongodb://localhost:27017/app?replicaSet=rs0

# Comma separated. A publishable key (canopy_pk_...) lets browsers connect as anon or with a user token;
# a secret key (canopy_sk_...) is the service role and bypasses every policy, so keep it on servers.
CANOPY_PUBLISHABLE_KEYS=
CANOPY_SECRET_KEYS=
`

const GITIGNORE_LINES = ["canopy/.env", "canopy/.env.*", "!canopy/.env.example"]

const OWNER_FIELDS = ["ownerId", "userId", "owner", "createdBy", "authorId", "uid"]
const TENANT_FIELDS = ["tenantId", "orgId", "organizationId", "workspaceId", "teamId", "accountId"]

/** The template a collection's documents suggest, from the fields of a sampled document. */
export function suggestTemplate(
  fields: readonly string[],
): { readonly template: PolicyTemplate; readonly field: string } | undefined {
  const tenant = TENANT_FIELDS.find((field) => fields.includes(field))
  if (tenant !== undefined) return { template: tenantScoped, field: tenant }
  const owner = OWNER_FIELDS.find((field) => fields.includes(field))
  if (owner === undefined) return undefined
  return fields.includes("published")
    ? { template: publicReadOwnerWrite, field: owner }
    : { template: ownerOnly, field: owner }
}

function fileName(collection: string): string {
  return `${collection.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.ts`
}

/**
 * `canopy init`: adds a `canopy/` folder to an existing project: the config file, starter policy templates,
 * `.env.example`, and with a MongoDB URI one policy file per collection. Everything starts closed
 * (`exposed: false`). Existing files are never overwritten; nothing outside `canopy/` changes except
 * `.gitignore`, which gets the env file rules appended.
 */
export async function init(options: InitOptions, out: Output): Promise<number> {
  const root = options.cwd
  if (!(await exists(join(root, "package.json")))) {
    out.error(
      `No package.json in ${root}. canopy init adds Canopy to an existing project; it does not create one.`,
    )
    return 1
  }
  const manager = await detectPackageManager(root)
  const files = new Map<string, string>()
  const dir = join(root, "canopy")
  files.set(join(dir, "canopy.config.ts"), CONFIG)
  files.set(join(dir, ".env.example"), ENV_EXAMPLE)
  for (const { template, collection, field } of TEMPLATES)
    files.set(join(dir, "policies", "templates", template.file), template.render(collection, field))

  const notes = new Map<string, string>()
  if (options.mongodbUri !== undefined) {
    const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
    try {
      await client.connect()
      const database = options.database ?? client.db().databaseName
      const db = client.db(database)
      const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((info) => info.name)
        .filter((name) => !name.startsWith("system."))
        .sort()
      out.log(`Connected to ${database}: ${collections.length} collections`)
      for (const name of collections) {
        const sample = await db.collection(name).findOne({})
        const suggestion = suggestTemplate(sample === null ? [] : Object.keys(sample))
        const path = join(dir, "policies", fileName(name))
        if (suggestion === undefined) {
          files.set(path, closedPolicy(name))
          notes.set(path, "exposed: false, no policies yet")
        } else {
          files.set(
            path,
            `// Suggested by canopy init from the ${suggestion.field} field.\n${suggestion.template.render(name, suggestion.field)}`,
          )
          notes.set(path, `exposed: false, ${suggestion.template.title.toLowerCase()} suggested`)
        }
      }
    } catch (error: unknown) {
      out.error(
        `Cannot introspect the database: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    } finally {
      await client.close()
    }
  }

  for (const [path, content] of files) {
    const shown = relative(root, path)
    if (await exists(path)) {
      out.log(`  exists  ${shown}  (kept)`)
      continue
    }
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, content, { flag: "wx" })
    const note = notes.get(path)
    out.log(`  create  ${shown}${note === undefined ? "" : `  ${note}`}`)
  }
  await mkdir(join(dir, "policies"), { recursive: true })

  const gitignore = join(root, ".gitignore")
  const current = (await exists(gitignore)) ? await readFile(gitignore, "utf8") : ""
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()))
  const missing = GITIGNORE_LINES.filter((line) => !have.has(line))
  if (missing.length > 0) {
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n"
    await writeFile(gitignore, `${current}${prefix}${missing.join("\n")}\n`)
    out.log(`  ${current === "" ? "create" : "update"}  .gitignore  + ${missing.join(", ")}`)
  }

  out.log("")
  out.log("Next:")
  out.log(`  1. ${manager.add} @canopy/config @canopy/policy && ${manager.addDev} @canopy/cli`)
  out.log("  2. Copy canopy/.env.example to canopy/.env.local and set MONGODB_URI")
  out.log(
    "  3. Write the policies of a collection in canopy/policies (start from ./templates), then set exposed: true",
  )
  out.log(`  4. ${manager.exec} canopy dev`)
  return 0
}
