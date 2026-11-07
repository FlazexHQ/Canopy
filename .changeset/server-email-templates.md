---
"@canopy/server": minor
---

Edit built in auth's email templates from Studio: `GET /admin/v1/auth/templates` lists every kind with the
template in force, `POST /admin/v1/auth/templates/{kind}/preview` renders the current template or a draft
with test data, `PUT /admin/v1/auth/templates/{kind}` saves an edit with `expectedVersion` (a concurrent
edit answers `409`), `DELETE` resets a kind to its default, and `GET /admin/v1/auth/templates/history` lists
the versions. Templates use `{{appName}}`, `{{email}}`, `{{url}}`, `{{otp}}` and `{{newEmail}}`; an edit must
keep the link or code its kind needs and may not add scripts, and values are escaped in the HTML body. The
current set and every version live in `canopy.settings`, each change is audited, and the mailer renders
the version in force on every node.
