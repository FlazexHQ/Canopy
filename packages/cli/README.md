# @canopy/cli

The `canopy` command line. Every command reads `canopy.config.ts` (or `canopy/canopy.config.ts`), found by
walking up from the working directory, plus the `CANOPY_*` variables. `--mongodb-uri`, `--database`, `--dir`
and `--config` override them. Unknown commands and options fail with a suggestion. Run `canopy --help` for
every option.

## Local work

| Command                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy init [--mongodb-uri <uri>]`       | Adds `canopy/` to an existing project: the config, starter policy templates in `canopy/policies/templates` (owner only, tenant scoped, public read owner write, write only intake), `.env.example`, and `.gitignore` rules for env files. With a URI it writes one policy file per collection, with a template suggested from a sampled document. Everything starts with `exposed: false`. It never overwrites a file and never creates an app.                                          |
| `canopy dev [--with-mongo] [--port <n>]`  | Runs Canopy from the config with `.env`, `.env.local`, `.env.development` and `.env.development.local` loaded. Policies hot reload; config and env file edits restart the server, and an invalid edit keeps the running one. Without configured keys it generates a publishable and a secret key for the session. `--with-mongo` starts a single node replica set from `mongodb/mongodb-community-server` in Docker, with the data in a named volume, and waits until it is the primary. |
| `canopy doctor`                           | Preflight checks; exits 1 on errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `canopy policies lint \| test \| explain` | Validate, test and explain the policy directory.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canopy gen types [--check]`              | Generates the `Database` types.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `canopy config print [--sources]`         | Prints the resolved config, secrets masked.                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Changing a database

These print the exact command first and ask before running it. Without a terminal they refuse unless
`--yes` is given.

| Command                                                           | What it does                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy realtime enable-images \| disable-images <collection...>` | Runs `collMod` with `changeStreamPreAndPostImages`. Missing collections are refused, not created.                                                                                                     |
| `canopy indexes advise \| create`                                 | Suggests ascending indexes for the equality fields of `using` clauses and context lookup `where` clauses, skipping what existing indexes serve. `create` builds them, only on collections that exist. |

## Policies in the meta database

| Command                                                                                 | What it does                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy migrate [--status]`                                                             | Brings the meta database up to date. The other meta commands refuse to run on an unmigrated one.                                                                                                                                                                                                            |
| `canopy policies diff [--fail-on-drift]`                                                | Compares the policy directory with the published policies by hash and explains each difference.                                                                                                                                                                                                             |
| `canopy policies push [--expect-version <v>] [--comment <text>] [--dry-run]`            | Publishes the collections whose content changed. Each publish is conditional on a version: `--expect-version 3` for a single collection, or `todos=3,notes=5`; without it, the version read at the start. Every expectation is checked before anything is published. Ends with `versions: notes=5,todos=4`. |
| `canopy policies pull [--force]`                                                        | Writes the published policies as TypeScript modules, then checks that they reproduce each published hash.                                                                                                                                                                                                   |
| `canopy policies history <collection>`                                                  | Lists the published versions.                                                                                                                                                                                                                                                                               |
| `canopy policies rollback <collection> <version>`                                       | Republishes an earlier version as a new one, after confirmation.                                                                                                                                                                                                                                            |
| `canopy keys list \| create --kind publishable\|secret --name <name> \| revoke <id>`    | API keys. A secret key is shown once, at creation.                                                                                                                                                                                                                                                          |
| `canopy admin list \| create --email <email> --role <role> \| reset-totp <id or email>` | Admin accounts, straight in the meta database for bootstrapping. `create` prints a generated password that must be changed at first login; creating an owner also claims the server. `reset-totp` asks first.                                                                                               |

A GitOps setup runs `canopy policies lint && canopy policies test && canopy gen types --check` on pull
requests, `canopy policies push --expect-version "$(cat .canopy/production.version)" --comment "$GIT_SHA"`
on merge, and `canopy policies diff --fail-on-drift` nightly.

## Remote projects

`canopy login <url>` stores an admin token for a remote project. The token comes from `--token`, then
`CANOPY_ADMIN_TOKEN`, then a prompt that does not echo (or standard input when piped). Tokens are sent only
over HTTPS, except to localhost. `canopy logout <url>` removes it.

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
