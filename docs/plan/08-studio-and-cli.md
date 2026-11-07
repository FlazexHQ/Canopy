# 08: Studio & CLI

> **Canopy Studio** is the web admin dashboard from Concept 2. The **`canopy` CLI** covers the same ground for
> terminals and CI. Both use one admin API, and both treat policies as code that can also be edited visually.

## 1. Studio goals

1. **Understand access at a glance.** For any collection, show what each role and user can read and write, and
   why.
2. **Fast to set up.** Go from an empty project to exposed collections with sensible policies in minutes.
3. **Debug realtime and DLS without reading logs.** Answer "why didn't this client get this event?" and "why
   was this write denied?"
4. **Safe by construction.** Dangerous operations are explicit, confirmed, role-gated and audited.

## 2. Information architecture

| Area | Pages and capabilities |
|---|---|
| **Overview** | Health: topology and version, change-stream lag, connections, requests/s, error rate. Doctor warnings. Getting-started checklist. |
| **Data** | Collections (exposed and realtime flags, estimated counts, policy badges). Document grid plus EJSON view. A filter builder that stays in sync with the JSON filter editor. Sort and field pickers. Insert, edit and delete as `service`, always audited. Import and export (JSON, EJSON, CSV). **"View as"**: pick a role, user or arbitrary claims, and the whole page is rendered through DLS. |
| **Policies** | Per-collection policy list. Editor with form, EJSON and TS DSL views. Field rules and immutable fields. `$ctx` lookups. A lint panel. **Simulator**. Diff against the published version. Publish with a comment. History and rollback. |
| **Realtime** | Live event tail (filter by collection and operation). Connections (subject, transport, subscriptions, queue depth). Observers (type, subscribers, candidates per event, matching cost). Lag chart. **Event trace**. |
| **Auth** | Users (search; detail with identities, sessions and metadata; ban, delete, force sign-out; "view as"). Providers. Email templates. Token settings and claims-hook status. Signing keys (rotate, standby). Auth audit. |
| **API** | API keys (create, revoke). REST reference (role-filtered OpenAPI rendered with Scalar). GraphQL explorer (GraphiQL). SDK snippets per collection. Type-generation command. |
| **Logs & audit** | Sampled request logs. Audit log of admin and policy changes. A **denials explorer** listing the most-denied operations by collection, role and policy. |
| **Settings** | Public URL, CORS origins, limits, realtime mode and pre/post-image status per collection, admins and roles, danger zone (revoke all sessions, rotate the master key). |
| **Doctor** | The `canopy doctor` checks (§7.2), each with an explanation and a fix. |

## 3. Key flows

**First run (secure claim).** On its first start the server prints a **one-time setup token** to its logs.
Studio's setup screen asks for that token before it creates the first `owner`, so nobody can claim a freshly
deployed instance from the internet. A wizard then:

1. runs the doctor checks;
2. lists collections and lets the owner expose some, picking a starter template per collection
   (*owner-only*, *tenant-scoped*, *public read / owner write*, *write-only intake*);
3. shows the publishable key and an SDK snippet.

**Policy authoring and simulation.** This is the core flow.

