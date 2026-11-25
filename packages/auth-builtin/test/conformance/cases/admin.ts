import { expectStatus, signIn, signUpVerified } from "../flows.ts"
import type { CaseSpec, Json } from "../harness.ts"
import { legacyUsers } from "../legacy.ts"

const PASSWORD = "correct horse battery 1"

/**
 * The user admin that `/admin/v1/users` calls one to one (list, get, create, update, ban, unban, delete,
 * sessions, invite, import). The HTTP layer of those routes (admin sign in, roles, body validation, the
 * admin audit) belongs to the `/admin/v1` oracle; these cases pin what each call answers and writes.
 */
export const adminUsers: CaseSpec[] = [
  {
    id: "create-update-ban-delete",
    description:
      "Creates a user with a password, roles and metadata (a taken address and a reserved role are refused), lists and reads it, updates it, bans it (its sessions end, sign in and tokens are refused), unbans it, ends its sessions and deletes it",
    async run(context) {
      const users = context.auth.users
      const input = {
        email: "Gus@Example.com",
        password: PASSWORD,
        name: "Gus",
        emailVerified: true,
        roles: ["editor"],
        appMetadata: { plan: "pro" },
        userMetadata: { theme: "light" },
      }
      const created = await context.operation("users.create", input, () => users.create(input))
      await context.refused("users.create", { email: "gus@example.com" }, () =>
        users.create({ email: "gus@example.com" }),
      )
      await context.refused("users.create", { email: "hat@example.com", roles: ["anon"] }, () =>
        users.create({ email: "hat@example.com", roles: ["anon"] }),
      )
      await context.operation("users.list", { email: "gus" }, () => users.list({ email: "gus" }))
      await context.operation("users.get", { id: created.id }, () => users.get(created.id))
      const web = context.client("web")
      expectStatus(await signIn(context, web, "gus@example.com", PASSWORD), 200, "sign in")
      await context.send(web, "GET", "/auth/v1/token")
      const update = { roles: ["editor", "billing"], appMetadata: { plan: "team" } }
      await context.operation("users.update", { id: created.id, ...update }, () =>
        users.update(created.id, update),
      )
      await context.operation("users.listSessions", { id: created.id }, () =>
        users.listSessions(created.id),
      )
      const until = "2031-02-01T00:00:00.000Z"
      await context.operation("users.ban", { id: created.id, reason: "abuse", until }, () =>
        users.ban(created.id, { reason: "abuse", until: new Date(until) }),
      )
      await context.send(web, "GET", "/auth/v1/token")
      await signIn(context, context.client("banned"), "gus@example.com", PASSWORD)
      await context.operation("users.unban", { id: created.id }, () => users.unban(created.id))
      expectStatus(
        await signIn(context, context.client("again"), "gus@example.com", PASSWORD),
        200,
        "sign in after the ban",
      )
      await context.operation("users.revokeSessions", { id: created.id }, () =>
        users.revokeSessions(created.id),
      )
      await context.operation("users.delete", { id: created.id }, () => users.delete(created.id))
      await context.operation("users.get", { id: created.id }, () => users.get(created.id))
    },
  },
  {
    id: "invite",
    description:
      "Invites an address: the user is created and receives an invite link that signs in; a redirect outside the allowlist is refused",
    async run(context) {
      const users = context.auth.users
      const input = {
        email: "ivo@example.com",
        redirectTo: "https://app.canopy.test/welcome",
        roles: ["member"],
      }
      await context.operation("users.invite", input, () => users.invite(input), 1)
      const link = /https?:\/\/\S+/.exec(context.outbox.at(-1)?.text ?? "")?.[0] ?? ""
      await context.visit(context.client("web"), link)
      const foreign = { email: "ivo@example.com", redirectTo: "https://evil.example/" }
      await context.refused("users.invite", foreign, () => users.invite(foreign))
    },
  },
  {
    id: "import-and-rehash",
    description:
      "Imports a user for every hash kind (and one with a linked identity, a disabled one and a refused one); each signs in with its password, which replaces the imported hash with a native Argon2id one",
    async run(context) {
      const users = context.auth.users
      const legacy = await legacyUsers()
      const input = [
        ...legacy.map((user) => ({
          email: user.email,
          emailVerified: true,
          passwordHash: user.passwordHash,
        })),
        { email: "linked@example.com", identities: [{ provider: "github", subject: "777" }] },
        { email: "gone@example.com", disabled: true },
        { email: "bad@example.com", passwordHash: { algorithm: "bcrypt" as const, hash: "nope" } },
      ]
      await context.operation("users.import", input as unknown as Json, async () =>
        users.import === undefined ? undefined : users.import(input),
      )
      for (const user of legacy) {
        await signIn(context, context.client(`${user.kind}-wrong`), user.email, "wrong password 99")
        expectStatus(
          await signIn(context, context.client(user.kind), user.email, user.password),
          200,
          `sign in with ${user.kind}`,
        )
      }
      await signIn(context, context.client("disabled"), "gone@example.com", PASSWORD)
      await signUpVerified(context, context.client("native"), "native@example.com", PASSWORD)
    },
  },
]
