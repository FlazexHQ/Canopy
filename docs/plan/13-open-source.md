# 13: Open source

## 1. License

**Recommendation: Apache-2.0 for every package and app** ([ADR-0012](../adr/0012-license-apache-2.md)).

- It is permissive, includes an explicit patent grant, and is easy for enterprises to approve. Supabase uses
  Apache-2.0 for most of its stack, so it is a familiar choice.
- **Alternative: AGPL-3.0 for the server** (and Apache-2.0 for SDKs). It discourages closed hosted forks, but it
  slows adoption in companies that ban AGPL. That cost matters most for the drop-in sidecar wedge.
- **About MongoDB's license.** Canopy talks to MongoDB over the wire protocol using the official Node driver,
  which is Apache-2.0. Operators remain responsible for licensing their own MongoDB deployment (SSPL for
  Community, commercial for Enterprise or Atlas). *This is not legal advice. Confirm with counsel in Phase 0.*

## 2. Governance

- **Through 1.0:** a small maintainer council (the founding team) decides by lazy consensus. Disagreements go
  to a vote of the council. `GOVERNANCE.md` describes roles (contributor, triager, maintainer, council) and
  how people move between them.
- **After 1.0:** the goal is a steering committee with members from at least 3 organizations. A foundation home
  (for example the OpenJS Foundation) can be evaluated once adoption warrants it.
- Each area has at least 2 owners in `CODEOWNERS`, and security-critical paths require 2 approvals
  ([09 §4.8](09-security.md#48-supply-chain)).

## 3. Contribution model

- **DCO sign-off** (`Signed-off-by`) instead of a CLA, to keep friction low. If a hosted offering under
  different terms is ever planned, revisit this before accepting large outside contributions (see Q6 in
  [12 §7](12-roadmap.md#7-open-questions)).
- Conventional Commits, Changesets for release notes, PR templates with a checklist (tests, docs, changeset,
  security impact).
- **Review targets:** first response within 3 business days, and a decision on small PRs within 10.
- **RFC process** (`docs/rfcs/NNNN-title.md`) is required for:
  - wire-protocol changes;
  - changes to the DLS policy language or semantics;
  - public API changes in `@canopy/client` and the bindings;
  - new deployment modes.

  RFCs are open for comment for 2 weeks. The decision and its rationale are recorded, and accepted RFCs update
  this plan and the ADRs.
- **ADRs** ([docs/adr](../adr/README.md)) record architecture decisions. RFCs propose changes; ADRs record
  the outcome.

## 4. Community

- GitHub Discussions (Q&A, ideas, show-and-tell) is the primary channel. A moderated Discord is optional.
- A monthly community call with recorded notes, and a public roadmap board.
- A curated `good first issue` list, a contributor guide, and recognition in release notes.
- **Code of Conduct:** Contributor Covenant 2.1, with named enforcement contacts.
- **Design partners:** before v0.1, recruit 5 to 10 teams (former Atlas App Services users, and teams running
  change streams with Socket.IO) for private alpha feedback.

## 5. Naming and trademarks

- **"Canopy" is a working name.** The unscoped `canopy` npm package already belongs to an unrelated project,
  so a scope is required regardless. Phase 0 checklist:
  - trademark searches (USPTO, EUIPO);
  - npm scope;
  - GitHub organization;
  - domain;
  - social handles;
  - a web search for conflicting developer tools.
- **Don't use "Mongo" or "MongoDB" in the product name.** These are MongoDB, Inc. trademarks. Use "for
  MongoDB" *descriptively* in taglines and docs, following MongoDB's trademark guidelines.
- **The same applies to "Supabase".** "Supabase for MongoDB" is fine as an informal comparison in talks and
  docs, but not as branding.

## 6. Security policy

`SECURITY.md` follows [09 §6](09-security.md#6-vulnerability-disclosure): private reporting through GitHub,
acknowledgement within 48 hours, coordinated disclosure within 90 days, and GitHub Security Advisories with
CVEs.

## 7. Release and support policy

| Line | Support |
|---|---|
| Pre-1.0 (0.x) | Latest minor only. Breaking changes are allowed in minor releases, with migration notes. |
| Current 1.x minor | Features, fixes, security fixes |
| Previous 1.x minor | Security fixes for 6 months after the next minor ships |
| Previous major | Security fixes for 12 months after the next major ships |
| Protocol v(N−1) | Supported by servers for ≥ 12 months after vN ([04 §3](04-wire-protocol.md#3-versioning-and-negotiation)) |

## 8. Sustainability

- GitHub Sponsors and/or Open Collective, with transparent spending.
- **Keep the open-source core complete.** Every feature stays self-hostable. If the project is monetized later,
  do it through managed hosting and support, the model Supabase uses, not by holding features back.
- Optional paid support and design partnerships for companies that adopt early.

## 9. Launch plan

1. **Private alpha** (during Phase 1) with the design partners.
2. **Public v0.1 launch:** blog post, a 3-minute demo video ("make an existing Express + MongoDB app live in 5
   minutes"), Show HN, the MongoDB community forums, r/node and r/mongodb.
3. **v0.4 (Studio) launch:** a "Supabase-style dashboard for MongoDB" demo, plus conference talk submissions.
4. **1.0:** the audit report summary, benchmarks, case studies from design partners, and the bug bounty
   announcement.
