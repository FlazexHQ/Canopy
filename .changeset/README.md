# Changesets

Every pull request that changes a published package adds a changeset:

```bash
bun run changeset
```

Before 1.0 all `@canopy/*` packages share one fixed version. Private workspace packages (tools, examples) are
never versioned or published. Details: https://github.com/changesets/changesets
