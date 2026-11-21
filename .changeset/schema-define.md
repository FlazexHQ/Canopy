---
"@canopy/schema": minor
---

`@canopy/schema/define` declares collections in code: `collection("todos", { title: t.string(), done:
t.bool().default(false) })` and `defineSchema(...)`. Each field builder carries its TypeScript type, so the
stored document, insert and merge patch types are inferred, and the `_id` builder decides whether the client
generates the ID (ObjectId, UUIDv7 or `.generate()`) or the caller must supply it. A definition converts to
the existing shape for sampling and validators, fills defaults and generated IDs through `prepare()`, and
implements Standard Schema for validating decoded documents. The subpath imports only `@canopy/protocol`.
