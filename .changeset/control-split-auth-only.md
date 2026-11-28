---
"@canopy/control": minor
---

`CANOPY_SPLIT_AUTH_ONLY=on` runs the TypeScript control plane as the auth service of the split stack: it serves only `/auth/v1`, the key set, `/admin/v1/users` and health, and leaves migrations, policy publishing, webhooks and the rest of `/admin/v1` to the Rust `control` role of the `canopy` image.
