import { resolve } from "node:path"
import { adminCreate, adminList, adminResetTotp } from "./admin.ts"
import { authImport, type ImportSource } from "./auth-import.ts"
import {
  type CommandSpec,
  type Env,
  type Invocation,
  text,
  tokensEnvironment,
  withRemote,
} from "./invocation.ts"
import { keysCreate, keysList, keysRevoke, migrate } from "./keys.ts"
import { login, logout } from "./login.ts"
import type { AdminClient } from "./remote.ts"
import { tokensCreate, tokensList, tokensRevoke } from "./tokens.ts"

/** Commands for API keys, admin accounts and tokens, user imports, migrations and logging in. */
export const ADMIN_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  "keys list": {
    flags: [],
    handler: { kind: "meta", run: (call, meta) => keysList(meta, call.out) },
  },
  "keys create": {
    flags: ["kind", "name"],
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const kind = text(call.flags, "kind")
        const keyName = text(call.flags, "name")
        if ((kind !== "publishable" && kind !== "secret") || keyName === undefined) {
          call.out.error("keys create needs --kind publishable|secret and --name <name>")
          return 1
        }
        return keysCreate({ ...meta, kind, name: keyName }, call.out)
      },
    },
  },
  "keys revoke": {
    flags: ["yes"],
    args: [1, 1],
    needs: "the id of one key",
    handler: {
      kind: "meta",
      run: (call, meta) =>
        keysRevoke({ ...meta, id: call.args[0] ?? "", yes: call.flags.has("yes") }, call.out),
    },
  },
  "admin list": {
    flags: [],
    handler: { kind: "meta", run: (call, meta) => adminList(meta, call.out) },
  },
  "admin create": {
    flags: ["email", "role", "name"],
    handler: {
      kind: "meta",
      run: (call, meta) => {
        const email = text(call.flags, "email")
        const role = text(call.flags, "role")
        const adminName = text(call.flags, "name")
        if (email === undefined || role === undefined) {
          call.out.error(
            "admin create needs --email <email> and --role owner|admin|developer|viewer",
          )
          return 1
        }
        return adminCreate(
          { ...meta, email, role, ...(adminName === undefined ? {} : { name: adminName }) },
          call.out,
        )
      },
    },
  },
  "auth import": {
    flags: ["from", "hash-key", "salt-separator", "rounds", "mem-cost", "dry-run", "env"],
    args: [1, 1],
    needs: "the export file",
    handler: { kind: "direct", run: runAuthImport },
  },
  "admin reset-totp": {
    flags: ["yes"],
    args: [1, 1],
    needs: "the id or email of one admin",
    handler: {
      kind: "meta",
      run: (call, meta) =>
        adminResetTotp(
          { ...meta, admin: call.args[0] ?? "", yes: call.flags.has("yes") },
          call.out,
        ),
    },
  },
  "admin tokens create": {
    flags: ["name", "role", "expires", "env"],
    handler: { kind: "direct", run: runTokensCreate },
  },
  "admin tokens list": {
    flags: ["all", "env"],
    handler: {
      kind: "direct",
      run: (call) =>
        withRemote(call, (remote) => tokensList({ remote, all: call.flags.has("all") }, call.out)),
    },
  },
  "admin tokens revoke": {
    flags: ["yes", "env"],
    args: [1, 1],
    needs: "the id of one token",
    handler: {
      kind: "direct",
      run: (call) =>
        withRemote(call, (remote) =>
          tokensRevoke({ remote, id: call.args[0] ?? "", yes: call.flags.has("yes") }, call.out),
        ),
    },
  },
  migrate: {
    flags: ["status"],
    handler: {
      kind: "meta",
      run: (call, meta) => migrate({ ...meta, status: call.flags.has("status") }, call.out),
    },
  },
  login: {
    flags: ["token", "env"],
    args: [1, 1],
    needs: "the project URL",
    handler: { kind: "direct", run: (call) => login(accountOptions(call), call.out) },
  },
  logout: {
    flags: [],
    args: [1, 1],
    needs: "the project URL",
    handler: { kind: "direct", run: (call) => logout(accountOptions(call), call.out) },
  },
}

function accountOptions(call: Invocation): {
  url: string
  env: Env
  token?: string
  environment?: string
} {
  const token = text(call.flags, "token")
  return {
    url: call.args[0] ?? "",
    env: call.env,
    ...(token === undefined ? {} : { token }),
    ...(call.environment === undefined ? {} : { environment: call.environment }),
  }
}

const IMPORT_SOURCES: readonly ImportSource[] = ["firebase", "auth0", "cognito", "csv"]

function runAuthImport(call: Invocation): number | Promise<number> {
  const { flags, out } = call
  const from = text(flags, "from")
  if (from === undefined || !(IMPORT_SOURCES as readonly string[]).includes(from)) {
    out.error("auth import needs --from firebase|auth0|cognito|csv")
    return 1
  }
  const hashKey = text(flags, "hash-key")
  const separator = text(flags, "salt-separator")
  const rounds = Number(text(flags, "rounds") ?? "8")
  const memCost = Number(text(flags, "mem-cost") ?? "14")
  if (hashKey !== undefined && (separator === undefined || from !== "firebase")) {
    out.error(
      "--hash-key is for --from firebase and needs --salt-separator (and --rounds, --mem-cost)",
    )
    return 1
  }
  if (!Number.isInteger(rounds) || !Number.isInteger(memCost)) {
    out.error("--rounds and --mem-cost must be integers")
    return 1
  }
  const run = (remote: AdminClient | undefined): Promise<number> =>
    authImport(
      {
        file: resolve(call.cwd, call.args[0] ?? ""),
        from: from as ImportSource,
        dryRun: flags.has("dry-run"),
        remote,
        ...(hashKey === undefined || separator === undefined
          ? {}
          : { firebase: { signerKey: hashKey, saltSeparator: separator, rounds, memCost } }),
      },
      out,
    )
  return flags.has("dry-run") ? run(undefined) : withRemote(call, run)
}

function runTokensCreate(call: Invocation): number | Promise<number> {
  if (tokensEnvironment(call) === undefined) return 1
  const { flags, out } = call
  const tokenName = text(flags, "name")
  if (tokenName === undefined) {
    out.error("admin tokens create needs --name <name>")
    return 1
  }
  const role = text(flags, "role")
  if (role !== undefined && !["owner", "admin", "developer", "viewer"].includes(role)) {
    out.error("--role must be owner, admin, developer or viewer")
    return 1
  }
  const expires = text(flags, "expires")
  const days = expires === undefined ? undefined : /^([1-9]\d{0,3})d?$/.exec(expires)?.[1]
  if (expires !== undefined && days === undefined) {
    out.error("--expires needs a number of days, such as 90 or 90d")
    return 1
  }
  return withRemote(call, (remote) =>
    tokensCreate(
      {
        remote,
        name: tokenName,
        ...(role === undefined ? {} : { role }),
        ...(days === undefined ? {} : { expiresInDays: Number(days) }),
      },
      out,
    ),
  )
}
