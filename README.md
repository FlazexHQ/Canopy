# Canopy

> **Canopy** is a working name. The final name, npm scope and GitHub organization are still being decided.

Canopy is an open source, self hostable backend platform for MongoDB: realtime live queries, Document Level
Security (rules in the style of Postgres Row Level Security), auth, generated REST and GraphQL APIs, and an admin
dashboard. It works with an existing MongoDB deployment without changing its schema.

**Status: Phase 0 (foundations).** The repository contains the monorepo toolchain and CI only. No package is
published yet.

## Requirements

- [Bun](https://bun.com) 1.4 or newer (primary runtime and the repository's package manager)
- Node.js 24 or newer (fully supported secondary runtime)
- Docker, for the local MongoDB replica set

## Getting started

```bash
bun install
bun run db:up      # single node MongoDB replica set on localhost:27017
bun run db:smoke   # checks change streams and transactions against it
```

Connect with `mongodb://localhost:27017/?replicaSet=rs0`. Change streams and transactions need a replica set;
they do not work on a standalone server.

## Common tasks

| Task                        | Command             |
| --------------------------- | ------------------- |
| Type check every project    | `bun run typecheck` |
| Lint and check formatting   | `bun run lint`      |
| Format                      | `bun run format`    |
| Run every test suite        | `bun run test:all`  |
| Run tests through Turborepo | `bun run test`      |
| Add a changeset             | `bun run changeset` |
| Stop the database           | `bun run db:down`   |

## Repository layout

| Path              | Contents                                                              |
| ----------------- | --------------------------------------------------------------------- |
| `packages/`       | Libraries published as `@canopy/*` (added from Phase 1)               |
| `apps/`           | Applications such as Studio and the docs site                         |
| `deploy/`         | Docker Compose files and deployment assets                            |
| `tsconfig.*.json` | Shared TypeScript 6 settings: `server`, `universal`, `web` and `edge` |

## Contributing

The contribution guide, Code of Conduct, security policy and governance model are being drafted and will be
published before the project accepts outside contributions. Commits follow Conventional Commits and are signed
off (`git commit -s`).

Never report a security vulnerability in a public issue. Use GitHub private vulnerability reporting.

## License

The license has not been ratified yet. Apache 2.0 is proposed. Until a `LICENSE` file is added, no license is
granted.
