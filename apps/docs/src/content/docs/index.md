---
title: Canopy
description: An open source, self hostable backend for MongoDB with live queries, Document Level Security, auth, REST and GraphQL.
template: splash
hero:
  tagline: Live queries, Document Level Security, auth and generated APIs for the MongoDB you already run.
  actions:
    - text: Get started
      link: /start/introduction/
      icon: right-arrow
    - text: Migrating from Atlas App Services
      link: /migrating/atlas-app-services/
      variant: minimal
---

Canopy is a backend platform for MongoDB that you host yourself. It reads one change stream, applies your
access rules to every document and every event, and serves the result over a realtime protocol, a REST Data
API and GraphQL. The client SDK keeps a local cache that updates optimistically and reconciles with the server
by cluster time.

Canopy never adds fields to your documents and never creates collections in your app database. Its own state
lives in the `canopy` and `canopy_auth` databases.

## Pick a starting point

| You have                                                  | Start with                                             |
| --------------------------------------------------------- | ------------------------------------------------------ |
| An app with its own API, and you want live data in the UI | [The realtime sidecar](/start/sidecar/)                |
| A Node or Bun server you want to extend                   | [Embedding Canopy](/start/embedded/)                   |
| A new project that needs a whole backend                  | [The Canopy platform](/start/platform/)                |
| An app on Atlas App Services, Parse or Firebase           | [The migration guides](/migrating/atlas-app-services/) |
