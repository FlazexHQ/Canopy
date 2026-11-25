# Split deployment

Use `deploy/compose/split.yaml`, set `split.enabled=true` in the Helm chart, or apply
`deploy/kubernetes/split.yaml` with an external MongoDB replica set. Route public HTTP traffic to the edge.

| Service | Image                                             | Routes                                                                                             |
| ------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Data    | `canopy`                                          | REST, GraphQL, realtime and configured storage. The MongoDB wire endpoint has a separate listener. |
| Control | `canopy` with `CANOPY_ROLE=control`               | `/admin/v1` and its routes except app user administration.                                         |
| Auth    | `canopy-control` with `CANOPY_SPLIT_AUTH_ONLY=on` | `/auth/v1` and its routes, `/.well-known/jwks.json`, `/admin/v1/users` and its routes.             |
| Studio  | `canopy` with `CANOPY_ROLE=studio`                | `/studio` and its assets.                                                                          |

Control migrates the meta database and runs configured webhooks. Set the same `CANOPY_MASTER_KEY` and
`CANOPY_META_DB` for data, control and auth. The deployment sets `CANOPY_REALTIME_INTERNAL_URL` on control to
the private data service URL. The edge refuses `/internal` and all paths beneath it. The data service
continues to serve requests when control stops.

## Docker Compose

Set `CANOPY_MASTER_KEY`, `CANOPY_PUBLISHABLE_KEYS` and `CANOPY_SECRET_KEYS`. The base file assumes an
external identity provider. Add `split-auth.yaml` for built in auth. Set `CANOPY_PUBLIC_URL` to the public
HTTPS URL in production. `CANOPY_AUTH_CONFIG` selects the TypeScript auth config. Its previous name,
`CANOPY_CONTROL_CONFIG`, also works. `CANOPY_GATEWAY_CONFIG` selects the Rust config for the base stack.
The built in auth overlay supplies its own Rust config. To combine built in auth with a custom Rust config,
copy the overlay and add your settings to its JSON.

Control publishes the bundled example notes policy at startup. Point `CANOPY_POLICY_BUNDLE_FILE` at your
canonical version 1 JSON bundle to replace it. To manage policies through Studio or the CLI only, use a Compose
override that sets `services.control.environment.CANOPY_POLICY_BUNDLE` to YAML `null` and leave that
variable unset on the host.

## Helm and Kubernetes

Set the shared replica set URI and keys in the Kubernetes Secret. In Helm, set `split.publicUrl` to the public
HTTPS URL to enable built in auth. Set `split.auth.configMap` for a custom `canopy.config.ts`. Set
`split.control.policyBundle` or `split.control.policyBundleConfigMap` to publish a canonical bundle at
startup. The ConfigMap must contain `policy-bundle.json`. When upgrading, move TypeScript image overrides to
`split.auth.image` and replace any TypeScript startup policy files with a canonical bundle. With the standalone Kubernetes manifest, replace
the example bundle in `canopy-split-policies` and restart control after updating it.
