import { type ChildProcess, execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { platform } from "node:os"

/** CPU milliseconds a process has used so far, from the operating system. */
export function cpuMillis(pid: number): number {
  const os = platform()
  if (os === "linux") {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? []
    const ticks = Number(fields[11]) + Number(fields[12])
    const hertz = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim())
    return (ticks * 1000) / hertz
  }
  if (os === "win32") {
    const text = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `[int64](Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`,
      ],
      { windowsHide: true },
    )
    return Number(text.toString().trim())
  }
  const time = execFileSync("ps", ["-o", "time=", "-p", String(pid)])
    .toString()
    .trim()
  const [rest, fraction] = time.split(".")
  const parts = (rest ?? "").split(/[-:]/).map(Number)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return (seconds + Number(`0.${fraction ?? "0"}`)) * 1000
}

/** Reads lines from a child's stdout until `pattern` matches one. */
export function waitFor(child: ChildProcess, pattern: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let pending = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString()
      const match = pattern.exec(pending)
      if (match !== null) resolve(match)
    })
    child.once("exit", (code) => reject(new Error(`a server exited with ${code}`)))
  })
}
