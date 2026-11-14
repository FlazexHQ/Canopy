---
title: Key rotation
description: Rotate API keys, the master key and the built in auth signing keys without downtime.
---

## API keys

Keys from the configuration (`CANOPY_PUBLISHABLE_KEYS`, `CANOPY_SECRET_KEYS`) are lists, so rotation is a
rolling change:

1. Add the new key next to the old one (`canopy_pk_new,canopy_pk_old`) and roll it out to every instance.
2. Ship your apps and servers with the new key.
3. Remove the old key and roll out again. Requests with it now get `401`.

Keys created in Studio or with `canopy keys create` live in the meta database: create the new key, deploy it,
then revoke the old one in Studio (API keys) or with `canopy keys revoke <id>`. The revocation reaches every
instance through a change stream and closes the realtime connections that used the key.

## Master key

`CANOPY_MASTER_KEY` seals the secrets Canopy stores (TOTP secrets, signing keys, OAuth client secrets). To
rotate it:

1. Generate a new key: `openssl rand -base64 32`.
2. On every instance set `CANOPY_MASTER_KEY` to the new key and `CANOPY_MASTER_KEY_PREVIOUS` to the old one, and
   roll out. Both keys open secrets now; new secrets are sealed with the new one.
3. Seal the stored secrets again: Studio, Settings, Danger zone, Rotate master key (or
   `POST /admin/v1/settings/rotate-master-key` with the confirmation phrase `rotate master key`). The audit log
   records it as `danger.rotate_master_key`.
4. Remove `CANOPY_MASTER_KEY_PREVIOUS` and roll out again.

Backups taken before step 3 can only be opened with the old key: keep it as long as you keep them.

## Built in auth signing keys

Access tokens are signed with keys in `canopy_auth.signing_keys`, rotated automatically: every
`auth.keyRotation.interval` (30 days) a standby key, already published in the JWKS, becomes active, and retired
keys stay published for `auth.keyRotation.grace` (30 days), so tokens and remote verifiers keep working. One
instance at a time does this, holding a lease.

To rotate now, use Studio, Auth, Signing keys, Rotate, or `POST /admin/v1/auth/keys/rotate`. Tokens signed
before stay valid until they expire (10 minutes by default). After a suspected leak, also revoke the leaked key
there, which removes it from the JWKS at once, and sign everyone out.

## Identity provider keys

With an external identity provider Canopy fetches its JWKS from `CANOPY_JWT_JWKS_URL` and fetches it again when
a token names a key it does not know, so the provider's own rotation needs nothing on the Canopy side.
