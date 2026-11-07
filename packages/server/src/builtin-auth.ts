import type { Principal, Revocation } from "@canopy/auth"
import type { BuiltinAuth, ClaimsHook, EmailTransport } from "@canopy/auth-builtin"
import {
  type BuiltinAuthInput,
  builtin as configBuiltin,
  type ResolvedBuiltinAuth,
  type ResolvedConfig,
  type ResolvedEmailTransport,
} from "@canopy/config"
import type { Logger } from "@canopy/realtime"
import type { MongoClient } from "mongodb"
import type { EmailTemplateStore } from "./admin/email-templates.ts"

/**
 * Built in auth for the config file, with the claims hook typed: it receives the user, the session and
 * the app database, and may return `app_metadata` and `roles` to add to the token.
 */
export function builtin(
  options: Omit<BuiltinAuthInput<ClaimsHook>, "kind"> = {},
): BuiltinAuthInput<ClaimsHook> {
  return configBuiltin<ClaimsHook>(options)
}

function logTransport(logger: Logger): EmailTransport {
  return {
    name: "log",
    async send(message) {
      logger.warn(
        { to: message.to, subject: message.subject, body: message.text },
        "auth email (email.log() transport, not delivered)",
      )
    },
  }
}

/**
 * Starts built in auth for a resolved config. Loaded with a dynamic import so deployments with external
 * auth never load Better Auth.
 */
export async function startBuiltinAuth(
  config: ResolvedConfig,
  auth: ResolvedBuiltinAuth,
  mongo: MongoClient,
  logger: Logger,
  templates?: EmailTemplateStore,
): Promise<BuiltinAuth> {
  const engine = await import("@canopy/auth-builtin")
  const transport = (resolved: ResolvedEmailTransport): EmailTransport => {
    switch (resolved.kind) {
      case "smtp":
        return engine.smtp({
          host: resolved.host,
          ...(resolved.port === undefined ? {} : { port: resolved.port }),
          ...(resolved.secure === undefined ? {} : { secure: resolved.secure }),
          ...(resolved.requireTls === undefined ? {} : { requireTls: resolved.requireTls }),
          ...(resolved.user === undefined ? {} : { user: resolved.user }),
          ...(resolved.pass === undefined ? {} : { pass: resolved.pass }),
        })
      case "resend":
        return engine.resend({ apiKey: resolved.apiKey })
      case "postmark":
        return engine.postmark({
          serverToken: resolved.serverToken,
          ...(resolved.messageStream === undefined
            ? {}
            : { messageStream: resolved.messageStream }),
        })
      case "ses":
        return engine.ses({
          region: resolved.region,
          accessKeyId: resolved.accessKeyId,
          secretAccessKey: resolved.secretAccessKey,
          ...(resolved.sessionToken === undefined ? {} : { sessionToken: resolved.sessionToken }),
        })
      case "log":
        return logTransport(logger)
    }
  }
  let secret = auth.secret
  if (secret === undefined) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    secret = Buffer.from(bytes).toString("base64url")
    logger.warn(
      {},
      "built in auth has no secret (CANOPY_MASTER_KEY or auth.secret), so it made one for this process; sessions end on restart",
    )
  }
  return engine.createBuiltinAuth({
    mongo,
    appName: auth.appName,
    publicUrl: config.publicUrl ?? `http://localhost:${config.server.port}`,
    secret,
    appDatabase: config.mongodb.database,
    metaDatabase: config.mongodb.metaDatabase,
    authDatabase: config.mongodb.authDatabase,
    redirectUrls: auth.redirectUrls,
    accessTokenTtlSeconds: auth.accessTokenTtlSeconds,
    algorithm: auth.algorithm,
    keyRotation: auth.keyRotation,
    emailPassword: auth.emailPassword === false ? false : auth.emailPassword,
    magicLink: auth.magicLink,
    emailOtp: auth.emailOtp,
    anonymous: auth.anonymous,
    socialProviders: auth.providers,
    oidcProviders: auth.oidc,
    ...(auth.claims === undefined ? {} : { claims: auth.claims as ClaimsHook }),
    email: {
      from: auth.email.from,
      transport: transport(auth.email.transport),
      ...(templates === undefined
        ? {}
        : { templates: templates.mailerTemplates(engine.defaultTemplates) }),
    },
    trustedProxies: [...config.server.trustedProxies, ...auth.trustedProxies],
    identifierLimit: auth.identifierLimit,
    session: auth.session,
    logger,
  })
}

/** Whether a revocation covers the token a realtime connection authenticated with. */
export function revokes(revocation: Revocation, principal: Principal): boolean {
  const claims = principal.context.claims
  if (claims === null) return false
  if (revocation.kind === "session") return claims["sid"] === revocation.sid
  if (revocation.kind === "user" && principal.subject !== revocation.sub) return false
  const iat = claims["iat"]
  return typeof iat !== "number" || iat * 1000 <= revocation.at.getTime()
}
