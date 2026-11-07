import type { LogLevel } from "./types.ts"

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"]

/** A logger writing one JSON object per line, compatible with pino and Canopy's `Logger`. */
export interface JsonLogger {
  debug(object: Record<string, unknown>, message?: string): void
  info(object: Record<string, unknown>, message?: string): void
  warn(object: Record<string, unknown>, message?: string): void
  error(object: Record<string, unknown>, message?: string): void
}

/**
 * Logs to `write` (standard error by default) as JSON lines, dropping entries below `level`. `level`,
 * `time` and `msg` always come from the call, so fields of the logged object cannot overwrite them; an
 * `err` that is an `Error` is reduced to its name and message. Throws for an unknown level, so a typo does
 * not turn on debug logging.
 */
export function jsonLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => {
    process.stderr.write(line)
  },
): JsonLogger {
  const threshold = LEVELS.indexOf(level)
  if (threshold < 0) throw new TypeError(`Unknown log level ${JSON.stringify(level)}`)
  const method =
    (name: LogLevel) =>
    (object: Record<string, unknown>, message?: string): void => {
      if (LEVELS.indexOf(name) < threshold) return
      const { level: _level, time: _time, msg: _msg, err, ...fields } = object
      const record = {
        level: name,
        time: new Date().toISOString(),
        msg: message,
        ...fields,
        ...(err === undefined
          ? {}
          : { err: err instanceof Error ? { name: err.name, message: err.message } : err }),
      }
      write(`${JSON.stringify(record)}\n`)
    }
  return {
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
  }
}

/** The signals and messages that ask a Canopy process to stop. */
export type ShutdownReason = "SIGTERM" | "SIGINT" | "SIGBREAK" | "shutdown"

/**
 * Calls `stop` on SIGTERM, SIGINT, SIGBREAK (Ctrl+Break on Windows) or a `"shutdown"` IPC message. Windows
 * has no SIGTERM, so process managers there (PM2, for one) ask a child to stop with that message instead.
 * Returns a function that removes the listeners.
 */
export function onShutdown(
  stop: (reason: ShutdownReason) => void,
  target: Pick<NodeJS.Process, "on" | "off" | "platform"> = process,
): () => void {
  const signals: ("SIGTERM" | "SIGINT" | "SIGBREAK")[] = ["SIGTERM", "SIGINT"]
  if (target.platform === "win32") signals.push("SIGBREAK")
  const handlers = signals.map((signal) => [signal, () => stop(signal)] as const)
  const message = (value: unknown): void => {
    if (value === "shutdown") stop("shutdown")
  }
  for (const [signal, handler] of handlers) target.on(signal, handler)
  target.on("message", message)
  return () => {
    for (const [signal, handler] of handlers) target.off(signal, handler)
    target.off("message", message)
  }
}

/** A command line the binaries do not understand. */
export class UsageError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** What `canopy-server` and `canopy-realtime` take on the command line. */
export interface BinaryArgs {
  readonly file?: string
  readonly help: boolean
}

/** Parses `--config <file>` (or `--config=<file>`) and `--help`. Throws {@link UsageError} for anything else. */
export function parseBinaryArgs(argv: readonly string[]): BinaryArgs {
  let file: string | undefined
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    if (arg === "--help" || arg === "-h") help = true
    else if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index]
      if (value === undefined || value === "" || value.startsWith("-"))
        throw new UsageError("--config needs a file")
      file = value
    } else throw new UsageError(`Unknown option ${arg}`)
  }
  return file === undefined ? { help } : { file, help }
}
