# Changesets

Every pull request that changes a published package adds a changeset:

```bash
bun run changeset
```

Before 1.0 all `@canopy/*` packages share one fixed version. Private workspace packages (tools, examples) are
never versioned or published. Details: https://github.com/changesets/changesets

Changesets versions every `@canopy/*` package, `@canopy/native` and `@canopy/realtime` included. Those two
and their platform packages are published only by the [native release workflow](../.github/workflows/native-release.yml)
from its assembled tarballs, which carry the platform optional dependencies. Publish the other packages first,
because `@canopy/realtime` depends on them, and never publish `@canopy/native` or `@canopy/realtime` from the
workspace, which would ship them without their platform packages.
