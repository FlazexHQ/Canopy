/**
 * Downloads the official MongoDB server binaries for this host, starts a single node replica set in the
 * background and waits until it is writable. CI uses it on Windows and macOS runners, which cannot run the
 * Linux image of `deploy/compose/dev.yaml`; it works on Linux too. Run it with Bun or Node 24+:
 *
 *   bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir <folder> [--port 27017]
 *
 * The binaries go to `<folder>/binaries/<version>`, and a later run with the same version reuses them instead
 * of downloading again (CI caches that folder alone). The data, `mongod.log` and `mongod.pid` (the process
 * id of the server) go to `<folder>`; a run over the data of an earlier one restarts that replica set.
 * Prints the connection string on success. The server keeps running after the script exits. Its storage cache
 * is capped at 1 GB, which a test replica set never fills, so the server leaves memory to the test processes.
 */
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { MongoClient, MongoServerError } from "mongodb"

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

function findMongod(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const name = process.platform === "win32" ? "mongod.exe" : "mongod"
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(dir, entry.name, "bin", name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Whether `mongod --version` runs and reports exactly `version`. */
function reports(mongod: string, version: string): boolean {
  try {
    const output = execFileSync(mongod, ["--version"], { encoding: "utf8", timeout: 60_000 })
    return output.split(/\r?\n/).includes(`db version v${version}`)
  } catch {
    return false
  }
}

/**
 * Extracts a verified ZIP or gzipped tar archive without keeping Windows debug symbols. The archiver skips
 * them where it honors `--exclude` (bsdtar, GNU tar); BusyBox tar unpacks them anyway, so they are removed
 * afterwards.
 */
export function extract(archive: string, staging: string): void {
  const tar =
    process.platform === "win32"
      ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
      : "tar"
  execFileSync(tar, ["-xf", archive, "-C", staging, "--exclude", "*.pdb"], { stdio: "inherit" })
  for (const entry of readdirSync(staging, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdb"))
      rmSync(join(entry.parentPath, entry.name))
}

/**
 * Returns the path of `mongod` for `version` under `binaries/<version>`, reusing what an earlier run unpacked
 * there when it runs and reports that version, and downloading the official build otherwise. The archive is
 * unpacked into a staging folder first, so an interrupted run never leaves a folder that looks complete.
 */
async function install(version: string, dir: string): Promise<string> {
  const target = join(dir, "binaries", version)
  const cached = findMongod(target)
  if (cached !== undefined && reports(cached, version)) {
    process.stderr.write(`Reusing MongoDB ${version} from ${target}\n`)
    return cached
  }
  const url = archiveUrl(version)
  process.stderr.write(`Downloading MongoDB ${version} from ${url}\n`)
  const checksum = await fetch(`${url}.sha256`, { redirect: "error" })
  if (!checksum.ok) throw new Error(`MongoDB checksum request answered ${checksum.status}`)
  const expected = (await checksum.text()).trim().split(/\s+/)[0]
  if (expected === undefined || !/^[0-9a-f]{64}$/i.test(expected))
    throw new Error("Invalid MongoDB archive checksum")
  const response = await fetch(url, { redirect: "error" })
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  if (createHash("sha256").update(archive).digest("hex") !== expected.toLowerCase())
    throw new Error(`MongoDB archive checksum does not match for ${version}`)
  const staging = `${target}.partial`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const archivePath = join(staging, process.platform === "win32" ? "mongodb.zip" : "mongodb.tgz")
  writeFileSync(archivePath, archive)
  extract(archivePath, staging)
  rmSync(archivePath)
  const mongod = findMongod(staging)
  if (mongod === undefined) throw new Error(`The archive from ${url} has no mongod`)
  if (!reports(mongod, version)) throw new Error(`${mongod} does not report version ${version}`)
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  return join(target, relative(staging, mongod))
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
  const mongod = await install(version, dir)
  const log = join(dir, "mongod.log")
  const output = openSync(join(dir, "mongod.out"), "a")
  const args = [
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
    "--wiredTigerCacheSizeGB",
    "1",
    "--setParameter",
    "enableTestCommands=1",
    "--setParameter",
    "wiredTigerFileHandleCloseIdleTime=30",
    "--setParameter",
    "wiredTigerFileHandleCloseMinimum=250",
  ]
  // macOS starts processes with a soft limit of 256 open files, which a test run that creates many
  // databases exhausts, so the server starts from a shell that raises its own limit first.
  const child =
    process.platform === "win32"
      ? spawn(mongod, args, { detached: true, stdio: ["ignore", output, output] })
      : spawn(
          "/bin/sh",
          [
            "-c",
            'ulimit -n 64000 2>/dev/null || ulimit -n 24576 2>/dev/null || ulimit -n 10240 2>/dev/null; exec "$0" "$@"',
            mongod,
            ...args,
          ],
          { detached: true, stdio: ["ignore", output, output] },
        )
  child.unref()
  if (child.pid !== undefined) writeFileSync(join(dir, "mongod.pid"), `${child.pid}\n`)
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
    try {
      await client.db("admin").command({
        replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `localhost:${port}` }] },
      })
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError && error.codeName === "AlreadyInitialized"))
        throw error
    }
    await waitFor("the replica set to elect a primary", async () => {
      const hello = await client.db("admin").command({ hello: 1 })
      return hello["isWritablePrimary"] === true ? true : undefined
    })
  } finally {
    await client.close()
  }
  process.stdout.write(`mongodb://localhost:${port}/?replicaSet=rs0\n`)
}

if (
  import.meta.main ??
  (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exit(1)
    },
  )
}
