import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  authImport,
  parseAuth0,
  parseCognito,
  parseCsv,
  parseFirebase,
  parseGenericCsv,
} from "../src/auth-import.ts"
import type { Output } from "../src/output.ts"
import { AdminClient } from "../src/remote.ts"

function capture(): Output & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    log: (line: string) => lines.push(line),
    error: (line: string) => errors.push(line),
  } as Output & { lines: string[]; errors: string[] }
}

const FIREBASE_HASH = {
  signerKey:
    "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
  saltSeparator: "Bw==",
  rounds: 8,
  memCost: 14,
}

describe("export parsers", () => {
  it("reads RFC 4180 CSV with quotes, commas, line breaks and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nlast,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
      ["last", ""],
    ])
  })

  it("reads a Firebase export with its scrypt parameters and provider identities", () => {
    const parsed = parseFirebase(
      JSON.stringify({
        users: [
          {
            localId: "fb1",
            email: "ada@example.com",
            emailVerified: true,
            displayName: "Ada",
            passwordHash: "lSrf",
            salt: "42xE",
            createdAt: "1700000000000",
            providerUserInfo: [
              { providerId: "google.com", rawId: "g-1" },
              { providerId: "password", rawId: "ada@example.com" },
            ],
          },
          { localId: "fb2", phoneNumber: "+1555" },
          { localId: "fb3", email: "off@example.com", disabled: true },
        ],
      }),
      FIREBASE_HASH,
    )
    expect(parsed.skipped).toEqual([{ line: 2, reason: "no email" }])
    expect(parsed.users).toEqual([
      {
        email: "ada@example.com",
        emailVerified: true,
        name: "Ada",
        createdAt: "2023-11-14T22:13:20.000Z",
        appMetadata: { importedFrom: { system: "firebase", id: "fb1" } },
        passwordHash: {
          algorithm: "firebase-scrypt",
          ...FIREBASE_HASH,
          salt: "42xE",
          hash: "lSrf",
        },
        identities: [{ provider: "google", subject: "g-1" }],
      },
      {
        email: "off@example.com",
        disabled: true,
        appMetadata: { importedFrom: { system: "firebase", id: "fb3" } },
      },
    ])
    expect(
      parseFirebase(
        JSON.stringify({ users: [{ email: "a@b.c", passwordHash: "x", salt: "y" }] }),
        undefined,
      ).users[0],
    ).not.toHaveProperty("passwordHash")
  })

  it("reads Auth0 newline delimited JSON with bcrypt hashes and social identities", () => {
    const parsed = parseAuth0(
      [
        JSON.stringify({
          user_id: "auth0|1",
          email: "kim@example.com",
          email_verified: false,
          name: "Kim",
          created_at: "2024-01-02T03:04:05.000Z",
          identities: [{ provider: "google-oauth2", user_id: 1093, connection: "google-oauth2" }],
          app_metadata: { plan: "pro" },
          user_metadata: { theme: "dark" },
          passwordHash: "$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012",
          blocked: true,
        }),
        "",
        JSON.stringify({ user_id: "sms|2" }),
      ].join("\n"),
    )
    expect(parsed.skipped).toEqual([{ line: 2, reason: "no email" }])
    expect(parsed.users).toEqual([
      {
        email: "kim@example.com",
        emailVerified: false,
        name: "Kim",
        createdAt: "2024-01-02T03:04:05.000Z",
        disabled: true,
        appMetadata: { plan: "pro", importedFrom: { system: "auth0", id: "auth0|1" } },
        userMetadata: { theme: "dark" },
        passwordHash: {
          algorithm: "bcrypt",
          hash: "$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012",
        },
        identities: [{ provider: "google", subject: "1093" }],
      },
    ])
  })

  it("reads a Cognito CSV without passwords", () => {
    const parsed = parseCognito(
      "sub,email,email_verified,given_name,family_name,enabled\r\nc-1,lee@example.com,true,Lee,Park,false\r\nc-2,,true,,,true\r\n",
    )
    expect(parsed.users).toEqual([
      {
        email: "lee@example.com",
        emailVerified: true,
        name: "Lee Park",
        disabled: true,
        appMetadata: { importedFrom: { system: "cognito", id: "c-1" } },
      },
    ])
    expect(parsed.skipped).toEqual([{ line: 3, reason: "no email" }])
  })

  it("reads a generic CSV with roles and several hash algorithms", () => {
    const parsed = parseGenericCsv(
      [
        "email,name,roles,password_hash,password_algorithm,password_salt,password_iterations,created_at",
        'a@example.com,"Doe, Jo",editor; admin,$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW,,,,2025-01-01',
        "b@example.com,,,c2FsdA==,pbkdf2-sha256,c2FsdA==,600000,",
        "c@example.com,,,abc,md5,,,",
      ].join("\n"),
    )
    expect(parsed.users).toEqual([
      {
        email: "a@example.com",
        name: "Doe, Jo",
        createdAt: "2025-01-01T00:00:00.000Z",
        roles: ["editor", "admin"],
        passwordHash: {
          algorithm: "bcrypt",
          hash: "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
        },
      },
      {
        email: "b@example.com",
        passwordHash: {
          algorithm: "pbkdf2-sha256",
          hash: "c2FsdA==",
          salt: "c2FsdA==",
          iterations: 600000,
        },
      },
    ])
    expect(parsed.skipped).toEqual([{ line: 4, reason: "unknown password_algorithm md5" }])
  })
})

describe("canopy auth import", () => {
  it("sends the users in batches through the admin API and reports failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-import-"))
    const file = join(dir, "users.csv")
    await writeFile(file, ["email", "a@x.io", "b@x.io", "c@x.io"].join("\n"))
    const bodies: unknown[] = []
    const remote = new AdminClient("https://canopy.test", "token", async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { users: { email: string }[] }
      bodies.push(body)
      const failed = body.users
        .filter((user) => user.email === "c@x.io")
        .map((user) => ({ email: user.email, reason: "invalid" }))
      return Response.json({ created: body.users.length - failed.length, skipped: 0, failed })
    })
    const out = capture()
    const code = await authImport({ file, from: "csv", dryRun: false, remote, batchSize: 2 }, out)
    expect(code).toBe(1)
    expect(bodies).toEqual([
      { users: [{ email: "a@x.io" }, { email: "b@x.io" }] },
      { users: [{ email: "c@x.io" }] },
    ])
    expect(out.errors).toEqual(["failed c@x.io: invalid"])
    expect(out.lines.at(-1)).toBe("2 imported, 0 already existed, 1 failed")
  })

  it("only reads the file on a dry run and needs a project otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-import-"))
    const file = join(dir, "users.json")
    await writeFile(
      file,
      JSON.stringify({ users: [{ email: "a@x.io", passwordHash: "x", salt: "y" }] }),
    )
    const out = capture()
    expect(await authImport({ file, from: "firebase", dryRun: true, remote: undefined }, out)).toBe(
      0,
    )
    expect(out.lines[0]).toBe(`1 users read from ${file} (0 with password hashes, 0 unreadable)`)
    expect(out.lines[1]).toMatch(/No --hash-key given/)
    const live = capture()
    expect(
      await authImport({ file, from: "firebase", dryRun: false, remote: undefined }, live),
    ).toBe(1)
    expect(live.errors[0]).toMatch(/--env/)
  })
})
