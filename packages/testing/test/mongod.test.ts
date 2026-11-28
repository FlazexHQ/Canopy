import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { extract } from "../scripts/mongod.ts"

it("extracts MongoDB binaries from disk without their debug symbols", async () => {
  const target = fileURLToPath(new URL("../../../target/", import.meta.url))
  await mkdir(target, { recursive: true })
  const root = await mkdtemp(join(target, "mongod-extract-"))
  try {
    const windows = process.platform === "win32"
    const executable = windows ? "mongod.exe" : "mongod"
    const source = join(root, "source")
    const staging = join(root, "staging folder")
    const bin = join("mongodb-test", "bin")
    await mkdir(join(source, bin), { recursive: true })
    await mkdir(staging)
    await writeFile(join(source, bin, executable), "executable")
    await writeFile(join(source, bin, "mongod.pdb"), "debug symbols")
    await writeFile(join(source, bin, "mongos.pdb"), "debug symbols")
    const archive = join(root, windows ? "mongodb.zip" : "mongodb.tgz")
    const tar = windows
      ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
      : "tar"
    execFileSync(tar, ["-a", "-cf", archive, "-C", source, "mongodb-test"])

    extract(archive, staging)

    expect(await readdir(join(staging, bin))).toEqual([executable])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
