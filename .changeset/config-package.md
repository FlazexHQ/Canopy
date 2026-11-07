---
"@canopy/config": minor
---

Add `@canopy/config`, the Canopy config file. `defineConfig()` takes a typed config object or a function of
`{ mode, command }`. `env()`, `env.int`, `env.bool`, `env.list`, `env.url`, `env.duration` and `env.secret`
read variables, so every missing variable is reported at once and secrets are redacted. `external()` and the
`external.auth0`, `external.clerk`, `external.firebase` and `external.supabase` presets configure tokens from
an identity provider. Validation reports every problem together with its path and a suggestion for typos,
only requires what the command uses, refuses insecure settings (HTTP JWKS outside localhost, HMAC
algorithms, development switches or `*` CORS in production, a missing master key for the server in
production), and fails when the file and a well known `CANOPY_*` variable disagree; without a config file the
variables configure everything as before. `loadConfig()` from `@canopy/config/load` finds
`canopy.config.ts` or `canopy/canopy.config.ts`, optionally loads `.env` files, and `formatConfig()` prints
the resolved config with secrets masked and the source of each value.
