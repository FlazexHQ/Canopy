import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { waitForPrimary } from "./local-mongo.ts"

/** The MongoDB version `canopy dev --with-mongo` downloads when Docker is not available. */
export const DEFAULT_MONGO_VERSION = "8.0.34"

/** Where downloaded MongoDB builds are kept, shared by every project of this user. */
export function mongoCacheDir(env: Readonly<Record<string, string | undefined>>): string {
  if (env["CANOPY_MONGO_CACHE"] !== undefined && env["CANOPY_MONGO_CACHE"] !== "")
    return resolve(env["CANOPY_MONGO_CACHE"])
  if (process.platform === "win32")
    return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "canopy", "mongodb")
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Caches", "canopy", "mongodb")
  return join(env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "canopy", "mongodb")
}

/**
 * The download URL of the official server build for a platform and CPU, from fastdl.mongodb.org. Linux
 * uses the Ubuntu 24.04 build, which runs on current glibc distributions; musl (Alpine) has none.
 */
export function mongoArchiveUrl(version: string, platform: string, arch: string): string {
  const base = "https://fastdl.mongodb.org"
  const x64 = arch === "x64"
  if (platform === "win32") {
    if (!x64) throw unsupported(platform, arch)
    return `${base}/windows/mongodb-windows-x86_64-${version}.zip`
  }
  if (platform === "darwin")
    return `${base}/osx/mongodb-macos-${x64 ? "x86_64" : "arm64"}-${version}.tgz`
  if (platform === "linux" && (x64 || arch === "arm64"))
    return `${base}/linux/mongodb-linux-${x64 ? "x86_64" : "aarch64"}-ubuntu2404-${version}.tgz`
  throw unsupported(platform, arch)
}

function unsupported(platform: string, arch: string): CanopyError {
  return new CanopyError(
    ErrorCode.Unavailable,
    `MongoDB publishes no server build for ${platform} ${arch}; run MongoDB yourself and set MONGODB_URI`,
  )
}

/** The `mongod` arguments of a single node replica set on the loopback interface. */
export function mongodArgs(port: number, dataDir: string, logPath: string): string[] {
  return [
    "--replSet",
    "rs0",
    "--port",
    String(port),
    "--ipv6",
    "--bind_ip",
    "127.0.0.1,::1",
    "--dbpath",
    dataDir,
    "--logpath",
    logPath,
    "--logappend",
  ]
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

function extract(archive: string, into: string): Promise<void> {
  // bsdtar ships with Windows 10 and later and reads zip archives too.
  const tar =
    process.platform === "win32"
      ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
      : "tar"
  return new Promise((done, fail) => {
    execFile(tar, ["-xf", archive, "-C", into], (error) => (error === null ? done() : fail(error)))
  })
}

/** Options of {@link installMongod}. */
export interface InstallOptions {
  readonly version: string
  readonly cacheDir: string
  readonly fetch?: typeof fetch
  readonly log?: (line: string) => void
}

/** Returns the path of `mongod` for `version`, downloading and unpacking the official build once. */
export async function installMongod(options: InstallOptions): Promise<string> {
  const target = join(options.cacheDir, options.version)
  const installed = findMongod(target)
  if (installed !== undefined) return installed
  const url = mongoArchiveUrl(options.version, process.platform, process.arch)
  options.log?.(`Downloading MongoDB ${options.version} from ${url} (once, into ${target})`)
  const response = await (options.fetch ?? fetch)(url)
  if (!response.ok)
    throw new CanopyError(ErrorCode.Unavailable, `GET ${url} answered ${response.status}`)
  const staging = `${target}.partial`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const archive = join(staging, url.slice(url.lastIndexOf("/") + 1))
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()))
  await extract(archive, staging)
  rmSync(archive)
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  const mongod = findMongod(target)
  if (mongod === undefined)
    throw new CanopyError(ErrorCode.Internal, `The archive from ${url} has no mongod`)
  return mongod
}

/** Options of {@link startBinaryMongo}. */
export interface BinaryMongoOptions {
  /** The project root; data lives in `.canopy/mongodb` below it. */
  readonly projectDir: string
  readonly port: number
  readonly database: string
  readonly version?: string
  readonly cacheDir: string
  /** An existing `mongod` to run instead of a downloaded one. */
  readonly mongod?: string
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

/** A `mongod` started by {@link startBinaryMongo}. */
export interface RunningMongo {
  readonly uri: string
  /** Stops `mongod` and waits for it to exit. */
  stop(): Promise<void>
}

/**
 * Starts a single node replica set from the official binaries as a child process, with its data in the
 * project's `.canopy/mongodb` folder, and waits until it is the writable primary. The server stops with
 * {@link RunningMongo.stop}, or with this process.
 */
export async function startBinaryMongo(options: BinaryMongoOptions): Promise<RunningMongo> {
  const mongod =
    options.mongod ??
    (await installMongod({
      version: options.version ?? DEFAULT_MONGO_VERSION,
      cacheDir: options.cacheDir,
      ...(options.log === undefined ? {} : { log: options.log }),
    }))
  const home = join(resolve(options.projectDir), ".canopy", "mongodb")
  const data = join(home, "data")
  mkdirSync(data, { recursive: true })
  const logPath = join(home, "mongod.log")
  options.log?.(`Starting mongod on port ${options.port}, data in ${data}, log in ${logPath}`)
  const child: ChildProcess = spawn(mongod, mongodArgs(options.port, data, logPath), {
    stdio: "ignore",
    windowsHide: true,
  })
  let exited: number | null | undefined
  const exit = new Promise<void>((done) => {
    child.once("exit", (code) => {
      exited = code
      done()
    })
    child.once("error", () => {
      exited = -1
      done()
    })
  })
  const stop = async (): Promise<void> => {
    if (exited !== undefined) return
    child.kill()
    await Promise.race([exit, new Promise((done) => setTimeout(done, 10_000))])
    if (exited === undefined) {
      child.kill("SIGKILL")
      await exit
    }
  }
  try {
    await Promise.race([
      waitForPrimary(
        `mongodb://127.0.0.1:${options.port}/`,
        options.port,
        options.timeoutMs ?? 60_000,
      ),
      exit.then(() => {
        throw new CanopyError(
          ErrorCode.Unavailable,
          `mongod exited with code ${String(exited)} before it was ready; see ${logPath}`,
        )
      }),
    ])
  } catch (error: unknown) {
    await stop()
    throw error
  }
  return {
    uri: `mongodb://localhost:${options.port}/${options.database}?replicaSet=rs0`,
    stop,
  }
}
