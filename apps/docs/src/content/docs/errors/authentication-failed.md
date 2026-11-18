---
title: Authentication failed
description: MongoDB refused the user name and password of the connection string.
---

**Diagnostic:** `MongoDB rejected the credentials`

## Fix

- Check the user name and the password. Characters such as `@`, `:`, `/` and `%` must be percent encoded in
  the connection string.
- Check `authSource`: a user created in the `admin` database needs `authSource=admin` when the connection
  string names another database.
- On Atlas, check that the database user exists in the project and that its password was not rotated.
