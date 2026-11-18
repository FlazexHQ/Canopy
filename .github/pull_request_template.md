## What and why

<!-- Describe the change and the problem it solves. Link the issue or RFC. The base branch is `master`. -->

## Checklist

- [ ] The commits follow Conventional Commits and are signed off (`git commit -s`)
- [ ] Tests cover the change, including failure paths, and can fail: nothing is asserted just because the code returns it, no error is swallowed, no assertion is skipped or weakened to get green
- [ ] Docs are updated for any user visible change
- [ ] A changeset is added (`bun run changeset`), or this change does not affect a published package
- [ ] Changes to `api/*.api.md` (the public API, regenerated with `bun run api`) are intended, and a breaking one is a major changeset
- [ ] `bun run check` passes locally (lint, type check, unused exports, documented exports, tests); the MongoDB suites ran against a replica set (`CANOPY_TEST_MONGODB_URI`)

## Repository rules

- [ ] No dashes as punctuation (em dash, en dash, or a spaced hyphen) in code, comments, docs, strings, errors, commit messages or this description (`bun tools/repo-check/src/cli.ts workspace dashes`)
- [ ] MongoDB vocabulary: documents, collections, fields and databases, never rows, tables, columns or records
- [ ] Comments only where they document (TSDoc on exported APIs) or explain something genuinely complex; no narration of what the code does, no references to planning documents
- [ ] No `any`, no non null assertions in library code; errors are `CanopyError` with a stable `code`; universal packages (`protocol`, `matcher`, `query`, `policy`) use no `node:` imports
- [ ] Scripts, hooks and paths work on Windows, Linux and macOS (no inline env assignment, POSIX utilities or shell globs in `package.json`)
- [ ] New dependencies are MIT, Apache 2.0, BSD or ISC; a server package says why it needs the dependency
- [ ] Nothing adds fields to user documents or creates collections in the app database

## Phase gate

<!-- Skip this section for fixes, docs and tests that add no feature. -->

- [ ] If this adds a feature package or entry point, the gate of the previous phase in the roadmap (`docs/plan/12-roadmap.md`, "Gate before Phase 4" and its equivalents) is met: its P1 review items are done, the security review is recorded under `docs/reviews/`, and no high or critical audit finding is open
- [ ] No P0 item of the improvement plan (`plans/README.md`, workstream A) is open
- [ ] The phase exit criteria this change belongs to are still achievable, or the roadmap is updated in this pull request

## Security impact

<!-- Does this touch policy evaluation, query sanitizing, the matcher, auth, the wire protocol or any trust
boundary? If yes, explain how the fail closed behavior and the DLS invariants are preserved. If no, say "None". -->

- [ ] DLS invariants I1 to I6 (`docs/plan/09-security.md` §4.2) still hold: unknown operators, missing variables, policy errors and timeouts deny; one policy engine decides for REST, GraphQL, realtime and Studio's "view as user"; field rules apply to filters, sorts and results; a new entry point goes through the same read and write paths
- [ ] The property and differential tests for policy, query and matcher still pass and cover any new operator or path
