---
"@canopy/studio": minor
---

Studio is restyled: a tinted frame holds the sidebar and the top bar, and each page sits on a white sheet. The
sidebar groups the areas under Build and Operate, the top bar has a jump palette (Ctrl or Cmd + K) for pages and
collections, and production draws a red edge on the sheet. Dialogs, menus, selects, tabs, switches, checkboxes
and labels are built on ui-sdk behaviors instead of Radix, and its styles are adopted as constructed style
sheets, so the strict CSP is unchanged.
