---
"@canopy/policy": patch
---

Field rules whose paths contain each other (one role allows `profile` and another `profile.name`, or one rule lists both `a` and `a.b`) no longer make every read fail with a path collision. The outer path is kept, which grants and hides exactly what the rules did before.
