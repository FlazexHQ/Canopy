---
"@canopy/cli": minor
"@canopy/config": minor
---

Add `canopy init`, `canopy dev [--with-mongo]`, `canopy realtime enable-images | disable-images` and
`canopy indexes advise | create`. `init` adds a `canopy/` folder to an existing project (config, closed
starter policy templates, `.env.example`, and with `--mongodb-uri` one closed policy file per collection)
and never overwrites a file. `dev` runs Canopy from the project config with env files, hot reloads
policies, restarts on config edits, generates session keys when none are configured, and with
`--with-mongo` starts a single node replica set from the official MongoDB Community image. The realtime
and index commands print the exact command and ask before changing the database (`--yes` skips the
question). `loadConfig` takes `fresh: true` to import an edited config file again.
