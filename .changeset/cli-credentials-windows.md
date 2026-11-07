---
"@canopy/cli": patch
---

`canopy login` encrypts admin tokens for the Windows account with DPAPI, retries replacing the credentials file while another process holds it, and refuses to overwrite a credentials file it cannot read or parse instead of treating it as empty.
