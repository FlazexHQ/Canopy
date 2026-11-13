---
"@canopy/cli": patch
---

`canopy --version` works in the standalone executable, which has no `package.json` next to it. `deploy/binary/build.ts` embeds the version, and now loads `reflect-metadata` first so the executables start again: Bun's bundler ran it after tsyringe (a dependency of the passkey support), which stopped both executables at startup.
