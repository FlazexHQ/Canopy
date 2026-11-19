# O4 quickstart exercise

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
