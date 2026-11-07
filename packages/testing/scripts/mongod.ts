/**
 * Downloads the official MongoDB server binaries for this host, starts a single node replica set in the
 * background and waits until it is writable. CI uses it on Windows and macOS runners, which cannot run the
 * Linux image of `deploy/compose/dev.yaml`; it works on Linux too. Run it with Bun or Node 24+:
 *
 *   bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir <folder> [--port 27017]
 *
 * Prints the connection string on success. The server keeps running after the script exits.
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { MongoClient } from "mongodb"

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage: mongod.ts --version <x.y.z> --dir <folder> [--port <port>]\n`,
  )
  process.exit(1)
}

function parse(argv: readonly string[]): { version: string; dir: string; port: number } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === undefined || !name.startsWith("--") || value === undefined)
      usage(`Unexpected argument ${name ?? ""}`)
    values.set(name.slice(2), value)
  }
  const version = values.get("version") ?? usage("--version is required")
  if (!/^\d+\.\d+\.\d+$/.test(version)) usage(`${version} is not a MongoDB version`)
  const dir = resolve(values.get("dir") ?? usage("--dir is required"))
  const port = Number(values.get("port") ?? "27017")
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage("--port must be a TCP port")
  return { version, dir, port }
}

/** The download URL of the server archive for this OS and CPU, from fastdl.mongodb.org. */
function archiveUrl(version: string): string {
  const base = "https://fastdl.mongodb.org"
  const x64 = process.arch === "x64"
  if (process.platform === "win32") return `${base}/windows/mongodb-windows-x86_64-${version}.zip`
  if (process.platform === "darwin")
    return `${base}/osx/mongodb-macos-${x64 ? "x86_64" : "arm64"}-${version}.tgz`
  if (process.platform === "linux")
    return `${base}/linux/mongodb-linux-${x64 ? "x86_64" : "aarch64"}-ubuntu2404-${version}.tgz`
  usage(`No MongoDB build for ${process.platform}`)
}

function findMongod(dir: string): string {
  const name = process.platform === "win32" ? "mongod.exe" : "mongod"
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(dir, entry.name, "bin", name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`No ${name} in ${dir}`)
}

async function download(url: string, dir: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  const archive = join(dir, url.slice(url.lastIndexOf("/") + 1))
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()))
  // bsdtar ships with Windows 10 and later and also reads zip archives.
  const tar =
    process.platform === "win32"
      ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
      : "tar"
  execFileSync(tar, ["-xf", archive, "-C", dir], { stdio: "inherit" })
  return findMongod(dir)
}

async function waitFor<T>(what: string, attempt: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now()
  let last: unknown
  while (Date.now() - started < 300_000) {
    try {
      const value = await attempt()
      if (value !== undefined) return value
    } catch (error: unknown) {
      last = error
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  const reason = last instanceof Error ? last.message : String(last)
  throw new Error(
    `Timed out after ${Math.round((Date.now() - started) / 1000)} s waiting for ${what}: ${reason}`,
  )
}

async function main(): Promise<void> {
  const { version, dir, port } = parse(process.argv.slice(2))
  const data = join(dir, "data")
  mkdirSync(data, { recursive: true })
  const mongod = await download(archiveUrl(version), dir)
  const log = join(dir, "mongod.log")
  const output = openSync(join(dir, "mongod.out"), "a")
  const child = spawn(
    mongod,
    [
      "--replSet",
      "rs0",
      "--port",
      String(port),
      "--ipv6",
      "--bind_ip",
      "127.0.0.1,::1",
      "--dbpath",
      data,
      "--logpath",
      log,
    ],
    { detached: true, stdio: ["ignore", output, output] },
  )
  child.unref()
  let exited: number | null | undefined
  child.once("exit", (code) => {
    exited = code
  })

  const connect = () =>
    new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
      serverSelectionTimeoutMS: 2_000,
    })
  // A client whose first connection attempt failed stays closed, so each attempt gets a new one.
  const client = await waitFor("mongod to accept connections", async () => {
    if (exited !== undefined) throw new Error(`mongod exited with ${exited}; see ${log}`)
    const attempt = connect()
    try {
      await attempt.db("admin").command({ ping: 1 })
      return attempt
    } catch (error: unknown) {
      await attempt.close()
      throw error
    }
  })
  try {
    await client.db("admin").command({
      replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `localhost:${port}` }] },
    })
    await waitFor("the replica set to elect a primary", async () => {
      const hello = await client.db("admin").command({ hello: 1 })
      return hello["isWritablePrimary"] === true ? true : undefined
    })
  } finally {
    await client.close()
  }
  process.stdout.write(`mongodb://localhost:${port}/?replicaSet=rs0\n`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exit(1)
  },
)
