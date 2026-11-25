const definition = {
  exposed: true,
  realtime: true,
  policies: [
    { name: "read notes", kind: "permissive", ops: ["read"], roles: ["authenticated"], using: {} },
  ],
  fields: { read: { default: { omit: ["secret"] } } },
}

export const origin = "https://admin.example.test"
export const password = "admin oracle fixture password"
export const nextPassword = "admin oracle replacement password"

export interface Step {
  readonly id: string
  readonly method: string
  readonly route: string
  readonly body?: unknown
  readonly headers?: Record<string, string>
  readonly credential?: "none" | "bad" | "owner" | "cookie" | "token"
}

const as = { role: "authenticated", user: "fixture-user" }
const template = "auth/templates/:kind"
const documents = "collections/:collection/documents"

export const cases: readonly Step[] = [
  { id: "me", method: "GET", route: "me" },
  { id: "admins", method: "GET", route: "admins" },
  {
    id: "admin-create",
    method: "POST",
    route: "admins",
    body: { email: "target@example.test", role: "viewer" },
  },
  {
    id: "admin-create-owner",
    method: "POST",
    route: "admins",
    body: { email: "other-owner@example.test", role: "owner" },
  },
  { id: "admin-update", method: "PATCH", route: "admins/:id", body: { name: "Updated admin" } },
  { id: "admin-reset-totp", method: "POST", route: "admins/:id/reset-totp" },
  { id: "admin-remove", method: "DELETE", route: "admins/:id" },
  { id: "collections", method: "GET", route: "collections" },
  { id: "schema", method: "GET", route: "collections/:collection/schema" },
  { id: "stats", method: "GET", route: "collections/:collection/stats" },
  { id: "openapi", method: "GET", route: "openapi" },
  { id: "openapi-invalid", method: "GET", route: "openapi?role=%20invalid" },
  { id: "graphql", method: "POST", route: "graphql", body: { query: "{ __typename }" } },
  { id: "documents", method: "GET", route: documents },
  { id: "document", method: "GET", route: `${documents}/:id` },
  { id: "policy-list", method: "GET", route: "policies" },
  { id: "policy-get", method: "GET", route: "policies/:collection" },
  {
    id: "policy-validate",
    method: "POST",
    route: "policies/:collection/validate",
    body: { definition },
  },
  {
    id: "policy-simulate",
    method: "POST",
    route: "policies/:collection/simulate",
    body: { as, op: "read" },
  },
  {
    id: "policy-explain",
    method: "POST",
    route: "policies/:collection/explain",
    body: { as, op: "read" },
  },
  {
    id: "policy-publish",
    method: "POST",
    route: "policies/:collection/publish",
    body: { definition, expectedVersion: 0, comment: "initial policy" },
  },
  {
    id: "document-view-as",
    method: "GET",
    route: `${documents}?as=${encodeURIComponent(JSON.stringify(as))}`,
  },
  {
    id: "policy-conflict",
    method: "POST",
    route: "policies/:collection/publish",
    body: { definition, expectedVersion: 0 },
  },
  {
    id: "collection-update",
    method: "PATCH",
    route: "collections/:collection",
    body: { expectedVersion: 1, realtime: false },
  },
  { id: "policy-history", method: "GET", route: "policies/:collection/history" },
  {
    id: "policy-rollback",
    method: "POST",
    route: "policies/:collection/rollback",
    body: { version: 1, expectedVersion: 2 },
  },
  { id: "contexts", method: "GET", route: "contexts" },
  { id: "context-validate", method: "POST", route: "contexts/validate", body: { lookups: {} } },
  {
    id: "context-publish",
    method: "POST",
    route: "contexts/publish",
    body: { lookups: {}, expectedVersion: 0 },
  },
  { id: "context-history", method: "GET", route: "contexts/history" },
  {
    id: "context-rollback",
    method: "POST",
    route: "contexts/rollback",
    body: { version: 1, expectedVersion: 1 },
  },
  { id: "keys", method: "GET", route: "api-keys" },
  {
    id: "key-publishable",
    method: "POST",
    route: "api-keys",
    body: { kind: "publishable", name: "fixture" },
  },
  {
    id: "key-secret",
    method: "POST",
    route: "api-keys",
    body: { kind: "secret", name: "fixture secret" },
  },
  { id: "key-remove", method: "DELETE", route: "api-keys/:id" },
  { id: "auth-providers", method: "GET", route: "auth/providers" },
  { id: "auth-keys", method: "GET", route: "auth/keys" },
  { id: "auth-key-rotate", method: "POST", route: "auth/keys/rotate" },
  { id: "auth-key-revoke", method: "DELETE", route: "auth/keys/:kid" },
  { id: "template-preview", method: "POST", route: `${template}/preview`, body: {} },
  {
    id: "template-edit",
    method: "PUT",
    route: template,
    body: { expectedVersion: 0, subject: "Fixture", text: "Open {{url}}" },
  },
  { id: "templates", method: "GET", route: "auth/templates" },
  { id: "template-history", method: "GET", route: "auth/templates/history" },
  { id: "template-reset", method: "DELETE", route: `${template}?expectedVersion=1` },
  { id: "doctor", method: "GET", route: "doctor" },
  { id: "audit", method: "GET", route: "audit?limit=2" },
  { id: "logs", method: "GET", route: "logs" },
  { id: "settings", method: "GET", route: "settings" },
  { id: "settings-invalid", method: "PATCH", route: "settings", body: { requestLogSampleRate: 2 } },
  {
    id: "settings-lockout",
    method: "PATCH",
    route: "settings",
    body: { adminAllowlist: ["192.0.2.1"] },
  },
  { id: "settings-update", method: "PATCH", route: "settings", body: { requestLogSampleRate: 0 } },
  { id: "master-key-confirmation", method: "POST", route: "settings/rotate-master-key" },
  {
    id: "master-key-rotate",
    method: "POST",
    route: "settings/rotate-master-key",
    headers: { "x-canopy-confirm": "rotate master key" },
  },
  { id: "webhooks", method: "GET", route: "webhooks" },
  { id: "dead-letters", method: "GET", route: "webhooks/dead-letters" },
  { id: "dead-letter-invalid", method: "GET", route: "webhooks/dead-letters?limit=invalid" },
  { id: "dead-letter-retry-missing", method: "POST", route: "webhooks/dead-letters/:id/retry" },
  { id: "dead-letter-retry", method: "POST", route: "webhooks/dead-letters/:id/retry" },
  { id: "dead-letter-delete", method: "DELETE", route: "webhooks/dead-letters/:id" },
  { id: "webhook-run", method: "POST", route: "webhooks/:name/run" },
  { id: "webhook-run-missing", method: "POST", route: "webhooks/:name/run" },
  { id: "realtime-stats", method: "GET", route: "realtime/stats" },
  { id: "realtime-connections", method: "GET", route: "realtime/connections" },
  { id: "realtime-observers", method: "GET", route: "realtime/observers" },
  { id: "realtime-events", method: "GET", route: "realtime/events" },
  { id: "realtime-trace-missing", method: "GET", route: "realtime/trace/:eventId" },
  { id: "realtime-tail", method: "GET", route: "realtime/tail" },
  { id: "realtime-token", method: "POST", route: "realtime/token", body: {} },
  {
    id: "document-insert",
    method: "POST",
    route: documents,
    body: { _id: "write", title: "inserted" },
  },
  {
    id: "document-patch",
    method: "PATCH",
    route: `${documents}/:id`,
    body: { $set: { title: "patched" } },
  },
  { id: "document-replace", method: "PUT", route: `${documents}/:id`, body: { title: "replaced" } },
  { id: "document-delete", method: "DELETE", route: `${documents}/:id` },
  { id: "tokens", method: "GET", route: "tokens" },
  { id: "tokens-all", method: "GET", route: "tokens?all=true" },
  {
    id: "token-elevate",
    method: "POST",
    route: "tokens",
    body: { name: "Owner access", role: "owner" },
  },
  {
    id: "token-create",
    method: "POST",
    route: "tokens",
    body: { name: "Fixture automation", expiresInDays: 365 },
  },
  { id: "token-use", method: "GET", route: "me", credential: "token" },
  { id: "token-session-only", method: "POST", route: "logout", credential: "token" },
  { id: "token-revoke", method: "DELETE", route: "tokens/:id" },
  { id: "token-revoked", method: "GET", route: "me", credential: "token" },
  {
    id: "revoke-all",
    method: "POST",
    route: "settings/revoke-all-sessions",
    headers: { "x-canopy-confirm": "revoke all sessions" },
  },
  { id: "logout", method: "POST", route: "logout" },
  { id: "logout-ended", method: "GET", route: "me" },
]
