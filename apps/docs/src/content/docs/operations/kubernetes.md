---
title: Kubernetes and Docker Compose
description: Run Canopy in production on Kubernetes (Helm or plain manifests) or Docker Compose.
---

The repository ships three production setups. None of them runs MongoDB: give them the URI of a replica set
(Atlas, the MongoDB Kubernetes operator, or a set you run yourself). None of them has default keys either; they
refuse to start until you provide them.

| Setup                        | Path                              |
| ---------------------------- | --------------------------------- |
| Helm chart                   | `deploy/helm/canopy`              |
| Plain Kubernetes manifests   | `deploy/kubernetes/canopy.yaml`   |
| Docker Compose               | `deploy/compose/production.yaml`  |

Build the image from `deploy/docker/canopy.Dockerfile` and push it to your registry; no image is published yet.

## Secrets

Every setup reads the same variables from a secret:

| Variable                   | What it is                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `MONGODB_URI`              | the replica set                                                    |
| `CANOPY_MASTER_KEY`        | encrypts secrets at rest; `openssl rand -base64 32`                |
| `CANOPY_PUBLISHABLE_KEYS`  | keys for browsers; for example `canopy_pk_$(openssl rand -hex 24)` |
| `CANOPY_SECRET_KEYS`       | keys for your servers; `canopy_sk_$(openssl rand -hex 24)`         |
| `CANOPY_METRICS_TOKEN`     | the bearer token Prometheus sends to `/metrics`                    |

On Kubernetes:

```sh
kubectl create secret generic canopy \
  --from-literal=MONGODB_URI='mongodb://...' \
  --from-literal=CANOPY_MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=CANOPY_PUBLISHABLE_KEYS="canopy_pk_$(openssl rand -hex 24)" \
  --from-literal=CANOPY_SECRET_KEYS="canopy_sk_$(openssl rand -hex 24)" \
  --from-literal=CANOPY_METRICS_TOKEN="$(openssl rand -hex 24)"
kubectl create configmap canopy-policies --from-file=policies/
```

Then either `helm install canopy deploy/helm/canopy` or `kubectl apply -f deploy/kubernetes/canopy.yaml`. With
Helm, `existingSecret`, `policiesConfigMap` (empty to read policies from the meta database), `replicaCount`,
`drainWindowSeconds`, `resources` and extra `env` are the values you will most likely change.

## What the manifests set up

- Three pods with a rolling update that never takes one down before its replacement is ready.
- `startupProbe` and `livenessProbe` on `/healthz` (the process answers), `readinessProbe` on `/readyz`
  (MongoDB answers and the change stream is open), so a pod that loses MongoDB leaves the Service.
- A drain window of 30 s and a termination grace period of 45 s: on shutdown, clients are told to reconnect
  elsewhere before the pod is killed. A `preStop` pause of 5 s lets the endpoints update first (it needs
  Kubernetes 1.30 or later; remove it on older clusters).
- A disruption budget of one unavailable pod.
- `CANOPY_NODE_ID` set to the pod name, so session IDs and logs name the pod.
- A non root user, a read only root file system and no Linux capabilities.
- A headless `canopy-metrics` Service for Prometheus on port 9464, which requires the metrics token.

Several pods share one deployment safely; read [several instances](/operations/several-instances/) for what each
pod keeps to itself and how to route the HTTP fallback. WebSockets need an ingress that allows upgrades and a
read timeout above the 25 s heartbeat (60 s or more is safe).

## Docker Compose

```sh
docker compose -f deploy/compose/production.yaml --env-file canopy.env up -d --build --wait
```

`canopy.env` holds the five variables above; compose stops with the variable's name when one is missing. The
API listens on port 8080 (put a TLS proxy in front and list it in `CANOPY_TRUSTED_PROXIES`); metrics are
published on the host loopback address only.
