import type { Step } from "./cases.ts"

/** The password of the app user every role works on, created by the owner before the role's steps. */
const appPassword = "app user fixture password 1"

/** The app user the owner creates for every role's capture, which the `users/:id` routes act on. */
export const fixtureUser = {
  email: "Fixture.User@Example.test",
  password: appPassword,
  name: "Fixture user",
  emailVerified: true,
  roles: ["editor"],
  appMetadata: { plan: "pro" },
  userMetadata: { theme: "light" },
}

/**
 * Every `/admin/v1/users` route, run by each admin role against the fixture user (`:id`) and one of its two
 * sessions (`:sid`). The owner and admin may manage users, the developer may read them and the viewer may do
 * neither, so the same steps record the handlers for some roles and the refusals for others. The recorder
 * adds `until` to the ban, 30 days after the fixture clock.
 */
export const userCases: readonly Step[] = [
  { id: "users-list", method: "GET", route: "users" },
  { id: "users-filter", method: "GET", route: "users?email=fixture&limit=1&offset=0" },
  { id: "users-filter-none", method: "GET", route: "users?email=nobody&limit=invalid" },
  { id: "user-get", method: "GET", route: "users/:id" },
  { id: "user-get-missing", method: "GET", route: "users/missing" },
  { id: "user-sessions", method: "GET", route: "users/:id/sessions" },
  { id: "user-sessions-missing", method: "GET", route: "users/missing/sessions" },
  {
    id: "user-create-invalid",
    method: "POST",
    route: "users",
    body: { email: "gus@example.test", unknown: true },
  },
  {
    id: "user-create",
    method: "POST",
    route: "users",
    body: { email: "Gus@Example.test", name: "Gus", roles: ["member"] },
  },
  { id: "user-create-taken", method: "POST", route: "users", body: { email: "gus@example.test" } },
  {
    id: "user-create-reserved-role",
    method: "POST",
    route: "users",
    body: { email: "hat@example.test", roles: ["anon"] },
  },
  { id: "user-session-revoke", method: "DELETE", route: "users/:id/sessions/:sid" },
  { id: "user-sessions-revoke", method: "DELETE", route: "users/:id/sessions" },
  { id: "user-update-invalid", method: "PATCH", route: "users/:id", body: { roles: "editor" } },
  {
    id: "user-update",
    method: "PATCH",
    route: "users/:id",
    body: { roles: ["editor", "billing"], appMetadata: { plan: "team" }, name: "Renamed user" },
  },
  { id: "user-update-missing", method: "PATCH", route: "users/missing", body: { name: "Nobody" } },
  { id: "user-ban-invalid", method: "POST", route: "users/:id/ban", body: { until: "not a date" } },
  { id: "user-ban", method: "POST", route: "users/:id/ban", body: { reason: "abuse" } },
  { id: "user-unban", method: "POST", route: "users/:id/unban" },
  { id: "user-unban-missing", method: "POST", route: "users/missing/unban" },
  {
    id: "user-invite",
    method: "POST",
    route: "users/invite",
    body: {
      email: "ivo@example.test",
      redirectTo: "https://admin.example.test/welcome",
      roles: ["member"],
    },
  },
  {
    id: "user-invite-foreign",
    method: "POST",
    route: "users/invite",
    body: { email: "eve@example.test", redirectTo: "https://evil.example/" },
  },
  {
    id: "user-import",
    method: "POST",
    route: "users/import",
    body: {
      users: [
        { email: "imported@example.test", emailVerified: true, name: "Imported" },
        {
          email: "linked@example.test",
          identities: [{ provider: "github", subject: "777" }],
        },
        { email: "gone@example.test", disabled: true },
        { email: "bad@example.test", passwordHash: { algorithm: "bcrypt", hash: "nope" } },
      ],
    },
  },
  {
    id: "user-import-invalid-date",
    method: "POST",
    route: "users/import",
    body: { users: [{ email: "late@example.test", createdAt: "not a date" }] },
  },
  {
    id: "user-import-invalid",
    method: "POST",
    route: "users/import",
    body: { users: [{ email: "x@example.test", unknown: 1 }] },
  },
  { id: "user-delete", method: "DELETE", route: "users/:id" },
  { id: "user-delete-missing", method: "DELETE", route: "users/:id" },
]
