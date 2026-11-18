# S4: Build the matcher or adopt a library?

- **Date:** recorded 2026-11-13, after the implementation settled the question
- **Status:** answered by the implementation. Custom matcher, verified by differential tests. The comparison
  with Mingo or sift was not run and is not needed.
- **Roadmap:** [12 §4](../plan/12-roadmap.md#4-technical-spikes),
  [ADR 0005](../adr/0005-custom-matcher-with-differential-testing.md)

## Question

Should the matcher be custom built or adopted (Mingo, sift)? Success criterion: the custom matcher wins on
fidelity and speed, or an adopted library passes the differential tests within budget.

## Answer

`@canopy/matcher` is custom: it compiles filters, sorts and projections into closures and implements BSON
comparison order, type bracketing, array traversal, `null` and missing semantics, numeric kinds and the
update operators (`packages/matcher/src`). It covers only the matcher safe operator set; everything else is
refused in process (`UnsupportedQueryError`) and goes to the polling observer on the server, or gets no local
prediction on the client.

## Evidence

- Fidelity: `packages/matcher/test/differential.test.ts` generates documents and queries (shared generators in
  `@canopy/testing`) and requires the matcher and a real MongoDB `find` to agree on filters, sort order,
  projections and updates. The seed is fixed (`CANOPY_DIFF_SEED`) and `nightly.yml` runs `CANOPY_DIFF_RUNS=3500`.
  Operator, regex and comparison suites sit beside it (`operators.test.ts`, `regex.test.ts`, `compare.test.ts`).
- Speed: `packages/matcher/bench/throughput.ts` evaluates representative filters over a million documents;
  anchored and plain text regular expressions got their own fast paths (commit `6a8f6f0`).
- Size: the client imports `@canopy/matcher/lite`, a subset, so the SDK does not carry the whole matcher.

## Why no library comparison

The custom matcher exists and passes the differential suite, which is the property the decision needed. A
library would have to pass the same suite and then be kept in step with MongoDB's semantics by someone else,
for the most security sensitive code in the project. Replacing a working, tested component to compare speed
would not change the decision. ADR 0005 is still marked Proposed; the maintainer can accept it on this
evidence.
