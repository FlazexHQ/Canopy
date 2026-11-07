export { resolveClientAddress } from "@canopy/auth"
export { type AuditActor, type AuditDocument, type AuditEvent, AuditLog } from "./audit.ts"
export { type EmailOptions, Mailer } from "./email/mailer.ts"
export { type AwsCredentials, ses, signV4 } from "./email/ses.ts"
export { buildMime, type SmtpOptions, smtp } from "./email/smtp.ts"
export {
  defaultTemplates,
  type EmailKind,
  type EmailTemplate,
  type EmailTemplateData,
  type EmailTemplates,
  escapeHtml,
  type RenderedEmail,
} from "./email/templates.ts"
export {
  type EmailMessage,
  type EmailTransport,
  type FetchLike,
  memoryTransport,
  postmark,
  resend,
} from "./email/transport.ts"
export {
  AUTH_COLLECTIONS,
  type OidcProviderOptions,
  type SocialProviderId,
  type SocialProviderOptions,
} from "./engine.ts"
export { IdentifierGuard } from "./guard.ts"
export { AUTH_INDEXES, ensureAuthIndexes } from "./indexes.ts"
export {
  type KeyMaterial,
  KeyRing,
  type KeyRingOptions,
  type SigningAlgorithm,
  type SigningKeyDocument,
  type SigningKeyInfo,
} from "./keyring.ts"
export { acquireLease, type LeaseDocument, releaseLease } from "./lease.ts"
export { type AuthLogger, silentAuthLogger } from "./logger.ts"
export type {
  BuiltinAuthOptions,
  ClaimsHook,
  ClaimsHookInput,
  ClaimsHookResult,
} from "./options.ts"
export { type BuiltinAuth, createBuiltinAuth } from "./provider.ts"
export { type RevocationDocument, RevocationStore } from "./revocation-store.ts"
