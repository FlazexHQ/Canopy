import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONGODB_URI, TEST_ENGINE } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { proveDocuments } from "./conformance/documents.ts"
import { recordAuth } from "./conformance/record.ts"

const DIR = fileURLToPath(new URL("../../../conformance/http/auth", import.meta.url))
const DOCUMENTS = fileURLToPath(new URL("../../../conformance/auth/documents", import.meta.url))

/**
 * `conformance/http/auth` is what the Rust auth is held to: every case runs again against built in auth on
 * fresh scratch databases, twice under two seeds, and must give what the files hold after the placeholders.
 * The `canopy_auth` fixture of `conformance/auth/documents` must keep working: its keys and secrets decrypt,
 * its users sign in, its sessions, passkeys and provider accounts are accepted. Regenerate with
 * `bun run vectors:http-auth`.
 */
describe.skipIf(MONGODB_URI === undefined)("conformance/http/auth", () => {
  let client: MongoClient
  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { serverSelectionTimeoutMS: 10_000 })
    await client.connect()
  })
  afterAll(async () => {
    await client?.close()
  })

  it.skipIf(TEST_ENGINE !== "ts")(
    "is what built in auth answers and the fixture database still works",
    async () => {
      expect(await recordAuth({ client, dir: DIR, documentsDir: DOCUMENTS, check: true })).toEqual(
        [],
      )
    },
    900_000,
  )

  it.skipIf(TEST_ENGINE !== "ts")(
    "notices a fixture whose password, key or secret no longer matches",
    async () => {
      const copy = await mkdtemp(join(tmpdir(), "canopy-auth-fixture-"))
      try {
        await cp(DOCUMENTS, copy, { recursive: true })
        const manifestPath = join(copy, "manifest.json")
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          passwords: { email: string; password: string }[]
          twoFactor: { totpSecret: string }[]
        }
        const scrypt = manifest.passwords.find((entry) => entry.email === "scrypt@example.com")
        if (scrypt === undefined) throw new Error("the fixture has no Better Auth scrypt user")
        scrypt.password = "not the password 1"
        const factor = manifest.twoFactor[0]
        if (factor === undefined) throw new Error("the fixture has no two factor user")
        factor.totpSecret = "not the secret"
        await writeFile(manifestPath, JSON.stringify(manifest))
        const keysPath = join(copy, "signing_keys.json")
        const keys = JSON.parse(await readFile(keysPath, "utf8")) as { privateKey: string }[]
        const first = keys[0]
        if (first === undefined) throw new Error("the fixture has no signing key")
        first.privateKey = first.privateKey.replace(/[0-9a-f](?="$)/, (digit) =>
          digit === "0" ? "1" : "0",
        )
        await writeFile(keysPath, JSON.stringify(keys))
        const failures = await proveDocuments(client, copy)
        expect(failures).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^signing key .*Poly1305 tag does not match$/),
            "the TOTP secret of totp@example.com decrypts",
            "scrypt@example.com signs in with its better-auth-scrypt password",
          ]),
        )
      } finally {
        await rm(copy, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