```
┌ Policies › todos ──────────────────────────────────────────────────────────────┐
│ [read own] [read shared in my orgs] [create own] [edit own] [archived is perm…] │
├───────────────────────────────┬─────────────────────────────────────────────────┤
│ allow.read('authenticated')   │ SIMULATOR                                       │
│   .where({                    │ As:   ◉ user [alice@example.com ▾]  ○ anon      │
│     ownerId: auth('sub')      │       ○ claims {…}                              │
│   })                          │ Op:   read ▾   Filter: { "status": "active" }    │
│                               │ ─────────────────────────────────────────────── │
│ [EJSON] [TS] [Form]           │ ✓ allowed: 12 documents                          │
│                               │ Effective filter:                                │
│ Lint: ✓ no issues             │ { $and: [ {status:"active"},                     │
│                               │   {$or: [ {ownerId:"u_alice"},                   │
│                               │           {orgId:{$in:["o1"]},shared:true} ]} ]} │
│                               │ Trace: read own ✓ · read shared ✓ · fields: -1   │
├───────────────────────────────┴─────────────────────────────────────────────────┤
│ Draft v9 (unpublished) · diff vs v8 · [Save as test] [Publish…]                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- The simulator evaluates **the draft** against the real database, read-only, using the same compiler as
  production, and shows the explain trace
  ([02 §13](02-document-level-security.md#13-testing-and-linting-policies)).
- **Save as test** turns the current case into a `describePolicies` snippet that can be pasted into the repo.

**"View as" impersonation.** Read-only by default. Writing as an impersonated user requires an explicit
toggle and a reason. Both modes are audited, including who impersonated whom and which pages were viewed.

**Realtime event trace.** Pick an event from the tail or by document ID. Studio shows which observers were
candidates, which matched, which subscribers received it, and which were filtered out by DLS, with the policy
responsible.

## 4. Studio tech

- **Stack:** React 19, Vite, TanStack Router (file-based), TanStack Query for the admin API, Tailwind CSS v4 with
  shadcn/ui, CodeMirror 6 (EJSON language support, plus autocomplete for field names and operators driven by
  the schema cache), uPlot for live charts, Scalar for OpenAPI, GraphiQL.
- **Dogfooding:** Studio uses `@canopy/react` for live data, with an admin-scoped session, so it exercises the
  SDK every day.
- **Shipping:** built to static assets inside `@canopy/server` and served at `/studio` with immutable caching.
  There is no separate deployment.
- **Quality bar:** WCAG 2.2 AA, full keyboard navigation, dark mode, English first with i18n-ready strings.

## 5. Admin API and RBAC

`/admin/v1/*` is a JSON API validated with Zod. The CLI uses it too.

| Group | Endpoints (abridged) |
|---|---|
| Session | `POST /setup`, `POST /login`, `POST /logout`, `GET /me` |
| Collections | `GET /collections`, `PATCH /collections/{c}` (expose, realtime), `GET /collections/{c}/schema`, `GET /collections/{c}/stats` |
| Documents | `GET/POST/PATCH/DELETE /collections/{c}/documents…` (as `service` or "view as") |
| Policies | `GET /policies/{c}`, `POST /policies/{c}/validate`, `POST /policies/{c}/simulate`, `POST /policies/{c}/publish`, `GET /policies/{c}/history`, `POST /policies/{c}/rollback` |
| Auth | `GET/PATCH/DELETE /users…`, `POST /users/{id}/revoke-sessions`, `GET/PUT /auth/providers`, `POST /auth/keys/rotate` |
| Keys | `GET/POST/DELETE /api-keys…` |
| Realtime | `GET /realtime/stats`, `GET /realtime/connections`, `GET /realtime/observers`, `GET /realtime/tail` (SSE), `GET /realtime/trace/{eventId}` |
| Ops | `GET /doctor`, `GET /logs`, `GET /audit`, `GET/PATCH /settings` |

| Admin role | Permissions |
|---|---|
| `owner` | Everything, including managing owners, settings and the danger zone. TOTP required. |
| `admin` | Everything except managing owners and the danger zone |
| `developer` | Draft, simulate and test policies. Publish only outside `production`. Data read/write outside `production`, read-only in it. Realtime inspector. Publishable keys only. |
| `viewer` | Read-only dashboards, data browsing with fields hidden by DLS masked, no publishing |

When `CANOPY_ENV=production`, publishing requires `admin` or `owner` and a comment, and data edits in Studio
require typed confirmation.

## 6. Studio security

- The admin session uses its own cookie, `__Host-canopy_admin` (`HttpOnly`, `Secure`, `SameSite=Strict`), with
  a 12 h lifetime and a 1 h idle timeout. It is never shared with app-user auth ([07 §10](07-auth.md#10-admin-users-vs-app-users)).
- CSRF: double-submit token plus Origin checks on every mutating request.
- Strict CSP with no inline scripts and `frame-ancestors 'none'`.
- **An optional private listener** (`CANOPY_ADMIN_LISTEN=127.0.0.1:8081`) serves `/admin` and `/studio` only on
  that address, so they stay off the public internet. There is also an optional IP allowlist.
- Login is rate-limited and protected against brute force. TOTP is required for owners.
- Secrets are shown once. Secret keys and signing keys are never displayed again.
- Every mutation and every impersonation is written to `canopy.audit_log` with the actor, a diff and, when
  provided, a commit SHA.

## 7. CLI

### 7.1 Commands

| Command | Purpose |
|---|---|
| `canopy init` | Adds a `canopy/` folder to an **existing** project (config, policies with starter templates, `.env.example`). It can introspect a database to suggest exposure. It never generates an app. |
| `canopy dev [--with-mongo]` | Runs Canopy locally with hot reload of config and policies. `--with-mongo` starts a single-node replica set from the official MongoDB Community image with a persistent volume, then prints URLs and keys. |
| `canopy doctor` | Preflight checks (§7.2). Exits non-zero on errors, for use in CI. |
| `canopy policies lint \| test \| diff \| push \| pull \| history \| rollback` | Policy-as-code ([02 §11](02-document-level-security.md#11-policy-lifecycle)) |
| `canopy gen types [--role r] [--check]` | Type generation ([06 §12](06-data-api.md#12-type-generation)) |
| `canopy keys list \| create \| revoke` | API keys |
| `canopy admin create \| list \| reset-totp` | Admin accounts. Bootstrap commands talk to the database directly. |
| `canopy realtime enable-images \| disable-images <coll…>` | Pre/post-images. Needs admin DB credentials, prints the exact `collMod` and asks for confirmation. |
| `canopy indexes advise \| create` | Index advice for policy fields. Creating needs confirmation. |
| `canopy auth import --from …` | User import (Phase 4) |
| `canopy migrate` | Meta-DB migrations. These also run on server start unless `--no-migrate`. |
| `canopy login` | Stores an admin token for a remote project in the OS keychain |

### 7.2 Doctor checks

| Check | Severity on failure |
|---|---|
| Topology is a replica set or sharded cluster | error (standalone, with instructions for a single-node replica set) |
| Server version ≥ 7.0 (warn below 8.0 before 1.0) and feature compatibility version | error / warn |
| Privileges: `find` + `changeStream` on the app DB; `readWrite` on meta (and auth); write privileges in platform mode | error |
| Oplog window | warn below 24 h, error below 1 h (skipped with a note without access to `local`) |
| Meta DB and app DB on the same deployment | error (transactions span both) |
| Pre/post-image status per realtime collection | info, or error in edge mode |
| Indexes covering policy equality fields | warn |
| Exposed collections without a read policy; unique indexes on sensitive fields where untrusted callers insert | warn |
| TLS to MongoDB; `CANOPY_MASTER_KEY` present and strong | error in production |
| Clock skew against MongoDB (`hello.localTime`) under 5 s | warn |
| JWKS reachable, algorithm pinned, issuer and audience set (external mode) | error |
| CORS origins configured for browser use | warn |

## 8. Project layout and config

```
my-app/
├─ canopy/
│  ├─ canopy.config.ts        # defineConfig(...), see 01 §9
│  ├─ policies/
│  │  ├─ _context.ts          # $ctx lookups
│  │  ├─ todos.ts
│  │  └─ todos.test.ts
│  └─ .env.example
├─ src/canopy.gen.ts          # generated types (committed)
└─ …your existing app (unchanged)
```

## 9. Workflows

1. **Local loop:** `canopy dev --with-mongo`, edit `policies/*.ts` (hot reload), try it in Studio's simulator,
   then `canopy policies test`.
2. **GitOps.** In a pull request, CI runs `canopy policies lint && canopy policies test && canopy gen types --check`.
   On merge, the deploy job runs
   `canopy policies push --env production --expect-version $(cat .canopy/production.version) --comment "$GIT_SHA"`.
   A nightly `canopy policies diff --env production --fail-on-drift` catches edits made in Studio that never
   reached Git.
3. **Studio-first teams** edit in Studio, then run `canopy policies pull` to bring the published state into Git
   as TS DSL files.
