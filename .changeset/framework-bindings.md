---
"@canopy/vue": minor
"@canopy/svelte": minor
"@canopy/solid": minor
---

Add the Vue, Svelte 5 and Solid bindings. `@canopy/vue` has `useQuery` returning `ShallowRef`s (a getter or ref follows a query that depends on reactive values), `useMutation` with `pending` and `error`, `useCanopyStatus`, and `canopyPlugin(client, state?)`, which also hydrates server rendered results for Nuxt. `@canopy/svelte` has `createQuery`, a rune friendly object whose properties are reactive in templates, `$derived` and `$effect` and which is also a store, plus `canopyStatus`, `setCanopy` and `getCanopy`. `@canopy/solid` has `createQuery` with signals (an accessor follows a changing query), `createCanopyStatus`, `CanopyContext` and `useCanopy`. Every binding passes the protocol vectors.
