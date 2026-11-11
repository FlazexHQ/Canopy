import { readFile } from "node:fs/promises"
import { basename } from "node:path"

/**
 * Prints the frames with the most self time of V8 CPU profiles written by `CANOPY_BENCH_PROFILE`, as a
 * share of the profile's busy time (idle excluded). Frames of the driver (`mongodb`, `bson`) are summed into
 * one line each, so the rest shows what Canopy itself spends.
 *
 *   node bench/profile-top.ts <file.cpuprofile>... [--top 15]
 */
interface ProfileNode {
  readonly id: number
  readonly callFrame: {
    readonly functionName: string
    readonly url: string
    readonly lineNumber: number
  }
}

interface Profile {
  readonly nodes: readonly ProfileNode[]
  readonly samples: readonly number[]
  readonly timeDeltas: readonly number[]
}

function group(node: ProfileNode): { key: string; driver: boolean } {
  const { functionName, url, lineNumber } = node.callFrame
  const path = url.replaceAll("\\", "/")
  if (/node_modules\/(\.bun\/[^/]+\/node_modules\/)?mongodb\//.test(path))
    return { key: "[mongodb driver]", driver: true }
  if (/node_modules\/(\.bun\/[^/]+\/node_modules\/)?bson\//.test(path))
    return { key: "[bson]", driver: true }
  const where = path === "" ? "" : ` ${path.replace(/^.*\/packages\//, "")}:${lineNumber + 1}`
  return { key: `${functionName === "" ? "(anonymous)" : functionName}${where}`, driver: false }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const topIndex = args.indexOf("--top")
  const top = topIndex === -1 ? 15 : Number(args[topIndex + 1])
  const files = args.filter((_arg, index) => index !== topIndex && index !== topIndex + 1)
  for (const file of files) {
    const profile = JSON.parse(await readFile(file, "utf8")) as Profile
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    const self = new Map<string, number>()
    let busy = 0
    for (const [index, id] of profile.samples.entries()) {
      const node = byId.get(id)
      const delta = profile.timeDeltas[index] ?? 0
      if (node === undefined || node.callFrame.functionName === "(idle)") continue
      busy += delta
      const { key } = group(node)
      self.set(key, (self.get(key) ?? 0) + delta)
    }
    const rows = [...self.entries()].sort((a, b) => b[1] - a[1])
    process.stdout.write(`\n${basename(file)}: ${(busy / 1000).toFixed(0)} ms busy\n`)
    for (const [key, micros] of rows.slice(0, top))
      process.stdout.write(`  ${((micros / busy) * 100).toFixed(1).padStart(5)}%  ${key}\n`)
  }
}

await main()
