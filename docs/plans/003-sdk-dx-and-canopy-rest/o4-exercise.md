# O4 quickstart exercise

## Result

The maintainer confirmed on 2026-11-20 that the five developer exercise is complete. This closes O4
and C14. The repository worksheet has no participant entries, and no completed notes were found in
the checkout, its tracked history or the branch PR conversation. The checkout used, each participant's
elapsed time, schema setup method and first blocker are unavailable. Facilitator help and individual
write and realtime observations are also unavailable.

## Separate REST exercise

**Pending participant evidence.** Each participant needs to fetch a page with their own user token,
follow its cursor and compare the result with another user's page. The
[composed server test](../../../packages/client/test/rest.e2e.test.ts) independently does this with two
user tokens. See the [SDK verification results](verification.md) for the automated runs.

## Original worksheet

Recruit five developers who have never set up Canopy. Give each participant a fresh checkout and the repository README. Start the clock when they start Docker Compose. Ask them to build a todo application with authenticated reads and writes, and demonstrate that a change made in one browser session appears in another session signed in as the same user.

Record elapsed time, the first blocker, whether the participant used `canopy pull` or wrote the schema by hand, and whether both authenticated writes and realtime delivery worked. Record any facilitator help and the exact checkout used. The gate passes when all five participants demonstrate the workflow within 15 minutes. If someone gets stuck, fix the first blocking step and rerun the exercise.

After the timed exercise, ask each participant to use `@canopy/client/rest` to fetch a page of their todos with the signed-in user's token. Have them follow a cursor to the next page and compare the result with another user's page. Record completion time and the first blocker separately from O4.

| Participant | Minutes | Schema setup | Authenticated write | Realtime delivery | First blocker or help |
| --- | --- | --- | --- | --- | --- |
| A | | | | | |
| B | | | | | |
| C | | | | | |
| D | | | | | |
| E | | | | | |
