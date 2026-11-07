import { MONGODB_URI } from "@canopy/testing"
import { describe, expect, it } from "vitest"
import {
  containerName,
  DEFAULT_MONGO_IMAGE,
  type DockerResult,
  dockerRunArgs,
  replicaSetConfig,
  startLocalMongo,
  waitForPrimary,
} from "../src/local-mongo.ts"

function fakeDocker(answers: Record<string, DockerResult>): {
  calls: string[][]
  run: (args: readonly string[]) => Promise<DockerResult>
} {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push([...args])
      return answers[args[0] ?? ""] ?? { code: 0, stdout: "", stderr: "" }
    },
  }
}

describe("canopy dev --with-mongo", () => {
  it("names containers per project directory", () => {
    const name = containerName("/home/me/My App")
    expect(name).toMatch(/^canopy-dev-my-app-[0-9a-f]{8}$/)
    expect(containerName("/home/me/My App")).toBe(name)
    expect(containerName("/other/My App")).not.toBe(name)
  })

  it("runs the official image as a single node replica set with a named volume", () => {
    expect(dockerRunArgs("c", 27018, DEFAULT_MONGO_IMAGE)).toEqual([
      "run",
      "--detach",
      "--name",
      "c",
      "--label",
      "dev.canopy.role=mongo",
      "--publish",
      "127.0.0.1:27018:27018",
      "--volume",
      "c-data:/data/db",
      "mongodb/mongodb-community-server:8.0-ubi9",
      "--replSet",
      "rs0",
      "--bind_ip_all",
      "--port",
      "27018",
    ])
    expect(replicaSetConfig(27018)).toEqual({
      _id: "rs0",
      members: [{ _id: 0, host: "localhost:27018" }],
    })
  })

  it("explains a missing docker and a failing docker run", async () => {
    const missing = fakeDocker({ inspect: { code: 127, stdout: "", stderr: "" } })
    await expect(
      startLocalMongo({ projectDir: "/p", port: 1, database: "app", docker: missing.run }),
    ).rejects.toThrow("docker is not installed")
    const failing = fakeDocker({
      inspect: { code: 1, stdout: "", stderr: "No such object" },
      run: { code: 125, stdout: "", stderr: "port is already allocated\n" },
    })
    await expect(
      startLocalMongo({ projectDir: "/p", port: 1, database: "app", docker: failing.run }),
    ).rejects.toThrow("docker run failed: port is already allocated")
  })

  it("times out when nothing becomes a primary", async () => {
    await expect(waitForPrimary("mongodb://127.0.0.1:1/", 1, 1500)).rejects.toThrow(
      "did not become a writable primary within 1500 ms",
    )
  })

  const withMongo = MONGODB_URI === undefined ? it.skip : it
  const port = Number(/^mongodb:\/\/[^/,@]*?:(\d+)/.exec(MONGODB_URI ?? "")?.[1] ?? "27017")

  withMongo("creates, starts or reuses the container, then waits for the primary", async () => {
    const created = fakeDocker({ inspect: { code: 1, stdout: "", stderr: "No such object" } })
    const uri = await startLocalMongo({
      projectDir: "/p",
      port,
      database: "app",
      docker: created.run,
    })
    expect(uri).toBe(`mongodb://localhost:${port}/app?replicaSet=rs0`)
    expect(created.calls.map((call) => call[0])).toEqual(["inspect", "run"])
    expect(created.calls[1]).toEqual(dockerRunArgs(containerName("/p"), port, DEFAULT_MONGO_IMAGE))

    const stopped = fakeDocker({ inspect: { code: 0, stdout: "false\n", stderr: "" } })
    await startLocalMongo({ projectDir: "/p", port, database: "app", docker: stopped.run })
    expect(stopped.calls.map((call) => call[0])).toEqual(["inspect", "start"])

    const running = fakeDocker({ inspect: { code: 0, stdout: "true\n", stderr: "" } })
    await startLocalMongo({ projectDir: "/p", port, database: "app", docker: running.run })
    expect(running.calls.map((call) => call[0])).toEqual(["inspect"])
  })
})
