// Local telemetry: what was decided, what was applied, and what it cost.
//
// The buffer is a fixed-size ring in memory. Nothing is written to disk
// unless persistence is enabled, and nothing ever leaves the machine.
// This is the raw material for tuning the question wording and thresholds.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import type { EffortLevel } from "./effort.ts";
import { NULL_LOGGER, type Logger } from "./log.ts";

/** Token counts for one session, cumulative as the harness reports them. */
export interface UsageSnapshot {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** What an adapter knows when it applies a decision. */
export interface TelemetryInput {
  readonly session: string;
  /** Adapter-specific; "unknown" when the harness does not report one. */
  readonly agent?: string;
  readonly model?: string;
  readonly effort: EffortLevel;
  readonly variant?: string;
  readonly applied: boolean;
  readonly choice?: string;
  readonly confidence?: number;
  readonly highStakes?: number;
  readonly keyword?: string;
  readonly source: string;
  readonly promptHash?: string;
  /** Prompt text, truncated to the configured length. */
  readonly prompt?: string;
}

/** One stored decision. Immutable once handed out. */
export interface TelemetryEntry {
  readonly at: string;
  readonly session: string;
  readonly agent?: string;
  readonly model?: string;
  readonly effort: EffortLevel;
  readonly variant?: string;
  readonly applied: boolean;
  readonly choice?: string;
  readonly confidence?: number;
  readonly highStakes?: number;
  readonly keyword?: string;
  readonly source: string;
  readonly promptHash?: string;
  readonly prompt?: string;
  readonly usage?: UsageSnapshot;
}

export const DEFAULT_TELEMETRY_CAPACITY = 500;
export const DEFAULT_TELEMETRY_PROMPT_CHARS = 500;
/** Size after which the persisted file is rotated once, then replaced. */
export const DEFAULT_TELEMETRY_MAX_BYTES = 5 * 1024 * 1024;

export interface TelemetryOptions {
  readonly capacity?: number;
  readonly promptChars?: number;
  readonly logger?: Logger;
}

interface MutableEntry {
  at: string;
  session: string;
  agent?: string;
  model?: string;
  effort: EffortLevel;
  variant?: string;
  applied: boolean;
  choice?: string;
  confidence?: number;
  highStakes?: number;
  keyword?: string;
  source: string;
  promptHash?: string;
  prompt?: string;
  usage?: UsageSnapshot;
}

/**
 * A fixed-size ring of recent decisions. The oldest entry is dropped when
 * the ring is full, so memory use stays constant for a long session.
 */
export class TelemetryBuffer {
  private readonly entries: MutableEntry[] = [];
  private readonly capacity: number;
  private readonly promptChars: number;
  private readonly logger: Logger;

  constructor(options: TelemetryOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_TELEMETRY_CAPACITY);
    this.promptChars = Math.max(
      0,
      options.promptChars ?? DEFAULT_TELEMETRY_PROMPT_CHARS,
    );
    this.logger = options.logger ?? NULL_LOGGER;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Records one decision, dropping the oldest entry when full. */
  append(input: TelemetryInput): TelemetryEntry {
    const entry: MutableEntry = {
      at: new Date().toISOString(),
      ...input,
      prompt: this.truncate(input.prompt),
    };
    if (this.entries.length >= this.capacity) this.entries.shift();
    this.entries.push(entry);
    return { ...entry };
  }

  /**
   * Attaches the latest token counts to the newest entry for a session.
   * Usage arrives after the request, so the entry already exists.
   */
  stampUsage(session: string, usage: UsageSnapshot): boolean {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry?.session === session) {
        entry.usage = usage;
        return true;
      }
    }
    return false;
  }

  /** Oldest first, as plain copies. */
  snapshot(): TelemetryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Appends the buffer to a JSON Lines file. A failure is logged and
   * swallowed: telemetry must never break a decision or a shutdown.
   */
  persist(file: string, maxBytes = DEFAULT_TELEMETRY_MAX_BYTES): number {
    const entries = this.snapshot();
    if (entries.length === 0) return 0;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      rotateIfLarge(file, maxBytes);
      const lines = entries.map((entry) => JSON.stringify(entry));
      appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
      return entries.length;
    } catch (error) {
      this.logger.debug("telemetry persist failed", error);
      return 0;
    }
  }

  private truncate(prompt: string | undefined): string | undefined {
    if (!prompt) return undefined;
    if (this.promptChars === 0) return undefined;
    // The tail carries the actual ask more often than the opening does.
    return prompt.length <= this.promptChars
      ? prompt
      : prompt.slice(-this.promptChars);
  }
}

/** Renames the file once when it outgrows the limit, replacing the old one. */
function rotateIfLarge(file: string, maxBytes: number): void {
  if (!existsSync(file)) return;
  try {
    if (statSync(file).size < maxBytes) return;
    renameSync(file, `${file}.1`);
  } catch {
    // A missing or locked file is not worth failing the append over.
  }
}

/** Reads persisted entries, skipping lines that do not parse. */
export function readTelemetry(file: string): TelemetryEntry[] {
  if (!existsSync(file)) return [];
  const entries: TelemetryEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TelemetryEntry;
      if (
        typeof parsed?.at === "string" &&
        typeof parsed?.session === "string"
      ) {
        entries.push(parsed);
      }
    } catch {
      // A partial line from a crash is not worth reporting.
    }
  }
  return entries;
}
