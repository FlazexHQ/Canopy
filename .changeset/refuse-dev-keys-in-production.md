---
"@canopy/config": patch
---

With `CANOPY_ENV=production`, the server refuses to start when its publishable or secret keys include well known development keys: `pk_dev` and `sk_dev_change_me` from the compose file, `canopy_pk_dev`, and the keys `canopy dev` generates. A deployment that kept the compose defaults would otherwise give anyone the `service` role.
