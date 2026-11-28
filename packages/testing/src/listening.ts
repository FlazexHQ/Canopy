import type { ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"

/** Reads the bound port from the child's JSON startup log. */
export async function waitForListeningPort(
  child: ChildProcess,
  message: string,
  stream: "stdout" | "stderr" = "stderr",
): Promise<number> {
  const input = child[stream]
  if (input === null) throw new Error(`The child's ${stream} must be piped`)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let log = ""
  return new Promise((resolve, reject) => {
    const exited = (): void => finish(new Error(`The server exited before listening:\n${log}`))
    const timeout = setTimeout(
      () => finish(new Error(`The server did not report its bound port:\n${log}`)),
      30_000,
    )
    const finish = (result: number | Error): void => {
      clearTimeout(timeout)
      child.off("close", exited)
      child.off("error", finish)
      lines.close()
      input.resume()
      if (typeof result === "number") resolve(result)
      else reject(result)
    }
    child.once("close", exited)
    child.once("error", finish)
    lines.on("line", (line) => {
      log += `${line}\n`
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      if (
        typeof entry === "object" &&
        entry !== null &&
        (("msg" in entry && entry.msg === message) || ("t" in entry && entry.t === message)) &&
        "port" in entry &&
        typeof entry.port === "number" &&
        Number.isInteger(entry.port) &&
        entry.port > 0 &&
        entry.port <= 65_535
      )
        finish(entry.port)
    })
  })
}
