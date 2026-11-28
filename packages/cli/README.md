# @canopy/cli

The `canopy` command line. Every command reads `canopy.config.ts` (or `canopy/canopy.config.ts`), found by
walking up from the working directory, plus the `CANOPY_*` variables. `--mongodb-uri`, `--database`, `--dir`
and `--config` override them. Unknown commands and options fail with a suggestion. Run `canopy --help` for
every option.

Install with your package manager, or run `npx --package @canopy/cli canopy --help` without adding it
to your project. The package manager installs the prebuilt executable for your platform as an optional
dependency. Set `CANOPY_BINARY` to use a local executable, and `CANOPY_STUDIO_DIR` to serve a custom Studio build.
