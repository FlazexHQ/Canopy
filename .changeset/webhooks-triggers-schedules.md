---
"@canopy/server": minor
"@canopy/config": minor
"@canopy/protocol": minor
---

Database triggers and scheduled jobs: the `webhooks` config section calls your endpoints when documents change or on a cron schedule, signed with the Standard Webhooks headers, delivered at least once with retries and dead letters in the meta database. `verifyWebhook` checks a delivery in any runtime, and `/admin/v1/webhooks` lists hooks, runs schedules and manages dead letters.
