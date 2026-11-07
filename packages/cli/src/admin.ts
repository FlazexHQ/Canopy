import { AdminAccounts, AuditLog, isAdminRole, SecretBox } from "@canopy/server"
import { confirmed, messageOf, type Output } from "./output.ts"
import { cliActor, type MetaOptions, withMeta } from "./policies.ts"

const accountsOf = (
  client: Parameters<Parameters<typeof withMeta>[2]>[0],
  metaDatabase: string,
) => {
  const meta = client.db(metaDatabase)
  return new AdminAccounts({
    client,
    meta,
    audit: new AuditLog(meta),
    secrets: new SecretBox(undefined),
    environment: "development",
  })
}

const date = (value: Date | undefined): string =>
  value === undefined ? "never" : value.toISOString()

/** Options of `canopy admin create`. */
export interface AdminCreateOptions extends MetaOptions {
  readonly email: string
  readonly role: string
  readonly name?: string
}

/**
 * `canopy admin create`: creates a Studio admin straight in the meta database, for bootstrap and recovery.
 * The generated password is printed once and must be changed at the first login; owners also set up TOTP
 * then. Creating an owner claims the server, so the setup token stops working. Audited.
 */
export async function adminCreate(options: AdminCreateOptions, out: Output): Promise<number> {
  if (!isAdminRole(options.role)) {
    out.error("admin create needs --role owner|admin|developer|viewer")
    return 1
  }
  const role = options.role
  return withMeta(options, out, async (client) => {
    try {
      const { user, password } = await accountsOf(client, options.metaDatabase).createBootstrap(
        {
          email: options.email,
          role,
          ...(options.name === undefined ? {} : { name: options.name }),
        },
        cliActor(),
      )
      out.log(`${user.id}  ${user.email}  ${user.role}`)
      out.log(`Temporary password: ${password}`)
      out.log(
        `This is the only time it is shown. It must be changed at the first login${role === "owner" ? ", where the owner also sets up an authenticator app" : ""}.`,
      )
      return 0
    } catch (error: unknown) {
      out.error(messageOf(error))
      return 1
    }
  })
}

/** `canopy admin list`: the Studio admins with their role, TOTP state and last login. */
export async function adminList(options: MetaOptions, out: Output): Promise<number> {
  return withMeta(options, out, async (client) => {
    const users = await accountsOf(client, options.metaDatabase).list()
    if (users.length === 0) {
      out.log(
        "No admins yet. Create the first owner with canopy admin create --email <email> --role owner",
      )
      return 0
    }
    for (const user of users)
      out.log(
        `${user.id}  ${user.email.padEnd(32)}  ${user.role.padEnd(9)}  totp ${user.totpEnabled ? "on " : "off"}  ${user.disabled ? "disabled" : "active  "}  last login ${date(user.lastLoginAt)}`,
      )
    return 0
  })
}

/** Options of `canopy admin reset-totp`. */
export interface AdminResetTotpOptions extends MetaOptions {
  /** The admin id or email. */
  readonly admin: string
  readonly yes: boolean
}

/**
 * `canopy admin reset-totp <id|email>`: clears an admin's TOTP secret and ends their sessions, for a lost
 * authenticator. Owners set up a new one at their next login. Asks first; audited.
 */
export async function adminResetTotp(options: AdminResetTotpOptions, out: Output): Promise<number> {
  return withMeta(options, out, async (client) => {
    const accounts = accountsOf(client, options.metaDatabase)
    const user = await accounts.find(options.admin)
    if (user === undefined) {
      out.error(`No admin ${options.admin}. List them with canopy admin list.`)
      return 1
    }
    const question = `Reset the TOTP of ${user.email} (${user.role})? Their sessions end and they set up a new authenticator at the next login.`
    if (!(await confirmed(out, question, options.yes))) return 1
    await accounts.resetTotp(user.id, cliActor(), undefined)
    out.log(`reset  ${user.id}  ${user.email}`)
    return 0
  })
}
