---
"@canopy/cli": minor
"@canopy/protocol": minor
---

`canopy doctor` prints MongoDB failures in the diagnostic format with their fix (an unreachable host,
rejected credentials, a TLS mismatch, a standalone server, a missing privilege) and checks that the
feature compatibility version is 7.0 or newer. `mongoTarget` names the hosts and database of a connection
string for diagnostics, never its credentials.
