/** The logger built in auth writes to, compatible with pino and Canopy's realtime logger. */
export interface AuthLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void
  error(fields: Readonly<Record<string, unknown>>, message: string): void
}

/** Discards everything. */
export const silentAuthLogger: AuthLogger = {
  warn() {},
  error() {},
}
