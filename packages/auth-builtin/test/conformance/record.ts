import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { BSON, type MongoClient } from "mongodb"
import { adminUsers } from "./cases/admin.ts"
import {
  emailOtp,
  emailPassword,
  emailVerification,
  magicLink,
  passwordReset,
} from "./cases/email.ts"
import { passkeys, twoFactor } from "./cases/factors.ts"
import { errors, rateLimits } from "./cases/limits.ts"
import { oidc, social } from "./cases/providers.ts"
import { anonymous, bearer, sessions, tokens } from "./cases/sessions.ts"
import { EPOCH } from "./determinism.ts"
import { proveDocuments, writeDocuments } from "./documents.ts"
import {
  APP_ORIGIN,
  baseOptions,
  type CaseSpec,
  type Json,
  PUBLIC_URL,
  Recorder,
  SECRET,
  STARTUP_SEED,
} from "./harness.ts"

/** The groups of the oracle, one file each under `cases/`. */
const GROUPS: Readonly<Record<string, readonly CaseSpec[]>> = {
  "email-password": emailPassword,
  "email-verification": emailVerification,
  "password-reset": passwordReset,
  "magic-link": magicLink,
  "email-otp": emailOtp,
  "two-factor": twoFactor,
  passkeys,
  anonymous,
  social,
  oidc,
  sessions,
  bearer,
  tokens,
  "admin-users": adminUsers,
  "rate-limits": rateLimits,
  errors,
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function startupState(recorder: Recorder, algorithm: "EdDSA" | "ES256") {
  const started = await recorder.start({ algorithm })
  try {
    const keys = await started.authDb
      .collection("signing_keys")
      .find()
      .sort({ createdAt: 1 })
      .toArray()
    return {
      signingKeys: keys.map(
        (key) => JSON.parse(BSON.EJSON.stringify(key, { relaxed: false })) as Json,
      ),
      jwks: (await started.auth.jwks()) as unknown as Json,
    }
  } finally {
    await started.auth.close()
    await started.drop()
  }
}

/**
 * Records `conformance/http/auth`, or with `check` reports the files a fresh recording would change. The
 * fixture database in `documentsDir` is written when it is missing or `rewriteDocuments` is set (it holds
 * random salts, so it is not rewritten on every recording), and is then proved with the TypeScript server;
 * every failed proof is reported like a differing file.
 */
export async function recordAuth(options: {
  readonly client: MongoClient
  readonly dir: string
  readonly documentsDir?: string
  readonly check?: boolean
  readonly rewriteDocuments?: boolean
  readonly groups?: readonly string[]
}): Promise<string[]> {
  const recorder = new Recorder(options.client)
  const outputs = new Map<string, string>()
  await recorder.deterministic(async () => {
    const eddsa = await startupState(recorder, "EdDSA")
    const es256 = await startupState(recorder, "ES256")
    outputs.set(
      "fixture.json",
      json({
        publicUrl: PUBLIC_URL,
        appOrigin: APP_ORIGIN,
        secret: SECRET,
        clock: new Date(EPOCH).toISOString(),
        startupSeed: STARTUP_SEED,
        options: baseOptions(),
        startup: { EdDSA: eddsa, ES256: es256 },
      }),
    )
    for (const [group, specs] of Object.entries(GROUPS)) {
      if (options.groups !== undefined && !options.groups.includes(group)) continue
      const cases: Json[] = []
      for (const spec of specs) cases.push(await recorder.record(spec))
      outputs.set(join("cases", `${group}.json`), json({ group, cases }))
    }
  })
  const differing: string[] = []
  const documentsDir = options.documentsDir
  if (documentsDir !== undefined) {
    const missing = await readFile(join(documentsDir, "manifest.json"), "utf8").then(
      () => false,
      () => true,
    )
    if (options.check !== true && (missing || options.rewriteDocuments === true))
      await writeDocuments(options.client, documentsDir)
    for (const failure of await proveDocuments(options.client, documentsDir))
      differing.push(`documents: ${failure}`)
  }
  for (const [name, content] of outputs) {
    const path = join(options.dir, name)
    if (options.check === true) {
      const current = await readFile(path, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (current?.replaceAll("\r\n", "\n") !== content) differing.push(name)
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
  }
  return differing
}
