import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MongoClient } from "mongodb"
import { afterAll, describe, expect, it } from "vitest"
import { dockerAvailable } from "../src/local-mongo.ts"
import {
  installMongod,
  mongoArchiveUrl,
  mongoCacheDir,
  mongodArgs,
  startBinaryMongo,
} from "../src/mongod-binary.ts"

const folders: string[] = []
afterAll(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "canopy-mongod-"))
  folders.push(path)
  return path
}

describe("MongoDB from the official binaries", () => {
  it("picks the official build for each platform and CPU", () => {
    expect(mongoArchiveUrl("8.0.34", "win32", "x64")).toBe(
      "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.34.zip",
    )
    expect(mongoArchiveUrl("8.0.34", "darwin", "arm64")).toBe(
      "https://fastdl.mongodb.org/osx/mongodb-macos-arm64-8.0.34.tgz",
    )
    expect(mongoArchiveUrl("8.0.34", "darwin", "x64")).toBe(
      "https://fastdl.mongodb.org/osx/mongodb-macos-x86_64-8.0.34.tgz",
    )
    expect(mongoArchiveUrl("8.0.34", "linux", "arm64")).toBe(
      "https://fastdl.mongodb.org/linux/mongodb-linux-aarch64-ubuntu2404-8.0.34.tgz",
    )
    expect(() => mongoArchiveUrl("8.0.34", "win32", "arm64")).toThrow(/no server build/)
    expect(() => mongoArchiveUrl("8.0.34", "freebsd", "x64")).toThrow(/MONGODB_URI/)
  })

  it("runs a replica set on the loopback addresses only", () => {
    const args = mongodArgs(27999, "/data", "/log/mongod.log")
    expect(args).toEqual(expect.arrayContaining(["--replSet", "rs0", "--port", "27999"]))
    expect(args[args.indexOf("--bind_ip") + 1]).toBe("127.0.0.1,::1")
    expect(args).not.toContain("--bind_ip_all")
  })

  it("keeps the cache per user, overridable with CANOPY_MONGO_CACHE", () => {
    expect(mongoCacheDir({ CANOPY_MONGO_CACHE: "/tmp/mongo-cache" })).toMatch(/mongo-cache$/)
    expect(
      mongoCacheDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", XDG_CACHE_HOME: "/xdg" }),
    ).toMatch(/canopy[\\/]mongodb$/)
  })

  it("downloads and unpacks the build once, then reuses it", async () => {
    const root = await folder()
    const name = process.platform === "win32" ? "mongod.exe" : "mongod"
    const source = join(root, "source")
    await mkdir(join(source, "mongodb-fake", "bin"), { recursive: true })
    await writeFile(join(source, "mongodb-fake", "bin", name), "not really mongod")
    const url = mongoArchiveUrl("1.2.3", process.platform, process.arch)
    const archive = join(root, url.slice(url.lastIndexOf("/") + 1))
    const tar =
      process.platform === "win32"
        ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
        : "tar"
    execFileSync(tar, ["-a", "-cf", archive, "-C", source, "mongodb-fake"])
    const requested: string[] = []
    const fakeFetch = (async (input: string | URL | Request) => {
      requested.push(String(input))
      const { readFile } = await import("node:fs/promises")
      return new Response(new Uint8Array(await readFile(archive)))
    }) as typeof fetch
    const cacheDir = join(root, "cache")
    const first = await installMongod({ version: "1.2.3", cacheDir, fetch: fakeFetch })
    expect(first).toBe(join(cacheDir, "1.2.3", "mongodb-fake", "bin", name))
    expect(existsSync(first)).toBe(true)
    const second = await installMongod({ version: "1.2.3", cacheDir, fetch: fakeFetch })
    expect(second).toBe(first)
    expect(requested).toEqual([url])
    expect(existsSync(join(cacheDir, "1.2.3.partial"))).toBe(false)
  })

  it("reports a failed download without leaving a half installed build", async () => {
    const cacheDir = join(await folder(), "cache")
    const failing = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch
    await expect(installMongod({ version: "9.9.9", cacheDir, fetch: failing })).rejects.toThrow(
      /answered 404/,
    )
    expect(existsSync(join(cacheDir, "9.9.9"))).toBe(false)
  })

  it("probes Docker without failing when it is absent", async () => {
    const absent = await dockerAvailable(async () => ({ code: 127, stdout: "", stderr: "" }))
    const stopped = await dockerAvailable(async () => ({ code: 1, stdout: "", stderr: "daemon" }))
    const running = await dockerAvailable(async () => ({ code: 0, stdout: "27.1.1\n", stderr: "" }))
    expect([absent, stopped, running]).toEqual([false, false, true])
  })

  const mongod = process.env["CANOPY_TEST_MONGOD"]
  const withMongod = mongod === undefined || mongod === "" ? it.skip : it

  withMongod(
    "starts a writable replica set with its data in the project and stops it",
    async () => {
      const project = await folder()
      const port = await new Promise<number>((done) => {
        const probe = createServer().listen(0, "127.0.0.1", () => {
          const address = probe.address()
          probe.close(() =>
            done(typeof address === "object" && address !== null ? address.port : 0),
          )
        })
      })
      const running = await startBinaryMongo({
        projectDir: project,
        port,
        database: "app",
        cacheDir: join(project, "unused-cache"),
        mongod: mongod ?? "",
      })
      try {
        expect(running.uri).toBe(`mongodb://localhost:${port}/app?replicaSet=rs0`)
        const client = new MongoClient(running.uri, { serverSelectionTimeoutMS: 10_000 })
        try {
          await client
            .db()
            .collection("todos")
            .insertOne({ _id: "a" as never })
          const session = client.startSession()
          await session.withTransaction(async () => {
            await client
              .db()
              .collection("todos")
              .insertOne({ _id: "b" as never }, { session })
          })
          await session.endSession()
          expect(await client.db().collection("todos").countDocuments()).toBe(2)
        } finally {
          await client.close()
        }
        expect(existsSync(join(project, ".canopy", "mongodb", "data"))).toBe(true)
      } finally {
        await running.stop()
      }
      const after = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
        serverSelectionTimeoutMS: 1000,
      })
      await expect(after.connect()).rejects.toThrow()
      await after.close()
    },
    120_000,
  )
})
