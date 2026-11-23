import { arch, cpus, platform, release, totalmem } from "node:os"
import type { Db } from "mongodb"
import { median } from "./stats.ts"

/** Where and on what a D0 report was measured. No credentials from the connection string are recorded. */
export interface TargetInfo {
  readonly mongodb: string
  readonly topology: {
    readonly replicaSet: string | null
    readonly members: number
    readonly srv: boolean
  }
  /** Median round trip of 20 `ping` commands, in milliseconds. */
  readonly pingMillis: number
  /** `CANOPY_BENCH_TIER` for an Atlas run (for example `M30`), empty locally. */
  readonly tier: string
  /** `CANOPY_BENCH_REGION` for an Atlas run (for example `eu-west-1`), empty locally. */
  readonly region: string
  readonly runtime: string
  readonly os: string
  readonly cpu: { readonly model: string; readonly count: number }
  readonly memoryGiB: number
}

/** The runtime and its version, such as `node v26.12.1` or `bun 1.3.0`. */
export function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun
  return bun === undefined ? `node ${process.version}` : `bun ${bun.version}`
}

/** Reads the MongoDB version, topology and round trip of the target, plus the machine running the harness. */
export async function describeTarget(db: Db, uri: string): Promise<TargetInfo> {
  const admin = db.admin()
  const [hello, build] = await Promise.all([
    admin.command({ hello: 1 }),
    admin.command({ buildInfo: 1 }),
  ])
  const pings: number[] = []
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now()
    await admin.command({ ping: 1 })
    pings.push(performance.now() - started)
  }
  const hosts = hello["hosts"]
  const processors = cpus()
  return {
    mongodb: String(build["version"]),
    topology: {
      replicaSet: typeof hello["setName"] === "string" ? hello["setName"] : null,
      members: Array.isArray(hosts) ? hosts.length : 1,
      srv: uri.startsWith("mongodb+srv://"),
    },
    pingMillis: median(pings),
    tier: process.env["CANOPY_BENCH_TIER"] ?? "",
    region: process.env["CANOPY_BENCH_REGION"] ?? "",
    runtime: runtimeName(),
    os: `${platform()} ${release()} ${arch()}`,
    cpu: { model: processors[0]?.model.trim() ?? "unknown", count: processors.length },
    memoryGiB: Math.round(totalmem() / 2 ** 30),
  }
}
