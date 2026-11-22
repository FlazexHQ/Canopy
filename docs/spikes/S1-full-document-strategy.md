# S1: Which full document strategy?

- **Date:** recorded 2026-11-13, after the implementation settled the question
- **Status:** answered by the implementation. The strategy is chosen and shipped; the numeric calibration
  (lag at 5k writes/s on a three node set) was not measured.
- **Roadmap:** [12 §4](../design/12-roadmap.md#4-technical-spikes)

## Question

How does the engine get the full document of an update event: `updateLookup`, pre and post images, or lazy
batched lookups? Success criterion: a default is chosen, and `auto` keeps lag at or below 1 s at 5k writes/s.

## Answer in the code

`FullDocumentMode` is `auto | updateLookup | images` (`packages/realtime/src/ingestor.ts`, option
`realtime.fullDocument`, default `auto`).

| Mode | Change stream options | When an update has no post image |
|---|---|---|
| `auto` (default) | `fullDocument: whenAvailable`, `fullDocumentBeforeChange: whenAvailable` | the engine reads the current documents itself, in one batched `find({ _id: { $in } })` per collection per batch (`MongoSnapshotReader.lookup`), and only for events that some observer could match or a `$ctx` lookup watches (`Realtime.processEvents`) |
| `updateLookup` | `fullDocument: updateLookup` | MongoDB looks it up for every update |
| `images` | `fullDocument: required`, `fullDocumentBeforeChange: required` | never; needs `changeStreamPreAndPostImages` on every exposed collection |

Images are opt in because enabling them changes collection options in the user's database; the CLI does it
on request (`canopy realtime enable-images`, `packages/cli/src/realtime-images.ts`). Without them `auto`
works on any replica set. The lazy lookup reads the document as it is now, which can be newer than the event;
that is safe because events are applied by cluster time and a newer document only advances the view.

## Evidence

- Ingestor start, progress and restart behavior: `packages/realtime/test/ingestor.test.ts`.
- Convergence of views with updates arriving without post images, against a MongoDB oracle:
  `packages/realtime/test/realtime.test.ts` ("converges to the MongoDB result after random writes").
- Load tooling that measures the criterion: `packages/realtime/bench/fanout.ts`, `writer.ts` and
  `stream-probe.ts` (a plain change stream as the baseline).

## Not done

The three node, 1k/5k/20k writes/s measurement of the spike plan. Run `bench/fanout.ts` on the reference
hardware before 1.0 and record lag, CPU and oplog load here. Until then the default is a design choice, not a
measured one.
