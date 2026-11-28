---
title: CLI
description: Every canopy command and option.
---

```bash
bun add -d @canopy/cli
bunx --package @canopy/cli canopy --help
```

Commands read `canopy.config.ts` (or `canopy/canopy.config.ts`), found by walking up from the working
directory, plus the `CANOPY_*` variables. `--config`, `--dir`, `--mongodb-uri` and `--database` override them.
Unknown commands and options fail with a suggestion. Commands that change a database print what they will do
and ask first; without a terminal they refuse unless `--yes` is given.

## Local work

| Command                                  | What it does                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `canopy init [--mongodb-uri <uri>]`      | Adds `canopy/` with the config, starter policies and `.env.example`; never overwrites   |
| `canopy dev [--with-mongo] [--port <n>]` | Runs Canopy with hot reload; `--with-mongo` starts a replica set (Docker, else binaries) |
| `canopy doctor`                          | Checks MongoDB, change streams, policies and indexes; exits 1 on errors                 |
| `canopy policies lint`                   | Validates and lints the policy directory                                                |
| `canopy policies test`                   | Runs policy tests in memory and, with `--mongodb-uri`, against MongoDB                  |
| `canopy policies explain <collection>`   | Shows how policies decide an operation (`--as`, `--roles`, `--op`, `--filter`, `--ctx`) |
| `canopy pull [--js] [--collection <name>]` | Writes `canopy.schema.ts` from validators, config and sampled documents; refuses to overwrite edits without `--force` ([guide](/guides/schema/)) |
| `canopy schema diff [--file <path>]`     | Compares the schema file with MongoDB and exits 1 on drift                              |
| `canopy config print [--sources]`        | Prints the resolved config, secrets masked                                              |

## Database changes

| Command                                                           | What it does                                      |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `canopy realtime enable-images \| disable-images <collection...>` | Turns change stream pre and post images on or off |
| `canopy indexes advise \| create`                                 | Suggests, then creates, indexes for policy fields |
| `canopy migrate [--status]`                                       | Brings the meta database up to date               |
| `canopy schema push [--file <path>] [--yes]`                      | Applies the schema file's validators (asks first) |

## Policies in the meta database

| Command                                                  | What it does                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `canopy policies diff [collection...] [--fail-on-drift]` | Compares the folder with the published policies                              |
| `canopy policies push [collection...]`                   | Publishes changed collections (`--expect-version`, `--comment`, `--dry-run`) |
| `canopy policies pull [collection...] [--force]`         | Writes the published policies as TypeScript                                  |
| `canopy policies history <collection> [--limit <n>]`     | Lists published versions                                                     |
| `canopy policies rollback <collection> <version>`        | Republishes an earlier version as a new one                                  |

A GitOps setup runs `canopy policies lint && canopy policies test && canopy schema diff` on pull
requests and `canopy policies push --env production --comment "$GIT_SHA"` on merge.

## Users, keys and admins

| Command                                                   | What it does                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `canopy auth import <file> --from <system>`               | Imports users from `firebase`, `auth0`, `cognito` or `csv` ([guide](/guides/importing-users/)) |
| `canopy keys list \| create \| revoke <id>`               | API keys; `create --kind publishable\|secret --name <name>`                                    |
| `canopy admin list \| create \| reset-totp <id or email>` | Studio admins; `create --email <email> --role <role>`                                          |
| `canopy admin tokens create \| list \| revoke <id>`       | Long lived admin API tokens for CI                                                             |

## Remote projects

`canopy login <url> [--env <name>]` checks an admin token and stores it in the OS keychain (macOS Keychain,
the Linux Secret Service). On Windows the token goes to `%APPDATA%\canopy\credentials.json`, encrypted for
your Windows account with DPAPI (the protection Credential Manager uses; any program running as you can
still decrypt it, as with the other keychains), and a token that an older version saved in plain text is
encrypted the next time it is read. Elsewhere without a keychain it is a credentials file with mode 0600. With `--env <name>`, `policies push`, `diff`,
`pull`, `history`, `rollback`, `auth import` and `admin tokens` work on that project through its admin API.
`CANOPY_ADMIN_URL` and `CANOPY_ADMIN_TOKEN` override the stored login, which is how CI jobs authenticate.
`canopy logout <url>` removes the token.
