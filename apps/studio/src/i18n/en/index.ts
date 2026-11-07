import { api } from "./api.ts"
import { auth } from "./auth.ts"
import { common } from "./common.ts"
import { data } from "./data.ts"
import { doctor } from "./doctor.ts"
import { logs } from "./logs.ts"
import { overview } from "./overview.ts"
import { policies } from "./policies.ts"
import { realtime } from "./realtime.ts"
import { session } from "./session.ts"
import { settings } from "./settings.ts"
import { setup } from "./setup.ts"
import { shell } from "./shell.ts"

/** The English catalog. Each area owns one file. */
export const en = {
  api,
  auth,
  common,
  data,
  doctor,
  logs,
  overview,
  policies,
  realtime,
  session,
  settings,
  setup,
  shell,
} as const
