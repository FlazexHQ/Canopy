import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { apiKeyDisplayPrefix, hashApiKey } from "@canopy/auth"
import { builtin } from "@canopy/config"
import { silentLogger } from "@canopy/realtime"
import { generateTypes } from "@canopy/schema"
import { createCanopy, defineConfig } from "@canopy/server"
import { BSON, type Db, MongoClient } from "mongodb"
import { run } from "../../../src/cli.ts"
import { loadCollectionSchemas } from "../../../src/collection-schemas.ts"
import { cliActor } from "../../../src/policies.ts"

const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url))
const loaderUrl = new URL("../../../../config/src/load.ts", import.meta.url)
const scratch = fileURLToPath(new URL("../../../.canopy/cli-oracle/", import.meta.url))

type Capture = { stdout: string; stderr: string; exitCode: number }
type State = Record<string, string>
type Normalize = (value: string) => string

function invoke(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stdin: string,
): Promise<Capture> {
  const child = spawn(process.execPath, ["--conditions=@canopy/source", cli, ...args], {
    cwd,
    env: { ...env, SystemRoot: process.env["SystemRoot"], NODE_NO_WARNINGS: "1" },
    timeout: 40_000,
    windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text
  })
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text
  })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.stdin.once("error", reject)
    child.once("close", (exitCode, signal) => {
      if (exitCode === null)
        reject(new Error(`canopy ${args.join(" ")} stopped on ${signal}: ${stderr}`))
      else resolve({ stdout, stderr, exitCode })
    })
    child.stdin.end(stdin)
  })
}

async function startup(args: string[], cwd: string, env: Record<string, string>): Promise<Capture> {
  let stdout = ""
  let stderr = ""
  const stop = new AbortController()
  const exitCode = await run(
    args,
    env,
    {
      log(line) {
        stdout += `${line}\n`
        if (line.startsWith("Watching the config")) stop.abort()
      },
      error(line) {
        stderr += `${line}\n`
      },
    },
    cwd,
    AbortSignal.any([stop.signal, AbortSignal.timeout(35_000)]),
  )
  if (!stop.signal.aborted) throw new Error(`dev did not reach its startup banner: ${stderr}`)
  return { stdout, stderr, exitCode }
}

async function filesOf(root: string, dir = root): Promise<State> {
  const entries = await readdir(dir, { withFileTypes: true })
  const state: State = {}
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(state, await filesOf(root, path))
    else state[relative(root, path).replaceAll("\\", "/")] = await readFile(path, "utf8")
  }
  return state
}

async function documentsOf(db: Db): Promise<State> {
  const state: State = {}
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name)
    .sort()
  for (const name of names) {
    const documents = await db
      .collection(name)
      .find({}, { promoteValues: false })
      .sort({ _id: 1 })
      .toArray()
    for (const doc of documents) {
      state[`${name}/${BSON.EJSON.stringify(doc["_id"])}`] = BSON.EJSON.stringify(doc, {
        relaxed: false,
      })
    }
  }
  return state
}

function changes(before: State, after: State, normalize: Normalize, json = false) {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key])
      .map((key) => [
        normalize(key),
        {
          before:
            before[key] === undefined
              ? null
              : json
                ? JSON.parse(normalize(before[key]))
                : normalize(before[key]),
          after:
            after[key] === undefined
              ? null
              : json
                ? JSON.parse(normalize(after[key]))
                : normalize(after[key]),
        },
      ]),
  )
}

