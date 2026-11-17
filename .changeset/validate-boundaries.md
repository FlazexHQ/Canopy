---
"@canopy/policy": minor
"@canopy/protocol": minor
"@canopy/auth": minor
"@canopy/config": patch
"@canopy/realtime": patch
"@canopy/rest": patch
"@canopy/server": patch
"@canopy/auth-builtin": patch
---

Validate data where it crosses a boundary instead of casting it. Documents read from `canopy.policies` are
checked by the new `readStored` and `contextsFromStored` (and a stricter `fromStored`): a policy with an
unknown kind or operation, roles or field rules of the wrong type, or a context lookup without its fields is
refused with a `TypeError` naming the problem, on the server and in the realtime sidecar. The change stream
ingestor resynchronizes subscribers (restart reason `malformed_event`) when the driver returns a value that is
not an event document, instead of handing it on. An inline `auth.jwks` must be a `keys` array of objects
(`auth.jwks` problem), and `parseJsonWebKeySet` keeps only the standard JWK parameters with their types. An
email transport without its required fields is a config problem. `POST /admin/v1/users/import` checks each
password hash with `parseImportedPasswordHash` and reports a malformed one as a failure of that user. The
built in auth engine's session and user are checked before use. `snapshotTimeOf` reads the snapshot time of
a driver session in one tested place.
