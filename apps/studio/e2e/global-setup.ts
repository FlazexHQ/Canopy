import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MongoClient } from "mongodb"

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/** The app collection the tests browse, edit and write policies for. */
export const TODOS = [
  { _id: "todo_1", title: "Buy milk", ownerId: "user_alice", done: false },
  { _id: "todo_2", title: "Walk the dog", ownerId: "user_alice", done: true },
  { _id: "todo_3", title: "File taxes", ownerId: "user_bob", done: false },
]

function waitForToken(child: ChildProcess, log: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = ""
    const timer = setTimeout(
      () => reject(new Error(`canopy-server did not print a setup token:\n${log.join("")}`)),
      60_000,
    )
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      log.push(text)
      buffered += text
      const match = /canopy_setup_[A-Za-z0-9_-]+/.exec(buffered)
      if (match !== null && buffered.includes("canopy listening")) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`canopy-server exited with ${code}:\n${log.join("")}`))
    })
  })
}

/**
 * Seeds a fresh database and starts `canopy-server` from source with built in auth and policies stored in
 * the meta database. The setup token it prints reaches the tests through `STUDIO_E2E_SETUP_TOKEN`.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  const uri = process.env["CANOPY_TEST_MONGODB_URI"]
  if (uri === undefined) return undefined
  if (process.env["CANOPY_SPLIT_E2E_URL"]) {
    const database = process.env["CANOPY_DB"] ?? "app"
    await using mongo = new MongoClient(uri)
    await mongo.db(database).collection<{ _id: string }>("todos").insertMany(TODOS)
    process.env["STUDIO_E2E_DATABASE"] = database
    return undefined
  }
  if (!existsSync(here("../../../packages/studio/app/index.html")))
    throw new Error("Studio is not built. Run `bun --filter @canopy/studio-app build` first.")
  const port = process.env["STUDIO_E2E_PORT"] ?? "4410"
  const database = `studio_e2e_${process.env["STUDIO_E2E_RUN"] ?? "local"}`
  const mongo = new MongoClient(uri)
  await mongo.connect()
  for (const name of [database, `${database}_meta`, `${database}_auth`])
    await mongo.db(name).dropDatabase()
  await mongo.db(database).collection<{ _id: string }>("todos").insertMany(TODOS)
  await mongo.close()

  const log: string[] = []
  const child = spawn(
    process.execPath,
    [
      "--conditions=@canopy/source",
      here("../../../packages/server/src/bin/canopy-server.ts"),
      "--config",
      here("./canopy.config.ts"),
    ],
    {
      env: {
        ...process.env,
        MONGODB_URI: uri,
        CANOPY_DB: database,
        CANOPY_META_DB: `${database}_meta`,
        CANOPY_AUTH_DB: `${database}_auth`,
        CANOPY_ENV: "development",
        CANOPY_PUBLISHABLE_KEYS: "pk_studio_e2e",
        CANOPY_MASTER_KEY: "studio-e2e-master-key-0123456789abcdef",
        CANOPY_PUBLIC_URL: `http://127.0.0.1:${port}`,
        PORT: port,
        METRICS_PORT: String(Number(port) + 1),
        CANOPY_LOG_LEVEL: "info",
      },
      stdio: ["ignore", "inherit", "pipe"],
    },
  )
  process.env["STUDIO_E2E_SETUP_TOKEN"] = await waitForToken(child, log)
  process.env["STUDIO_E2E_DATABASE"] = database
  child.stderr?.on("data", (chunk: Buffer) => {
    if (process.env["STUDIO_E2E_SERVER_LOG"] === "1") process.stderr.write(chunk)
  })
  return async () => {
    if (child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}
