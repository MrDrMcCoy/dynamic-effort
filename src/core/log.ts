// Minimal leveled logger. Debug output goes to stderr and a file; anything
// else stays out of the harness's stdout.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface LoggerOptions {
  readonly debug: boolean;
  /** Appended to; omitted keeps file logging off. */
  readonly file?: string;
  /** Overrides the sink, for tests. */
  readonly sink?: (line: string) => void;
}

const PREFIX = "[dynamic-effort]";

function format(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` ${detail.message}`;
  if (typeof detail === "string") return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const write = (level: LogLevel, message: string, detail?: unknown) => {
    const time = new Date().toISOString();
    const line = `${time} ${level} ${PREFIX} ${message}${format(detail)}`;
    if (options.sink) {
      options.sink(line);
      return;
    }
    if (level === "debug" && !options.debug) return;
    if (level !== "debug") console.error(line);
    if (!options.file) return;
    try {
      mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
      appendFileSync(options.file, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break a decision.
    }
  };

  return {
    debug: (message, detail) => write("debug", message, detail),
    info: (message, detail) => write("info", message, detail),
    warn: (message, detail) => write("warn", message, detail),
    error: (message, detail) => write("error", message, detail),
  };
}

/** A logger that drops everything; the default when nothing is configured. */
export const NULL_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
