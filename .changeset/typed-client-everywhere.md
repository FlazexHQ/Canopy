---
"@canopy/client": minor
"@canopy/devtools": patch
"@canopy/solid": minor
"@canopy/vue": patch
"@canopy/svelte": patch
---

Typed clients work everywhere an untyped one did: `attachDevtools`, `watchMistakes`, Solid's `createCanopyStatus`, Vue's `useCanopyStatus` and Svelte's `canopyStatus` accept a client created with a `Database` type. Solid gains `CanopyProvider`, which provides a typed client (`CanopyContext.Provider` only took an untyped one). The `id` of an insert's handle is typed from the collection's documents instead of `unknown`.
