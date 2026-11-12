---
title: Studio
description: The admin dashboard served by canopy-server at /studio.
---

Studio is the web dashboard of a Canopy project, served at `/studio` by the platform server. Admins sign in
with their own accounts (owner, admin, developer or viewer), separate from your app's users, and every change
they make is written to the audit log.

| Page           | What it does                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | The state of the deployment at a glance                                                                                               |
| Data           | Browse, filter, edit, import and export documents; follow a query live; **view as** a user to see exactly what policies give them     |
| Policies       | Edit policies with lint findings, a simulator that explains each decision, a diff against the published version, history and rollback |
| Realtime       | Live statistics, a tail of the change stream, and a trace of how one event was routed and filtered                                    |
| API            | The REST reference generated from OpenAPI, code snippets, the GraphQL explorer and API keys                                           |
| Auth           | Users, sessions, bans, email templates and provider settings of built in auth                                                         |
| Logs and audit | Sampled request logs, policy denials and the audit log                                                                                |
| Doctor         | The checks of `canopy doctor`, run against the live deployment                                                                        |
| Settings       | Request log sampling, retention and the admin IP allowlist                                                                            |

## View as user

The Data page and the GraphQL explorer can impersonate a caller: pick roles and claims, and Studio runs reads
with exactly the policies that caller gets. Impersonated sessions are read only, and each one is audited.

## Production

With `environment: "production"`, developers may not publish policies, publishing needs a comment, and
GraphQL mutations from Studio are refused. Keep Studio on a private listener with `server.adminListen`, or
restrict it with the admin allowlist.
