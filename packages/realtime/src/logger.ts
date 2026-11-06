/** A pino compatible logger. Only the methods Canopy calls are required. */
export interface Logger {
  debug(object: Record<string, unknown>, message?: string): void
  info(object: Record<string, unknown>, message?: string): void
  warn(object: Record<string, unknown>, message?: string): void
  error(object: Record<string, unknown>, message?: string): void
}

const noop = (): void => {}

/** A logger that discards everything. */
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop }

const SECRET_KEYS = /^(?:authorization|apikey|api_key|token|key|password|secret|cookie)$/i

/** Replaces values under secret looking keys, so tokens and keys never reach logs. */
export function redact(object: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(object)) {
    if (SECRET_KEYS.test(name)) out[name] = '[redacted]'
    else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Error)
    ) {
      out[name] = redact(value as Record<string, unknown>)
    } else out[name] = value
  }
  return out
}

/** Wraps a logger so every object is redacted first. */
export function redacting(logger: Logger): Logger {
  return {
    debug: (object, message) => logger.debug(redact(object), message),
    info: (object, message) => logger.info(redact(object), message),
    warn: (object, message) => logger.warn(redact(object), message),
    error: (object, message) => logger.error(redact(object), message),
  }
}
