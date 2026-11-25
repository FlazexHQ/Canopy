# Split deployment

Use `deploy/compose/split.yaml`, set `split.enabled=true` in the Helm chart, or apply
`deploy/kubernetes/split.yaml` with an external MongoDB replica set. Route public HTTP traffic to the edge.

| Service | Image                                                             | Routes                                                                                             |
| ------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Data    | `canopy`                                                          | REST, GraphQL, realtime and configured storage. The MongoDB wire endpoint has a separate listener. |
| Control | `canopy` with `CANOPY_ROLE=control`                               | `/admin/v1` and its routes except app user administration.                                         |
| Auth    | `canopy` with `CANOPY_ROLE=control` and `CANOPY_AUTH_ENGINE=rust` | `/auth/v1` and its routes, `/.well-known/jwks.json`, `/admin/v1/users` and its routes.             |
| Studio  | `canopy` with `CANOPY_ROLE=studio`                                | `/studio` and its assets.                                                                          |

Control migrates the meta database and runs configured webhooks. Auth is a second process of the control
role that serves built in auth from its own config, so it keeps answering when control stops; the edge sends
it only the auth routes. Set the same `CANOPY_MASTER_KEY` and `CANOPY_META_DB` for data, control and auth.
The deployment sets `CANOPY_REALTIME_INTERNAL_URL` on control to the private data service URL. The edge
refuses `/internal` and all paths beneath it. The data service continues to serve requests when control stops.

## Docker Compose

Set `CANOPY_MASTER_KEY`, `CANOPY_PUBLISHABLE_KEYS` and `CANOPY_SECRET_KEYS`. The base file assumes an
external identity provider. Add `split-auth.yaml` for built in auth. Set `CANOPY_PUBLIC_URL` to the public
HTTPS URL in production. `CANOPY_AUTH_CONFIG` selects the auth service's config, a canopyd JSON file whose
`auth` section has `kind: "builtin"` (default `split-auth.json`, for local development: it logs mail
instead of sending it, which Rust auth refuses in production, and does not require email verification).
`CANOPY_GATEWAY_CONFIG` selects the Rust config for data and control in the base stack. The built in auth
overlay supplies their JWT settings. To combine built in auth with a custom Rust config, copy the overlay
and add your settings to its JSON.

`split-auth-typescript.yaml`, added after `split-auth.yaml`, runs the TypeScript auth service of the
`canopy-control` image instead, with `CANOPY_AUTH_CONFIG` naming a TypeScript config (default
`split-control.ts`). It stays available while Rust auth awaits its
external security review, and for settings Rust auth does not support yet: a claims hook written as a
function (Rust auth calls an HTTPS hook), password authentication turned off, and metrics of the auth
service.

Control publishes the bundled example notes policy at startup. Point `CANOPY_POLICY_BUNDLE_FILE` at your
canonical version 1 JSON bundle to replace it. To manage policies through Studio or the CLI only, use a Compose
override that sets `services.control.environment.CANOPY_POLICY_BUNDLE` to YAML `null` and leave that
variable unset on the host.

## Helm and Kubernetes

Set the shared replica set URI and keys in the Kubernetes Secret. In Helm, set `split.publicUrl` to the public
HTTPS URL to enable built in auth. Put built in auth settings in `split.auth.settings`, or a complete auth
config with credentials in the Secret named by `split.auth.configSecret` (key `auth.json`). In production
the chart refuses built in auth without a mail transport in either. Set
`split.control.policyBundle` or `split.control.policyBundleConfigMap` to publish a canonical bundle at
startup. The ConfigMap must contain `policy-bundle.json`. When upgrading, translate a custom
`canopy.config.ts` of `split.auth.configMap` into `split.auth.settings` or `split.auth.configSecret` (the
`split.auth.image` and `split.auth.configMap` values are gone), and replace any TypeScript startup policy
files with a canonical bundle. With the standalone Kubernetes manifest, replace
the example bundle in `canopy-split-policies` and restart control after updating it.
