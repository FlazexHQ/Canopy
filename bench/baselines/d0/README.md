# D0 baseline: the TypeScript data paths

Stage D0 of [plan 004](../../../docs/plans/004-rust-data-plane.md#5-stages) records what the TypeScript REST read
path, write path and realtime fan out cost per request before any route moves to Rust. The numbers below are
the first local run. They are **not** the gate numbers: the gate runs on the reference hardware (the Linux
benchmark runner) against a local replica set and a same region Atlas cluster, and Atlas is still pending
(see [Atlas](#atlas)). What carries over from this run is the shape: commands per request, bytes per request,
plans, documents examined and the ratios to the plain driver.

Raw reports: [`local-node26.json`](local-node26.json) and [`local-bun.json`](local-bun.json), written by
[`workloads/d0/run.ts`](../../workloads/d0/run.ts).

## Setup

|             |                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine     | AMD Ryzen 5 5600H (6 cores, 12 threads), 15 GiB, Windows 11 (10.0.26300), a laptop                                                                                                     |
| MongoDB     | 8.0.34, single member replica set `rs0` on localhost, started with `packages/testing/scripts/mongod.ts`                                                                                |
| Round trip  | median `ping` 0.3 ms (Node), 0.8 ms (Bun)                                                                                                                                              |
| Runtimes    | Node v26.12.1, Bun 1.4.5                                                                                                                                                               |
| Data        | 100,000 documents in `orders`, 1,000 owners (100 documents each), 100 tenants, indexes `{ ownerId: 1, createdAt: -1, _id: 1 }` and `{ tenantId: 1, status: 1, createdAt: -1, _id: 1 }` |
| Load        | closed loop, 32 concurrent requests, 1 s warm up, 8 s timed window per scenario                                                                                                        |
| Policies    | the policies of `workloads/rest/scenarios.ts` (owner, clerk of a tenant, auditor); token verification is stubbed so the numbers price routing, policy and MongoDB                      |
| Calibration | `serverStatus` costs 209 B in and about 112 KB out per call; the idle window saw 0 requests per second in both runs, so no background correction was needed                            |

## How each number is measured

| Number                             | Source                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests per second, p50, p95, p99 | closed loop over the timed window (`workloads/rest/harness.ts`)                                                                               |
| Commands per request, by name      | driver command monitoring (`commandStarted`), housekeeping (`hello`, `endSessions`, authentication) excluded                                  |
| Bytes in and out per request       | `serverStatus` `network` deltas around the window, minus the cost of the two harness calls and the idle background rate                       |
| Pool wait                          | CMAP `connectionCheckedOut` duration, summed per request                                                                                      |
| CPU per request                    | `process.cpuUsage` of the client process over the window (the TypeScript service and the driver)                                              |
| Allocated per request              | `v8.getHeapStatistics().total_allocated_bytes` delta (Node only: on Bun the figure drops after each collection, so the report records `null`) |
| Garbage collection                 | `PerformanceObserver` `gc` entries (Node only: Bun reports none)                                                                              |
| Plan and documents examined        | `explain` with `executionStats` of the exact read command the platform sent, captured from command monitoring                                 |

## Canopy against the plain driver

Throughput is Canopy divided by the plain driver doing the same work; CPU is Canopy's client CPU per request
divided by the driver's. Higher throughput and lower CPU are better.

| Scenario                      | Node throughput | Node CPU | Bun throughput | Bun CPU | Commands, Canopy against driver |
| ----------------------------- | --------------: | -------: | -------------: | ------: | ------------------------------- |
| page of 20, owner policy      |            0.60 |     1.62 |           0.71 |    1.35 | 1 against 1                     |
| page of 100, owner policy     |            0.60 |     1.62 |           0.67 |    1.39 | 1 against 1                     |
| second page by cursor         |            0.52 |     1.80 |           0.64 |    1.52 | 1 against 1                     |
| find by id                    |            0.62 |     1.63 |           0.63 |    1.57 | 1 against 1                     |
| count                         |            0.71 |     1.43 |           0.38 |    1.97 | 1 against 1                     |
| distinct                      |            0.91 |     1.31 |           0.80 |    1.29 | 1 against 1                     |
| aggregate                     |            0.76 |     1.38 |           0.68 |    1.53 | 1 against 1                     |
| insert                        |            0.60 |     4.58 |           0.56 |    3.29 | 2 against 1                     |
| patch, atomic fast path       |            0.64 |     4.86 |           0.66 |    2.94 | 2 against 1                     |
| patch, transaction with check |            0.48 |     6.21 |           0.40 |    4.47 | 3 against 1                     |
| patch with mutation ID        |            0.46 |     6.82 |           0.36 |    5.60 | 3 against 1                     |
| insert with mutation ID       |            0.45 |     5.94 |           0.36 |    4.84 | 3 against 1                     |
| replace                       |            0.50 |     2.91 |           0.37 |    6.73 | 3 against 1                     |
| delete                        |            1.02 |     1.87 |           0.59 |    2.65 | 1 against 1                     |
| batch of 5, not atomic        |            0.33 |     5.99 |           0.13 |    7.47 | 11 against 2                    |
| atomic batch of 4             |            0.46 |     2.64 |           0.27 |    3.01 | 9 against 5                     |

Reads cost Canopy 1.3 to 1.8 times the driver's client CPU with the same single command, so read overhead is
CPU in the service (routing, policy, EJSON encoding), not round trips. Writes cost 3 to 7 times the CPU and up
to 5.5 times the commands, so the write path loses on round trips as well as CPU.

## Reads

| Scenario                        | Node req/s | Bun req/s | Node p50 / p95 / p99 ms | Bun p50 / p95 / p99 ms | Commands per request  | Bytes in / out per request (Node) | CPU ms per request Node / Bun | Pool wait ms per request (Node) | Allocated KiB per request (Node) |
| ------------------------------- | ---------: | --------: | ----------------------- | ---------------------- | --------------------- | --------------------------------: | ----------------------------: | ------------------------------: | -------------------------------: |
| driver: page of 20              |       2542 |      1963 | 11.8 / 18.3 / 22.6      | 14.4 / 25.5 / 42.3     | 1.00 (find 1.00)      |                        279 / 5931 |                 0.485 / 0.648 |                           0.009 |                            273.1 |
| rest: page of 20, owner policy  |       1514 |      1402 | 19.9 / 30.0 / 51.5      | 22.0 / 29.7 / 34.6     | 1.00 (find 1.00)      |                        332 / 5955 |                 0.786 / 0.873 |                           0.005 |                            413.8 |
| driver: page of 100             |        947 |       629 | 32.1 / 45.5 / 56.5      | 49.7 / 61.5 / 72.3     | 1.00 (find 1.00)      |                       279 / 27384 |                 1.501 / 2.050 |                           0.004 |                           1087.9 |
| rest: page of 100, owner policy |        571 |       424 | 51.6 / 77.1 / 109.4     | 71.2 / 103.5 / 154.5   | 1.00 (find 1.00)      |                       332 / 27405 |                 2.436 / 2.859 |                           0.007 |                           1593.2 |
| driver: second page by range    |       2802 |      2011 | 10.6 / 15.6 / 19.3      | 14.3 / 23.8 / 30.3     | 1.00 (find 1.00)      |                        372 / 5931 |                 0.434 / 0.574 |                           0.003 |                            270.0 |
| rest: second page by cursor     |       1455 |      1293 | 20.5 / 32.0 / 49.1      | 23.9 / 36.0 / 43.9     | 1.00 (find 1.00)      |                        932 / 5954 |                 0.781 / 0.872 |                           0.004 |                            434.9 |
| driver: find by id              |       6005 |      5066 | 5.0 / 7.6 / 8.9         | 5.7 / 9.5 / 14.2       | 1.00 (find 1.00)      |                         267 / 507 |                 0.191 / 0.219 |                           0.003 |                             62.0 |
| rest: find by id                |       3721 |      3209 | 8.1 / 11.1 / 13.0       | 8.7 / 15.5 / 27.1      | 1.00 (find 1.00)      |                         357 / 530 |                 0.311 / 0.344 |                           0.003 |                             96.3 |
| driver: count                   |       3811 |      3568 | 8.0 / 12.1 / 15.9       | 8.4 / 13.7 / 18.7      | 1.00 (aggregate 1.00) |                         322 / 260 |                 0.282 / 0.293 |                           0.006 |                             55.1 |
| rest: count                     |       2714 |      1365 | 10.9 / 18.6 / 27.1      | 19.2 / 51.8 / 92.5     | 1.00 (aggregate 1.00) |                         375 / 283 |                 0.402 / 0.578 |                           0.004 |                             89.4 |
| driver: distinct                |       3418 |      4348 | 8.1 / 18.0 / 28.7       | 7.0 / 11.2 / 15.3      | 1.00 (distinct 1.00)  |                         252 / 189 |                 0.256 / 0.234 |                           0.007 |                             43.8 |
| rest: distinct                  |       3125 |      3492 | 9.9 / 15.1 / 20.4       | 8.5 / 12.9 / 16.7      | 1.00 (distinct 1.00)  |                         305 / 212 |                 0.335 / 0.302 |                           0.005 |                             78.0 |
| driver: aggregate               |       3124 |      2830 | 9.5 / 15.1 / 19.7       | 10.2 / 17.5 / 24.4     | 1.00 (aggregate 1.00) |                         366 / 281 |                 0.318 / 0.348 |                           0.007 |                             55.1 |
| rest: aggregate                 |       2360 |      1928 | 12.9 / 18.8 / 25.0      | 15.0 / 26.0 / 41.0     | 1.00 (aggregate 1.00) |                         454 / 304 |                 0.438 / 0.530 |                           0.006 |                             94.6 |

## Writes

| Scenario                                   | Node req/s | Bun req/s | Node p50 / p95 / p99 ms | Bun p50 / p95 / p99 ms | Commands per request                                                                                      | Bytes in / out per request (Node) | CPU ms per request Node / Bun | Pool wait ms per request (Node) | Allocated KiB per request (Node) |
| ------------------------------------------ | ---------: | --------: | ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------: | ----------------------------: | ------------------------------: | -------------------------------: |
| driver: insertOne (majority)               |       2006 |      1791 | 15.7 / 18.0 / 24.5      | 15.9 / 28.4 / 66.3     | 1.00 (insert 1.00)                                                                                        |                         557 / 230 |                 0.188 / 0.305 |                           0.004 |                             48.0 |
| rest: insert                               |       1210 |       998 | 24.2 / 44.1 / 54.3      | 31.1 / 47.5 / 69.7     | 2.00 (aggregate 1.00, insert 1.00)                                                                        |                        1339 / 776 |                 0.860 / 1.004 |                           0.013 |                            170.4 |
| driver: updateOne (majority)               |       2029 |      2004 | 15.7 / 17.3 / 19.0      | 15.6 / 18.7 / 28.2     | 1.00 (update 1.00)                                                                                        |                         351 / 245 |                 0.150 / 0.261 |                           0.004 |                             49.4 |
| rest: patch, atomic fast path              |       1299 |      1314 | 20.8 / 46.4 / 77.4      | 23.2 / 38.6 / 51.6     | 2.00 (update 1.00, find 1.00)                                                                             |                         713 / 752 |                 0.729 / 0.766 |                           0.013 |                            175.7 |
| rest: patch, transaction with check        |        968 |       809 | 31.7 / 44.9 / 55.6      | 36.0 / 60.0 / 80.3     | 3.00 (update 1.00, aggregate 0.75, find 0.25, commitTransaction 1.00, abortTransaction 0.00)              |                        1390 / 937 |                 0.932 / 1.165 |                           0.013 |                            241.0 |
| rest: patch with mutation ID               |        928 |       725 | 32.1 / 48.6 / 62.0      | 43.4 / 62.4 / 94.9     | 3.00 (bulkWrite 1.00, find 1.00, commitTransaction 1.00)                                                  |                       1497 / 1137 |                 1.024 / 1.460 |                           0.014 |                            252.9 |
| rest: insert with mutation ID              |        907 |       653 | 31.6 / 62.1 / 108.0     | 47.0 / 78.6 / 96.4     | 3.00 (bulkWrite 1.00, aggregate 1.00, commitTransaction 1.00)                                             |                       1861 / 1153 |                 1.115 / 1.478 |                           0.014 |                            250.5 |
| driver: replaceOne (majority)              |       2024 |      2030 | 15.6 / 17.4 / 22.6      | 15.6 / 19.2 / 23.4     | 1.00 (update 1.00)                                                                                        |                         596 / 245 |                 0.257 / 0.210 |                           0.003 |                             50.0 |
| rest: replace                              |       1021 |       741 | 31.3 / 33.9 / 39.5      | 44.2 / 58.2 / 65.5     | 3.00 (update 1.00, aggregate 1.00, commitTransaction 1.00)                                                |                        1520 / 944 |                 0.747 / 1.415 |                           0.007 |                            229.9 |
| driver: deleteOne (majority)               |       2001 |       988 | 15.6 / 17.4 / 32.7      | 15.8 / 29.1 / 297.1    | 1.00 (delete 1.00)                                                                                        |                         336 / 230 |                 0.149 / 0.371 |                           0.005 |                             48.0 |
| rest: delete                               |       2038 |       581 | 15.6 / 17.7 / 22.8      | 47.3 / 123.2 / 146.9   | 1.00 (findAndModify 1.00)                                                                                 |                         370 / 472 |                 0.279 / 0.983 |                           0.003 |                            101.9 |
| driver: bulkWrite of 5 (ordered, majority) |        999 |       800 | 31.2 / 35.6 / 57.4      | 35.6 / 63.4 / 101.2    | 2.00 (insert 1.00, update 1.00)                                                                           |                        1345 / 475 |                 0.437 / 0.983 |                           0.009 |                            113.4 |
| rest: batch of 5 (not atomic)              |        329 |       104 | 93.9 / 124.7 / 163.3    | 265.0 / 607.2 / 943.2  | 11.00 (aggregate 2.00, insert 1.00, update 4.00, find 3.00, commitTransaction 1.00)                       |                       5007 / 3978 |                 2.618 / 7.344 |                           0.046 |                            843.5 |
| driver: transaction of 4 writes            |       1020 |       393 | 31.4 / 32.7 / 33.4      | 74.3 / 148.6 / 189.4   | 5.01 (insert 1.00, update 3.00, commitTransaction 1.00, abortTransaction 0.00)                            |                       1825 / 1131 |                 0.844 / 2.119 |                           0.011 |                            225.5 |
| rest: atomic batch of 4                    |        473 |       107 | 64.2 / 83.0 / 102.6     | 257.0 / 527.0 / 626.8  | 9.01 (aggregate 1.00, insert 1.00, update 3.00, find 3.00, commitTransaction 1.00, abortTransaction 0.00) |                       3849 / 3200 |                 2.230 / 6.383 |                           0.028 |                            652.3 |

## Plans

Every read uses an index; no read scans the collection, sorts in memory or needs a `getMore` for its page.

| Scenario                        | Command   | Winning plan           | Keys examined | Docs examined | Returned |
| ------------------------------- | --------- | ---------------------- | ------------: | ------------: | -------: |
| driver: page of 20              | find      | LIMIT > FETCH > IXSCAN |            21 |            21 |       21 |
| rest: page of 20, owner policy  | find      | LIMIT > FETCH > IXSCAN |            21 |            21 |       21 |
| driver: page of 100             | find      | LIMIT > FETCH > IXSCAN |           100 |           100 |      100 |
| rest: page of 100, owner policy | find      | LIMIT > FETCH > IXSCAN |           100 |           100 |      100 |
| driver: second page by range    | find      | LIMIT > FETCH > IXSCAN |            41 |            41 |       21 |
| rest: second page by cursor     | find      | LIMIT > FETCH > IXSCAN |            41 |            41 |       21 |
| driver: find by id              | find      | LIMIT > FETCH > IXSCAN |             1 |             1 |        1 |
| rest: find by id                | find      | LIMIT > FETCH > IXSCAN |             1 |             1 |        1 |
| driver: count                   | aggregate | GROUP > COUNT_SCAN     |           100 |             0 |        1 |
| rest: count                     | aggregate | GROUP > COUNT_SCAN     |           100 |             0 |        1 |
| driver: distinct                | distinct  | FETCH > IXSCAN         |           100 |           100 |      100 |
| rest: distinct                  | distinct  | FETCH > IXSCAN         |           100 |           100 |      100 |
| driver: aggregate               | aggregate | GROUP > FETCH > IXSCAN |           100 |           100 |        1 |
| rest: aggregate                 | aggregate | GROUP > FETCH > IXSCAN |           100 |           100 |        1 |

## Fan out

From `workloads/realtime/fanout.ts`, engine `ts`, 100,000 documents, 8 s per scenario.

| Scenario                                  | Runtime | Delivery p50 / p99 ms | Plain change stream p50 / p99 ms | Write ack p50 / p99 ms | Engine ms per event | CPU |    RSS |
| ----------------------------------------- | ------- | --------------------- | -------------------------------- | ---------------------- | ------------------: | --: | -----: |
| per user, 1k connections, 500 writes/s    | Node    | 18.2 / 21.4           | 16.7 / 18.9                      | 16.7 / 19.6            |                0.03 |  8% | 209 MB |
| per user, 1k connections, 500 writes/s    | Bun     | 16.3 / 483.9          | 12.6 / 484.6                     | 12.9 / 509.8           |                0.10 | 24% | 198 MB |
| shared query, 1k connections, 20 writes/s | Node    | 21.8 / 30.6           | 17.3 / 20.7                      | 16.8 / 19.9            |                2.33 | 10% | 335 MB |
| shared query, 1k connections, 20 writes/s | Bun     | 18.2 / 33.1           | 12.5 / 24.2                      | 12.1 / 22.2            |                3.42 | 10% | 378 MB |

Every write was delivered to every subscriber that may see it and every subscriber converged, on both
runtimes. Delivery adds 1.5 to 5 ms at p50 over a plain change stream read of the same writes.

## Findings

Plan 004 holds the routes until query plan and round trip findings are fixed in both languages. Each finding
below gives its evidence and where the fix belongs.

1. **The keyset cursor filter does not always become index bounds.** The second page by cursor examines 41
   keys and 41 documents to return 21, against 22 for a filter with tight bounds. The plain driver form of the
   same range (`$or` of `createdAt < X` and `createdAt = X AND _id > id`) does the same, so this is the
   planner, not only Canopy's filter. A probe on 2,000 documents explained pages 2, 6 and 10: the `$or` forms
   use a single index scan with the bounds of the owner prefix at page 2 (41 keys) and switch to a
   `SORT_MERGE` of tight scans at deeper pages (21 to 23 keys); adding `createdAt: { $lte: X }` gives one
   tight scan at every depth (21 or 22 keys). Because the plan cache keys on the query shape, a cached loose
   plan can apply to every depth. Canopy cannot add a plain `$lte` bound, because its cursor filter keeps the
   documents whose `createdAt` is null, missing or of a type that sorts below dates, and `$lte` with a date
   only matches dates. The fix (a bound per type bracket, or an index hint) belongs to the cursor filter of
   `packages/rest/src/cursor.ts` and must be byte identical in the Rust read path of D1.
2. **The cursor filter is two and a half times the size of the driver's.** The second page sends 932 bytes
   against 372 for the driver form, from the type bracket clauses. It costs bytes and parse time on every
   page; the fix of finding 1 should keep it in view.
3. **The fast path patch takes two round trips.** `update` and then `find` to read the document back, where
   one `findAndModify` with the new document returns it in one round trip and removes the documented race
   (the read back can see a later write). The delete already uses `findAndModify`.
4. **Insert takes two round trips.** An `aggregate` over `$documents` evaluates the `check` and then the
   `insert` runs. With a mutation ID it is three (`bulkWrite`, `aggregate`, `commitTransaction`).
5. **Replace under the owner policy always runs a transaction.** Three commands (`update`, `aggregate` for the
   check, `commitTransaction`) where a patch on the same policy takes the fast path. Worth checking whether
   a replacement whose check holds by construction (it sets the owner field to the caller) can take the fast
   path.
6. **A non atomic batch runs its operations one by one.** Five operations cost 11 commands (each update reads
   its document back, the insert and the replace evaluate their checks, the replace commits a transaction)
   against 2 for an ordered `bulkWrite`. Throughput is 0.33 of the driver on Node and 0.13 on Bun.
7. **An atomic batch reads every updated document back.** Four operations cost 9 commands against 5 for the
   same driver transaction: one `aggregate` for the insert check and one `find` per update.
8. **Writes on Bun cost more than on Node.** Transactions and batches run at 0.2 to 0.8 of their Node
   throughput with up to 3 times the client CPU, and the plain driver transaction is slower too (393 against
   1,020 per second), so most of it is the driver on Bun. Per user fan out on Bun had a p99 near 500 ms in the
   plain change stream and in the write acknowledgments as well, not in Canopy's delivery.
9. **Majority writes on this machine wait for the Windows timer.** Every majority write, Canopy or driver, has
   a p50 near 15.6 ms, the default Windows timer period; an earlier run on the same machine measured 5 ms.
   Write latencies from this run are a floor set by the host, which is why the gate uses the Linux runner.

The reads need no round trip fix: one command each, the same as the driver, all on an index. What they need
from D1 is less CPU per request, which is the 1.5 times throughput per vCPU the D1 gate asks for.

## Status of the findings

The measurements above are the baseline and stay as recorded. What has changed since, measured with the same
harness on the same machine where noted:

| Finding                   | Status                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2 (keyset cursor)      | Fixed: a redundant bound on the first sort key keeps every page on a tight index scan, cold or warm plan cache (page 2: 23 keys for 21 returned instead of 41; after warming on page 2, page 11: 23 instead of 221); the filter is 26% smaller. A `NaN` gap in pagination was found and fixed on the way. Still loose when many documents share the first sort key. |
| 3 (fast path patch)       | Kept at 2 commands: `findAndModify` cannot report whether the document changed, and `modified` stays exact. To revisit in the Rust write path.                                                                                                                                                                                                                      |
| 4 (insert)                | Kept at 2 commands: no single command checks and inserts with the same errors and results.                                                                                                                                                                                                                                                                          |
| 5 (replace)               | Fixed: 2 commands, no transaction (the check runs on the replacement before the write).                                                                                                                                                                                                                                                                             |
| 6 (non atomic batch)      | Fixed on MongoDB 8.0: the D0 batch takes 4.08 commands instead of 11, 504 requests per second instead of 329. MongoDB 7.0 runs it one operation at a time, as before.                                                                                                                                                                                               |
| 7 (atomic batch)          | Partly fixed: read backs of string and ObjectId ids are one `find` per collection (9 to 7 commands); numeric ids, which the D0 workload uses, still read one by one.                                                                                                                                                                                                |
| 8, 9 (Bun, Windows timer) | Environment findings; the gates run on the Linux reference runner.                                                                                                                                                                                                                                                                                                  |

The checks that run before a write (single insert, replace, grouped batches) now run on the target collection,
so MongoDB applies its default collation; before, a `$documents` check on the database could pass a document
that fails its check once stored in a collection with a collation.

## Atlas

Not run yet: no Atlas cluster was available. With a same region cluster, from a machine in its region:

```sh
CANOPY_BENCH_MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/?retryWrites=true" \
CANOPY_BENCH_TIER=M30 CANOPY_BENCH_REGION=<region> CANOPY_BENCH_OUT=baselines/d0/atlas-node26.json \
bun --filter @canopy/bench d0
```

The report records the tier, the region, whether the URI is `mongodb+srv` and the median round trip, and
never the credentials. Run it under Node 26 and under Bun.

## Running it again

```sh
bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir <empty folder> --port 37017
CANOPY_BENCH_MONGODB_URI="mongodb://localhost:37017/?replicaSet=rs0" CANOPY_BENCH_OUT=baselines/d0/local-node26.json \
bun --filter @canopy/bench d0
```

The run refuses to measure when the idle window shows another client using the server (more than 5 requests
per second), because the per request numbers would be wrong; `CANOPY_BENCH_ALLOW_BACKGROUND=1` overrides it.
