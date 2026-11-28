import { equal } from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { MongoClient } from "mongodb"

const execute = promisify(execFile)
const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url))
const fixture = {
  notes: {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "body"],
        properties: {
          _id: { bsonType: "int" },
          body: { bsonType: "string" },
          tags: { bsonType: "array", items: { bsonType: "string" } },
        },
      },
    },
    index: { body: 1 },
    documents: [{ _id: 1, body: "fixture", ignoredByValidator: true }],
  },
  "todo-items": {
    index: { status: 1 },
    documents: Array.from({ length: 200 }, (_, i) => ({
      _id: i,
      status: i % 2 === 0 ? "open" : "done",
      ...(i === 0 ? {} : { detail: { due: null, labels: ["review"] } }),
    })),
  },
}

const defaultFile = "canopy.schema.ts"

function lf(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

async function files(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort()
  return Promise.all(
    paths.map(async (path) => {
      const text = await readFile(join(dir, path), "utf8")
      return { path, text: lf(text), eol: text.includes("\r\n") ? "CRLF" : "LF" }
    }),
  )
}

async function invoke(dir: string, args: readonly string[]) {
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      ["--conditions=@canopy/source", cli, ...args],
      { cwd: dir, timeout: 15_000 },
    )
    return { stdout, stderr, exitCode: 0 }
  } catch (error: unknown) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ))
      throw error
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code }
  }
}

/** Captures the CLI process and its output files against a seeded application database. */
export async function pullVectors(client: MongoClient, uri: string) {
  const database = `canopy_typegen_${randomUUID().replaceAll("-", "")}`
  const db = client.db(database)
  const temp = await realpath(tmpdir())
  const dir = await mkdtemp(join(temp, "canopy-typegen-"))
  try {
    for (const [name, seed] of Object.entries(fixture)) {
      const collection = await db.createCollection<{ _id: number }>(
        name,
        "validator" in seed ? { validator: seed.validator } : {},
      )
      await collection.createIndex(seed.index)
      await collection.insertMany(seed.documents)
    }
    async function pull(name: string, flags: string[], exitCode: number) {
      const args = ["pull", "--mongodb-uri", uri, "--database", database, ...flags]
      const before = await files(dir)
      const output = await invoke(dir, args)
      equal(output.exitCode, exitCode, `${name}: ${output.stderr}`)
      const after = await files(dir)
      for (const previous of before)
        equal(
          after.some((file) => file.path === previous.path),
          true,
          previous.path,
        )
      return {
        name,
        args: ["pull", "--mongodb-uri", "<MONGODB_URI>", "--database", "<DATABASE>", ...flags],
        before,
        ...output,
        filesWritten: after.filter(
          (file) =>
            !before.some(
              (previous) =>
                previous.path === file.path &&
                previous.text === file.text &&
                previous.eol === file.eol,
            ),
        ),
      }
    }
    const create = await pull("write TypeScript", [], 0)
    const path = join(dir, defaultFile)
    const generated = await readFile(path, "utf8")
    equal(generated, lf(generated))
    const unchanged = await pull("already current with LF", [], 0)
    await writeFile(path, generated.replaceAll("\n", "\r\n"))
    const crlf = await pull("already current with CRLF", [], 0)
    equal(crlf.stdout, unchanged.stdout)
    equal(crlf.stderr, unchanged.stderr)
    equal(await readFile(path, "utf8"), generated.replaceAll("\n", "\r\n"))
    const javascript = await pull(
      "write JavaScript with inferred enums",
      ["--js", "--infer-enums"],
      0,
    )
    const selected = ["--out", "nested/app.ts"]
    const createSelected = await pull(
      "sample one document",
      [...selected, "--collection", "todo-items", "--sample", "1"],
      0,
    )
    const append = await pull("append validator schema", [...selected, "--collection", "notes"], 0)
    const duplicate = await pull(
      "reject duplicate collection",
      [...selected, "--collection", "notes"],
      1,
    )
    const missing = await pull(
      "reject missing collection",
      [...selected, "--collection", "missing"],
      1,
    )
    const invalid = await pull("reject invalid sample", ["--sample", "0"], 1)
    return {
      fixture,
      substitutions: {
        "<MONGODB_URI>": "Replica set connection string supplied to the recorder",
        "<DATABASE>": "Unique scratch database name",
        cwd: "Temporary project path omitted; file paths are relative to it",
        eol: "File text uses LF in the vector; eol marks physical CRLF in the input",
      },
      examples: [
        create,
        unchanged,
        crlf,
        javascript,
        createSelected,
        append,
        duplicate,
        missing,
        invalid,
      ],
    }
  } finally {
    try {
      await db.dropDatabase()
    } finally {
      equal(dirname(await realpath(dir)), temp)
      await rm(dir, { recursive: true, force: true })
    }
  }
}
