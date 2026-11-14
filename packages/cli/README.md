# @canopy/cli

The `canopy` command line. Every command reads `canopy.config.ts` (or `canopy/canopy.config.ts`), found by
walking up from the working directory, plus the `CANOPY_*` variables. `--mongodb-uri`, `--database`, `--dir`
and `--config` override them. Unknown commands and options fail with a suggestion. Run `canopy --help` for
every option.

## Local work

| Command                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy init [--mongodb-uri <uri>]`       | Adds `canopy/` to an existing project: the config, starter policy templates in `canopy/policies/templates` (owner only, tenant scoped, public read owner write, write only intake), `.env.example`, and `.gitignore` rules for env files. With a URI it writes one policy file per collection, with a template suggested from a sampled document. Everything starts with `exposed: false`. It never overwrites a file and never creates an app.                                                                                                                                                                                                                                                                                                                                                                                              |
| `canopy dev [--with-mongo] [--port <n>]`  | Runs Canopy from the config with `.env`, `.env.local`, `.env.development` and `.env.development.local` loaded. Policies hot reload; config and env file edits restart the server, and an invalid edit keeps the running one. Without configured keys it generates a publishable and a secret key for the session. `--with-mongo` starts a single node replica set and waits until it is the primary: from `mongodb/mongodb-community-server` in Docker (data in a named volume) when Docker runs, otherwise from the official binaries, downloaded once into a per user cache (`CANOPY_MONGO_CACHE` moves it) with the data in `.canopy/mongodb`; `--mongo-binary` forces the binaries and `--mongo-version` picks their version. It prints the REST, realtime, GraphQL and Studio URLs, and the setup token while the project has no owner. |
| `canopy doctor`                           | Preflight checks; exits 1 on errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canopy policies lint \| test \| explain` | Validate, test and explain the policy directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `canopy gen types [--check \| --watch]`   | Generates the `Database` types: from each collection's JSON Schema validator when it has one, else the configured schema, else sampled documents. `--watch` regenerates when a policy file changes or a collection is created, dropped, renamed or gets a new validator; `canopy dev` does the same while the types file exists (or with `--types`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canopy config print [--sources]`         | Prints the resolved config, secrets masked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Changing a database

These print the exact command first and ask before running it. Without a terminal they refuse unless
`--yes` is given.

| Command                                                           | What it does                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy realtime enable-images \| disable-images <collection...>` | Runs `collMod` with `changeStreamPreAndPostImages`. Missing collections are refused, not created.                                                                                                     |
| `canopy indexes advise \| create`                                 | Suggests ascending indexes for the equality fields of `using` clauses and context lookup `where` clauses, skipping what existing indexes serve. `create` builds them, only on collections that exist. |

## Policies in the meta database

| Command                                                                                 | What it does                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy migrate [--status]`                                                             | Brings the meta database up to date. The other meta commands refuse to run on an unmigrated one.                                                                                                                                                                                                                                                         |
| `canopy policies diff [--fail-on-drift]`                                                | Compares the policy directory with the published policies by hash and explains each difference.                                                                                                                                                                                                                                                          |
| `canopy policies push [--expect-version <v>] [--comment <text>] [--dry-run]`            | Publishes the collections whose content changed. Each publish is conditional on a version: `--expect-version 3` for a single collection, or `todos=3,notes=5`, where `_context=2` pins the context lookups; without it, the version read at the start. Every expectation is checked before anything is published. Ends with `versions: notes=5,todos=4`. |
| `canopy policies pull [--force]`                                                        | Writes the published policies as TypeScript modules, then checks that they reproduce each published hash.                                                                                                                                                                                                                                                |
| `canopy policies history <collection>`                                                  | Lists the published versions.                                                                                                                                                                                                                                                                                                                            |
| `canopy policies rollback <collection> <version>`                                       | Republishes an earlier version as a new one, after confirmation.                                                                                                                                                                                                                                                                                         |
| `canopy keys list \| create --kind publishable\|secret --name <name> \| revoke <id>`    | API keys. A secret key is shown once, at creation.                                                                                                                                                                                                                                                                                                       |
| `canopy admin list \| create --email <email> --role <role> \| reset-totp <id or email>` | Admin accounts, straight in the meta database for bootstrapping. `create` prints a generated password that must be changed at first login; creating an owner also claims the server. `reset-totp` asks first.                                                                                                                                            |
| `canopy admin tokens create \| list \| revoke <id> --env <name>`                        | Long lived admin API tokens for CI on a remote project. `create --name <name> [--role <role>] [--expires <days>]` prints the token once; `list [--all]` shows expiry, last use and state; `revoke` asks first.                                                                                                                                           |

