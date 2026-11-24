---
"@canopy/server": minor
---

Provision SCRAM-SHA-256 for newly issued secret API keys. Use the returned key ID as the MongoDB username, the full secret key as the password, and `authSource=admin`. To rotate an existing secret key, create a replacement through `POST /admin/v1/api-keys`, switch clients, then revoke the old key through `DELETE /admin/v1/api-keys/:id`.