function substitutions() {
  const values = new Map<string, string>()
  const numbered = (value: string, kind: string): string => {
    if (!values.has(value)) {
      const index =
        [...values.values()].filter((placeholder) => placeholder.startsWith(`<${kind}:`)).length + 1
      values.set(value, `<${kind}:${index}>`)
    }
    return values.get(value) ?? value
  }
  const normalize = (text: string): string => {
    for (const [value, placeholder] of [...values].sort(([a], [b]) => b.length - a.length)) {
      text = text.replaceAll(value, placeholder)
    }
    return text
      .replaceAll("\r\n", "\n")
      .replace(/<project>(?:[/\\]+[\w.-]+)+/g, (path) => path.replace(/\\+/g, "/"))
      .replace(/("userAgent":\s*")(?:Bun|node)[^"]*(?=")/gi, "$1<runtime-user-agent>")
      .replace(/("(?:salt|storedKey|serverKey)":")[A-Za-z0-9+/]+=*(?=")/g, "$1<scram-value>")
      .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, (value) => numbered(value, "uuid"))
      .replace(/(?<="(?:\$oid|id)":")[\da-f]{24}/g, (value) => numbered(value, "object-id"))
      .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/g, "<time>")
      .replace(/(?<="\$date":\{"\$numberLong":")\d{13}/g, "<time-ms>")
      .replace(/MongoDB \d+\.\d+\.\d+/g, "MongoDB <version>")
      .replace(/featureCompatibilityVersion \d+\.\d+/g, "featureCompatibilityVersion <fcv>")
      .replace(/canopy_[ps]k_dev_[\da-f]+/g, (value) => numbered(value, "dev-key"))
      .replace(/("passwordHash":")[^"]+/g, "$1<password-hash>")
      .replace(/\badm_[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g, (value) => numbered(value, "admin-id"))
  }
  return { normalize, bind: (value: string, placeholder: string) => values.set(value, placeholder) }
}

async function remote(
  client: MongoClient,
  uri: string,
  names: { app: string; meta: string; auth: string },
  exercise: (url: string, token: string) => Promise<void>,
): Promise<void> {
  const canopy = await createCanopy(
    defineConfig({
      mongodb: { uri, database: names.app, metaDatabase: names.meta, authDatabase: names.auth },
      auth: builtin({ appName: "CLI fixture", redirectUrls: ["http://localhost"] }),
      masterKey: "fixture-master-key".repeat(3),
      realtime: false,
      policies: { source: "database" },
      server: { engine: "ts" },
    }),
    { mongo: client, env: {}, studio: false, onSetupToken: false, logger: silentLogger },
  )
  const server = createServer(canopy.node())
  try {
    await canopy.admin.settings.update(
      { requestLogSampleRate: 0 },
      { type: "system", id: "fixture" },
      {},
    )
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const email = "remote@example.test"
    const password = "fixture updated password"
    const bootstrap = await canopy.admin.accounts.createBootstrap(
      { email, role: "admin" },
      { type: "system", id: "fixture" },
    )
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${url}/admin/v1${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      })
    const login = async (password: string): Promise<string> => {
      const response = await post("/login", { email, password, transport: "bearer" })
      if (response.status !== 200)
        throw new Error(`Fixture login: ${response.status} ${await response.text()}`)
      const body = (await response.json()) as { token?: unknown }
      if (typeof body.token !== "string") throw new Error("Fixture login did not yield a token")
      return body.token
    }
    const changed = await post(
      "/me/password",
      { current: bootstrap.password, next: password },
      await login(bootstrap.password),
    )
    if (changed.status !== 204)
      throw new Error(`Fixture password change: ${changed.status} ${await changed.text()}`)
    await exercise(url, await login(password))
  } finally {
    try {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } finally {
      await canopy.close()
    }
  }
}

/** Captures the TypeScript CLI and checks per-command transcripts against the checked-in oracle. */
export async function recordCli(dir: string, uri: string, check: boolean): Promise<string[]> {
  await mkdir(scratch, { recursive: true })
  const project = await mkdtemp(join(scratch, "project-"))
  const names = Object.fromEntries(
    ["app", "meta", "auth"].map((key) => [key, `canopy_cli_${randomUUID().slice(0, 12)}_${key}`]),
  ) as {
    app: string
    meta: string
    auth: string
  }
  const { bind, normalize } = substitutions()
  bind(uri, "<mongo-uri>")
  bind(names.app, "<app-db>")
  bind(names.meta, "<meta-db>")
  bind(names.auth, "<auth-db>")
  bind(project, "<project>")
  bind(project.replaceAll("\\", "\\\\"), "<project>")
  bind(project.replaceAll("\\", "/"), "<project>")
  bind(pathToFileURL(project).href, "<project>")
  bind(loaderUrl.href, "<config-loader>")
  bind(fileURLToPath(loaderUrl), "<config-loader>")
  bind(cliActor().id, "cli:<user>")
  const baseEnv = {
    MONGODB_URI: uri,
    CANOPY_DB: names.app,
    CANOPY_META_DB: names.meta,
    CANOPY_AUTH_DB: names.auth,
  }
  await using client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
  const meta = client.db(names.meta)
  const auth = client.db(names.auth)
  const app = client.db(names.app)
  const different: string[] = []
  try {
    await client.connect()
    await cp(join(dir, "fixture"), project, { recursive: true })
    await app
      .collection<{ _id: string; ownerId: string; title: string }>("notes")
      .insertOne({ _id: "fixture", ownerId: "alice", title: "Fixture note" })

    const steps: unknown[] = []
    async function step(
      id: string,
      exitCode: number,
      args: string[],
      options: {
        cwd?: string
        env?: Record<string, string>
        stdin?: string
        startup?: boolean
        fileInput?: { path: string; content: string }
        capture?: (stdout: string) => void
      } = {},
    ): Promise<void> {
      const cwd = options.cwd ?? "."
      const env = options.env ?? baseEnv
      const stdin = options.stdin ?? ""
      const fileInput = options.fileInput
      if (fileInput !== undefined) await writeFile(join(project, fileInput.path), fileInput.content)
      const beforeFiles = await filesOf(project)
      const beforeMeta = await documentsOf(meta)
      const beforeAuth = await documentsOf(auth)
      const execute = options.startup === true ? startup : invoke
      const result = await execute(args, join(project, cwd), env, stdin)
      if (result.exitCode !== exitCode)
        throw new Error(
          `${id}: expected exit ${exitCode}, got ${result.exitCode}\n${result.stdout}${result.stderr}`,
        )
      options.capture?.(result.stdout)
      steps.push({
        id,
        cwd,
        args: args.map(normalize),
        env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, normalize(value)])),
        stdin: normalize(stdin),
        ...(fileInput === undefined ? {} : { fileInput }),
        stdout: normalize(result.stdout),
        stderr: normalize(result.stderr),
        exitCode: result.exitCode,
        files: changes(beforeFiles, await filesOf(project), normalize),
        meta: changes(beforeMeta, await documentsOf(meta), normalize, true),
        auth: changes(beforeAuth, await documentsOf(auth), normalize, true),
      })
    }

    await step("help", 0, ["--help"])
    await step("version", 0, ["--version"])
    await step("no-command", 1, [])
    await step("unknown-command", 1, ["policies", "lnt"])
    await step("unknown-flag", 1, ["config", "print", "--sourcs"])
    await step("missing-config", 1, ["config", "print", "--config", "missing.ts"])
    await step("init", 0, ["init", "--mongodb-uri", uri, "--database", names.app], { cwd: "init" })
    await step("init-again", 0, ["init"], { cwd: "init" })
    await step("doctor", 0, ["doctor"])
    await step("doctor-unreachable", 1, ["doctor"], {
      env: { ...baseEnv, MONGODB_URI: "mongodb://127.0.0.1:1/" },
    })
    await step("config-print", 0, ["config", "print", "--sources"])
    await step("lint", 0, ["policies", "lint"])
    await step("invalid-policy", 1, ["policies", "lint", "--dir", "invalid"])
    await step("policy-test", 0, ["policies", "test", "--mongodb-uri", uri])
    await step("policy-explain", 0, ["policies", "explain", "notes", "--as", '{"sub":"alice"}'])
    await step("push-unmigrated", 1, ["policies", "push"])
    await step("migration-pending", 0, ["migrate", "--status"])
    await step("migrate", 0, ["migrate"])
    await step("migration-applied", 0, ["migrate", "--status"])
    await step("policy-drift", 1, ["policies", "diff", "--fail-on-drift"])
    await step("push-dry-run", 0, ["policies", "push", "--dry-run"])
    await step("push", 0, ["policies", "push", "--expect-version", "0", "--comment", "initial"])
    await step("policy-diff", 0, ["policies", "diff"])
    const policy = join(project, "policies", "notes.ts")
    const revised = (await readFile(policy, "utf8"))
      .replaceAll("\r\n", "\n")
      .replace('named("read own")', 'named("owner read")')
    await step("push-conflict", 1, ["policies", "push", "--expect-version", "0"], {
      fileInput: { path: "policies/notes.ts", content: revised },
    })
    await step("push-update", 0, ["policies", "push", "--expect-version", "1"])
    await step("policy-history", 0, ["policies", "history", "notes"])
    await step("policy-rollback-refused", 1, ["policies", "rollback", "notes", "1"])
    await step("policy-rollback", 0, ["policies", "rollback", "notes", "1", "--yes"])
    await step("policy-pull", 0, ["policies", "pull", "--dir", "pulled-policies"])
    await step("schema-diff", 1, ["schema", "diff", "--file", "fixture.schema.ts"])
    await step("schema-push-refused", 1, ["schema", "push", "--file", "fixture.schema.ts"])
    await step("schema-push", 0, ["schema", "push", "--file", "fixture.schema.ts", "--yes"])
    await step("pull-typescript", 0, ["pull", "--out", "pulled.schema.ts"])
    await step("pull-javascript", 0, ["pull", "--js", "--out", "pulled.schema.js"])
    await step("realtime-enable", 0, ["realtime", "enable-images", "notes", "--yes"])
    await step("realtime-disable", 0, ["realtime", "disable-images", "notes", "--yes"])
    await step("indexes-advise", 0, ["indexes", "advise"])
    await step("indexes-create", 0, ["indexes", "create", "--yes"])
    let keyId = ""
    await step("key-create", 0, ["keys", "create", "--kind", "secret", "--name", "fixture"], {
      capture(stdout) {
        keyId = stdout.split(" ")[0] ?? ""
        const key = stdout.split("\n")[1]
        if (keyId === "" || key === undefined) throw new Error("Missing generated API key")
        bind(keyId, "<key-id>")
        bind(key, "<key>")
        bind(hashApiKey(key), "<key-hash>")
        bind(apiKeyDisplayPrefix(key), "<key-prefix>")
      },
    })
    await step("key-list", 0, ["keys", "list"])
    await step("key-revoke", 0, ["keys", "revoke", keyId, "--yes"])
    await step(
      "admin-create",
      0,
      ["admin", "create", "--email", "admin@example.test", "--role", "viewer"],
      {
        capture(stdout) {
          const password = /Temporary password: (\S+)/.exec(stdout)?.[1]
          if (password === undefined) throw new Error("Missing temporary password")
          bind(password, "<temporary-password>")
        },
      },
    )
    await step("admin-list", 0, ["admin", "list"])
    await step("admin-reset-totp", 0, ["admin", "reset-totp", "admin@example.test", "--yes"])
    await step("auth-import-dry-run", 0, [
      "auth",
      "import",
      "users.csv",
      "--from",
      "csv",
      "--dry-run",
    ])
    await step("login-help", 0, ["login", "--help"])
    await step("logout-help", 0, ["logout", "--help"])
    await step("login-refused", 1, ["login", "http://example.test"])
    await step("logout-refused", 1, ["logout"])
    await step("dev-bad-port", 1, ["dev", "--port", "99999"])
    await step("dev-missing-config", 1, ["dev", "--config", "missing.ts"])
    await step("dev-startup", 0, ["dev", "--port", "0"], {
      startup: true,
      capture(stdout) {
        const address = /http:\/\/(localhost:\d+)\/rest\/v1/.exec(stdout)?.[1]
        if (address === undefined) throw new Error("Missing dev listening port")
        bind(address, "localhost:<port>")
        const token = /setup token (\S+)/.exec(stdout)?.[1]
        if (token === undefined) throw new Error("Missing dev setup token")
        bind(token, "<setup-token>")
        bind(createHash("sha256").update(token).digest("hex"), "<setup-token-hash>")
      },
    })

    await remote(client, uri, names, async (url, token) => {
      bind(url, "<admin-url>")
      bind(token, "<session-token>")
      bind(createHash("sha256").update(token).digest("hex"), "<session-token-hash>")
      const env = { ...baseEnv, CANOPY_ADMIN_URL: url, CANOPY_ADMIN_TOKEN: token }
      await step("login-token-refused", 1, ["login", url], { stdin: "fixture-invalid-token\n" })
      await step(
        "auth-import",
        0,
        ["auth", "import", "users.csv", "--from", "csv", "--env", "development"],
        { env },
      )
      let id = ""
      await step(
        "admin-token-create",
        0,
        ["admin", "tokens", "create", "--env", "development", "--name", "fixture"],
        {
          env,
          capture(stdout) {
            const secret = /canopy_pat_\S+/.exec(stdout)?.[0]
            id = /^([^\s]+) {2}admin {2}"fixture"/m.exec(stdout)?.[1] ?? ""
            if (secret === undefined || id === "")
              throw new Error(`Missing generated admin token: ${stdout}`)
            bind(secret, "<admin-token>")
            bind(secret.slice(0, "canopy_pat_".length + 6), "<admin-token-prefix>")
            bind(createHash("sha256").update(secret).digest("hex"), "<admin-token-hash>")
            bind(id, "<admin-token-id>")
          },
        },
      )
      await step("admin-token-list", 0, ["admin", "tokens", "list", "--env", "development"], {
        env,
      })
      await step(
        "admin-token-revoke",
        0,
        ["admin", "tokens", "revoke", id, "--env", "development", "--yes"],
        { env },
      )
    })

    const types = generateTypes(await loadCollectionSchemas({ database: names.app }, client))
    const typeGeneration = {
      entryPoint: "@canopy/schema.generateTypes",
      schema: "notes after schema-push",
      types,
    }
    const content = `${JSON.stringify({ steps, typeGeneration }, null, 2)
      .replaceAll("\u2013", "\\u2013")
      .replaceAll("\u2014", "\\u2014")
      .replaceAll(" \u002d ", " \\u002d ")}\n`
    const path = join(dir, "vectors.json")
    if (!check) await writeFile(path, content)
    else {
      const saved = await readFile(path, "utf8")
      if (saved !== content) {
        const expected = JSON.parse(saved) as { steps: unknown[] }
        const actual = JSON.parse(content) as { steps: { id: string }[] }
        actual.steps.forEach((item, index) => {
          const want = JSON.stringify(expected.steps[index], null, 1).split("\n")
          const got = JSON.stringify(item, null, 1).split("\n")
          const line = got.findIndex((text, at) => text !== want[at])
          if (line >= 0)
            different.push(`${item.id}: ${want[line]?.trim()} became ${got[line]?.trim()}`)
        })
        if (different.length === 0) different.push("vectors.json")
      }
    }
  } finally {
    await Promise.all([
      app.dropDatabase(),
      meta.dropDatabase(),
      auth.dropDatabase(),
      rm(project, { recursive: true, force: true }),
    ])
  }
  return different
}