A GitOps setup runs `canopy policies lint && canopy policies test && canopy gen types --check` on pull
requests,
`canopy policies push --env production --expect-version "$(cat .canopy/production.version)" --comment "$GIT_SHA"`
on merge, and `canopy policies diff --env production --fail-on-drift` nightly (see
[Environments](#environments)).

## Remote projects

`canopy login <url> [--env <name>]` stores an admin token for a remote project. The token comes from
`--token`, then `CANOPY_ADMIN_TOKEN`, then a prompt that does not echo (or standard input when piped).
Before anything is stored the token is checked with `GET <url>/admin/v1/me`: a token the server refuses, a
server that does not answer, or an address without a Canopy admin API stores nothing and exits 1. With a
private admin listener (`CANOPY_ADMIN_LISTEN`), log in to that address. Tokens are sent only over HTTPS,
except to localhost. `canopy logout <url>` removes the token.

Two kinds of admin token work here. Bearer sessions from `POST /admin/v1/login` with
`"transport": "bearer"` end like Studio sessions do (12 hours, 1 hour idle). Admin API tokens
(`canopy_pat_...`) are long lived, for CI: see [Admin API tokens for CI](#admin-api-tokens-for-ci).

Where the token is kept:

1. **macOS:** the login Keychain, through `security`, as a generic password with service `canopy` and the
   project URL as the account.
2. **Linux:** the Secret Service (GNOME Keyring, KWallet), through `secret-tool`, with the attributes
   `service=canopy` and `account=<url>`. The token is passed on standard input.
3. **Fallback**, when neither tool works (Windows, headless Linux, containers): a JSON file at
   `$XDG_CONFIG_HOME/canopy/credentials.json`, or `~/.config/canopy/credentials.json`, mapping project URLs
   to tokens. It is created with mode `0600` in a `0700` directory, but the token is stored **in plain
   text**, so it is only as safe as the account that owns the file. Set `CANOPY_CREDENTIALS=<path>` to use
   a file of your choice and skip the keychain.

On macOS `security` receives the token as an argument, so it is briefly visible to other processes of
the same user.

## Environments

`--env <name>` points `canopy policies push`, `diff`, `pull`, `history` and `rollback` (and `canopy admin
tokens`) at a remote project, through its admin API instead of a MongoDB connection. Publishing and rolling
back then run as the admin the token belongs to, with that admin's role and the server's production rules
(a comment is required, developers may not publish), and the history and audit log name that admin.

| Setting                  | Where it comes from                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The project URL          | `CANOPY_ADMIN_URL`, else the project saved by `canopy login <url> --env <name>`                                                                     |
| The admin token          | `CANOPY_ADMIN_TOKEN`, else the token stored for that URL                                                                                            |
| `CANOPY_ENV` for config  | `--env production` and `--env development` set it, so `defineConfig(({ mode }) => ...)` sees that mode; other names leave it as it is               |
| The server's environment | checked with `GET /admin/v1/me`: `--env production` refuses a server that does not run with `CANOPY_ENV=production`, and the same for `development` |

The names are saved in `environments.json` next to the credentials file (`$CANOPY_ENVIRONMENTS` overrides
the path); it holds URLs only, never tokens. A deploy job typically sets `CANOPY_ADMIN_URL` and
`CANOPY_ADMIN_TOKEN` from its secrets and runs

```sh
canopy policies push --env production --expect-version "$(cat .canopy/production.version)" --comment "$GIT_SHA"
```

The last line of a push (`versions: notes=5,todos=4`) is the content of `.canopy/production.version` for
the next run; add `_context=<n>` to it when the project has context lookups.

## Admin API tokens for CI

A CI job should not depend on a login that expires. Create a long lived admin API token once, from a
machine where you are logged in with a session:

```sh
canopy login https://canopy.example.com --env production
canopy admin tokens create --env production --name "github deploy" --role admin --expires 365
```

The token is printed once; store it in the CI secret store. Its role may not be higher than yours (it
defaults to yours), and it never does more than your account currently may: demoting or disabling you
demotes or stops your tokens. In production developers may not publish, so a token that pushes policies
needs the `admin` role. `canopy admin tokens list [--all]` shows the tokens with their expiry, last use and
state, and `canopy admin tokens revoke <id>` ends one at once. Tokens cannot create or revoke tokens,
manage admins or change credentials, so these commands need a session login.

In the job, set the URL and the token from secrets; no `canopy login` is needed:

```yaml
- run: bunx canopy policies push --env production --expect-version "$(cat .canopy/production.version)" --comment "$GITHUB_SHA"
  env:
    CANOPY_ADMIN_URL: https://canopy.example.com
    CANOPY_ADMIN_TOKEN: ${{ secrets.CANOPY_ADMIN_TOKEN }}
```

Every use of a token is in the audit log as `admin_token.use`, and changes made with it carry the token id.
