import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import {
  jsonLogger,
  onShutdown,
  parseBinaryArgs,
  type ShutdownReason,
  UsageError,
} from "../src/process.ts"
import type { LogLevel } from "../src/types.ts"

function capture(level: LogLevel) {
  const lines: Record<string, unknown>[] = []
  const logger = jsonLogger(level, (line) => {
    expect(line.endsWith("\n")).toBe(true)
    lines.push(JSON.parse(line) as Record<string, unknown>)
  })
  return { lines, logger }
}

describe("jsonLogger", () => {
  it("writes one JSON object per entry at or above its level", () => {
    const { lines, logger } = capture("warn")
    logger.debug({ a: 1 }, "debug")
    logger.info({ a: 2 }, "info")
    logger.warn({ a: 3 }, "warn")
    logger.error({ a: 4 }, "error")
    expect(lines.map((line) => [line["level"], line["msg"], line["a"]])).toEqual([
      ["warn", "warn", 3],
      ["error", "error", 4],
    ])
    expect(Number.isNaN(Date.parse(String(lines[0]?.["time"])))).toBe(false)
  })

  it("keeps level, time and msg from the call and reduces errors to name and message", () => {
    const { lines, logger } = capture("debug")
    const error = new RangeError("too far")
    logger.info({ level: "error", time: "yesterday", msg: "forged", err: error, port: 80 }, "real")
    expect(lines[0]).toMatchObject({
      level: "info",
      msg: "real",
      port: 80,
      err: { name: "RangeError", message: "too far" },
    })
    expect(lines[0]?.["time"]).not.toBe("yesterday")
    expect(lines[0]?.["err"]).not.toHaveProperty("stack")
  })

  it("refuses an unknown level instead of logging everything", () => {
    expect(() => jsonLogger("warning" as LogLevel, () => {})).toThrow('Unknown log level "warning"')
  })
})

function fakeProcess(platform: NodeJS.Platform) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { platform }) as EventEmitter & { platform: NodeJS.Platform }
}

describe("onShutdown", () => {
  it("stops on SIGTERM, SIGINT and the shutdown message, and on SIGBREAK only on Windows", () => {
    for (const platform of ["linux", "win32"] as const) {
      const target = fakeProcess(platform)
      const reasons: ShutdownReason[] = []
      const remove = onShutdown((reason) => reasons.push(reason), target as never)
      target.emit("SIGTERM")
      target.emit("SIGINT")
      target.emit("SIGBREAK")
      target.emit("message", "other")
      target.emit("message", "shutdown")
      expect(reasons).toEqual(
        platform === "win32"
          ? ["SIGTERM", "SIGINT", "SIGBREAK", "shutdown"]
          : ["SIGTERM", "SIGINT", "shutdown"],
      )
      remove()
      target.emit("SIGTERM")
      target.emit("message", "shutdown")
      expect(reasons).toHaveLength(platform === "win32" ? 4 : 3)
      expect(target.listenerCount("SIGTERM") + target.listenerCount("message")).toBe(0)
    }
  })
})

describe("parseBinaryArgs", () => {
  it("reads --config in both spellings and --help", () => {
    expect(parseBinaryArgs([])).toEqual({ help: false })
    expect(parseBinaryArgs(["--config", "a.ts"])).toEqual({ file: "a.ts", help: false })
    expect(parseBinaryArgs(["--config=b.ts", "-h"])).toEqual({ file: "b.ts", help: true })
    expect(parseBinaryArgs(["--help"])).toEqual({ help: true })
  })

  it("refuses unknown options and a --config without a file", () => {
    for (const argv of [["--port", "1"], ["--config"], ["--config="], ["--config", "--help"]])
      expect(() => parseBinaryArgs(argv)).toThrow(UsageError)
    expect(() => parseBinaryArgs(["serve"])).toThrow("Unknown option serve")
  })
})
