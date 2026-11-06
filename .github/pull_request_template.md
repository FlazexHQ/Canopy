## What and why

<!-- Describe the change and the problem it solves. Link the issue or RFC. -->

## Checklist

- [ ] The commits follow Conventional Commits and are signed off (`git commit -s`)
- [ ] Tests cover the change, including failure paths, and can fail
- [ ] Docs are updated for any user visible change
- [ ] A changeset is added (`bun run changeset`), or this change does not affect a published package
- [ ] `bun run lint`, `bun run typecheck` and `bun run test:all` pass locally

## Security impact

<!-- Does this touch policy evaluation, query sanitizing, the matcher, auth, the wire protocol or any trust
boundary? If yes, explain how the fail closed behavior and the DLS invariants are preserved. If no, say "None". -->
