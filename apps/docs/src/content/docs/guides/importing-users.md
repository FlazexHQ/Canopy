---
title: Importing users
description: Move users from Firebase, Auth0, Cognito or a CSV file into built in auth, password hashes included.
---

`canopy auth import` reads an export file and creates the users in built in auth through the admin API of a
project. Users keep their passwords where the export includes hashes: the old hash is checked at their first
sign in and replaced with a fresh one.

```bash
canopy auth import users.json --from firebase --env production --dry-run
canopy auth import users.json --from firebase --env production \
  --hash-key "$FIREBASE_SIGNER_KEY" --salt-separator Bw== --rounds 8 --mem-cost 14
```

`--dry-run` only reads the file and reports how many users it found, how many have password hashes and which
entries it skips. Without it, users go to the server in batches of 500; users that already exist are left
alone, and failures are listed with their email. The command exits with 1 when any user failed.

## Sources

| `--from`   | File                                        | Passwords                                                      |
| ---------- | ------------------------------------------- | -------------------------------------------------------------- |
| `firebase` | `firebase auth:export users.json`           | Firebase's modified scrypt, with the project's hash parameters |
| `auth0`    | A bulk user export (newline delimited JSON) | bcrypt hashes, when Auth0 support included them                |
| `cognito`  | A user pool CSV export                      | Cognito never exports passwords; users reset theirs            |
| `csv`      | Your own CSV                                | `bcrypt`, `argon2id`, or PBKDF2 with salt and iterations       |

Firebase's hash parameters (signer key, salt separator, rounds and memory cost) are on the Authentication
page of the Firebase console under "Password hash parameters". Without `--hash-key`, Firebase users are
imported without passwords.

Social identities (Google, GitHub, Apple, Microsoft and others) are linked by provider and subject, so those
users sign in with the same provider as before. The original id is kept in
`app_metadata.importedFrom` as `{ system, id }`.

## Generic CSV

| CSV field             | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `email`               | Required                                                                 |
| `id`                  | The user's id in the old system, kept in `app_metadata.importedFrom`     |
| `email_verified`      | `true` or `false`                                                        |
| `name`                |                                                                          |
| `created_at`          | An ISO 8601 date                                                         |
| `roles`               | Roles separated by `;`                                                   |
| `password_hash`       | The hash, in the algorithm's usual encoding                              |
| `password_algorithm`  | `bcrypt`, `argon2id` or `pbkdf2-sha256`; bcrypt is recognized without it |
| `password_salt`       | For PBKDF2, base64                                                       |
| `password_iterations` | For PBKDF2                                                               |
| `disabled`            | `true` imports the user disabled                                         |

Lines are RFC 4180 CSV with LF or CRLF line ends.

## Without the CLI

`POST /admin/v1/users/import` takes `{ "users": [...] }` with up to 1000 users per request and needs the
`users.manage` permission. Every import is written to the audit log.
