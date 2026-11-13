import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { MongoClient, MongoServerError } from "mongodb"
import { messageOf } from "./output.ts"

/** The result of one `docker` invocation. */
export interface DockerResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs `docker` with arguments. Injected so tests can observe the calls. */
type DockerRunner = (args: readonly string[]) => Promise<DockerResult>

/** Runs the real `docker` binary. */
const docker: DockerRunner = (args) =>
  new Promise((done) => {
    execFile("docker", [...args], { timeout: 600_000 }, (error, stdout, stderr) => {
      const code =
        error === null
          ? 0
          : typeof error.code === "number"
            ? error.code
            : error.code === "ENOENT"
              ? 127
              : 1
      done({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

/** The official MongoDB Community image `canopy dev --with-mongo` runs by default. */
export const DEFAULT_MONGO_IMAGE = "mongodb/mongodb-community-server:8.0-ubi9"

/** Options of {@link startLocalMongo}. */
export interface LocalMongoOptions {
  /** The project root; the container and volume names derive from it. */
  readonly projectDir: string
  /** The host port, also used inside the container so the replica set member name works on both sides. */
  readonly port: number
  readonly database: string
  readonly image?: string
  readonly docker?: DockerRunner
  /** How long to wait for the replica set to elect a primary. */
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

/** The container name of a project: stable per directory, readable, and unique across projects. */
export function containerName(projectDir: string): string {
  const root = resolve(projectDir)
  const slug =
    basename(root)
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "project"
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8)
  return `canopy-dev-${slug}-${hash}`
}

/** The `docker run` arguments of a single node replica set with a named volume for its data. */
export function dockerRunArgs(name: string, port: number, image: string): string[] {
  return [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    "dev.canopy.role=mongo",
    "--publish",
    `127.0.0.1:${port}:${port}`,
    "--volume",
    `${name}-data:/data/db`,
    image,
    "--replSet",
    "rs0",
    "--bind_ip_all",
    "--port",
    String(port),
  ]
}

/** The replica set config of the single member, reachable as `localhost:<port>` inside and outside. */
export function replicaSetConfig(port: number): Record<string, unknown> {
  return { _id: "rs0", members: [{ _id: 0, host: `localhost:${port}` }] }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Waits until the server at `uri` (a direct connection) is the writable primary of a replica set,
 * initiating a single member set the first time. Throws after `timeoutMs`.
 */
export async function waitForPrimary(uri: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = "not reachable"
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, {
      directConnection: true,
      serverSelectionTimeoutMS: 1000,
      connectTimeoutMS: 1000,
    })
    try {
      await client.connect()
      const admin = client.db("admin")
      const hello = await admin.command({ hello: 1 })
      if (hello["isWritablePrimary"] === true && typeof hello["setName"] === "string") return
      if (typeof hello["setName"] !== "string") {
        try {
          await admin.command({ replSetInitiate: replicaSetConfig(port) })
        } catch (error: unknown) {
          if (!(error instanceof MongoServerError && error.codeName === "AlreadyInitialized"))
            throw error
        }
      }
      last = "waiting for the primary"
    } catch (error: unknown) {
      last = messageOf(error)
    } finally {
      await client.close()
    }
    await sleep(500)
  }
  throw new CanopyError(
    ErrorCode.Unavailable,
    `MongoDB did not become a writable primary within ${timeoutMs} ms: ${last}`,
  )
}

/**
 * Starts (or reuses) a single node replica set in Docker from the official MongoDB Community image, with
 * a named volume so the data survives restarts, waits until it is healthy, and returns its connection
 * string with `database` as the app database.
 */
export async function startLocalMongo(options: LocalMongoOptions): Promise<string> {
  const run = options.docker ?? docker
  const log = options.log ?? (() => {})
  const name = containerName(options.projectDir)
  const image = options.image ?? DEFAULT_MONGO_IMAGE
  const state = await run(["inspect", "--format", "{{.State.Running}}", name])
  if (state.code === 127)
    throw new CanopyError(
      ErrorCode.Unavailable,
      "docker is not installed or not on PATH; --with-mongo needs Docker",
    )
  if (state.code !== 0) {
    log(
      `Starting ${image} as ${name}, data in the volume ${name}-data (the first run pulls the image)`,
    )
    const started = await run(dockerRunArgs(name, options.port, image))
    if (started.code !== 0)
      throw new CanopyError(
        ErrorCode.Unavailable,
        `docker run failed: ${started.stderr.trim() || started.stdout.trim()}`,
      )
  } else if (state.stdout.trim() !== "true") {
    log(`Starting the existing container ${name}`)
    const started = await run(["start", name])
    if (started.code !== 0)
      throw new CanopyError(
        ErrorCode.Unavailable,
        `docker start failed: ${started.stderr.trim() || started.stdout.trim()}`,
      )
  } else {
    log(`Reusing the running container ${name}`)
  }
  await waitForPrimary(
    `mongodb://localhost:${options.port}/`,
    options.port,
    options.timeoutMs ?? 60_000,
  )
  return `mongodb://localhost:${options.port}/${options.database}?replicaSet=rs0`
}
