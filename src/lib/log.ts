// Minimal logger contract used by services. Both `pino.Logger` and
// `FastifyBaseLogger` are structurally compatible with this interface,
// so callers can pass either without a cast.

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
