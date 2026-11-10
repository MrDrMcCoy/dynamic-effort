// The `/effort-tune` command: hand the recorded decisions to the main model
// and keep its proposal on disk. Applying it stays manual.

import { join } from "node:path";
import type { EffortConfig } from "../core/config.ts";
import type { Logger } from "../core/log.ts";
import { readTelemetry, type TelemetryBuffer } from "../core/telemetry.ts";
import type { TelemetryEntry } from "../core/telemetry.ts";
import {
  buildTuningPrompt,
  describeProposal,
  parseTuningProposal,
  readLatestProposal,
  writeTuningProposal,
} from "../core/tune.ts";

/** What the tuner needs from the harness; narrow so tests can fake it. */
export interface TuneHarness {
  readonly config: EffortConfig;
  readonly logger: Logger;
  readonly telemetry: TelemetryBuffer;
  readonly telemetryPath: string;
  /** Where proposals are written. */
  readonly directory: string;
  /** Runs one prompt on the main model, stateless. */
  generate(prompt: string, sessionID: string): Promise<string>;
  /** Shows text in the session without starting a model turn. */
  report(sessionID: string, text: string): Promise<void>;
}

export const TUNE_COMMAND = "effort-tune";

/** Merges the persisted file with the live buffer, oldest first. */
export function collectEntries(
  telemetry: TelemetryBuffer,
  telemetryPath: string,
): TelemetryEntry[] {
  const merged = new Map<string, TelemetryEntry>();
  const key = (entry: TelemetryEntry) =>
    `${entry.at}|${entry.session}|${entry.promptHash ?? ""}`;
  for (const entry of readTelemetry(telemetryPath)) {
    merged.set(key(entry), entry);
  }
  for (const entry of telemetry.snapshot()) {
    merged.set(key(entry), entry);
  }
  return [...merged.values()].sort((left, right) =>
    left.at.localeCompare(right.at),
  );
}

export interface TuneOutcome {
  readonly entries: number;
  /** The proposal file, or null when nothing was written. */
  readonly file: string | null;
  /** Lines shown to the user. */
  readonly lines: readonly string[];
}

/** Reviews the recorded decisions once and stores the proposal. */
export async function runTune(
  harness: TuneHarness,
  sessionID: string,
): Promise<TuneOutcome> {
  const entries = collectEntries(harness.telemetry, harness.telemetryPath);
  if (entries.length === 0) {
    return {
      entries: 0,
      file: null,
      lines: [
        "No decisions recorded yet. Set telemetryPersist to keep them",
        "across sessions; the live buffer only covers this process.",
      ],
    };
  }

  const prompt = buildTuningPrompt(entries, harness.config);
  const answer = await harness.generate(prompt, sessionID);
  const proposal = parseTuningProposal(answer);
  const file = writeTuningProposal(
    harness.directory,
    proposal,
    entries.length,
  );
  harness.logger.debug("tuning proposal written", {
    file,
    entries: entries.length,
  });
  return {
    entries: entries.length,
    file,
    lines: [
      `Reviewed ${entries.length} decisions.`,
      ...describeProposal(proposal, harness.config),
      `Proposal: ${file}`,
    ],
  };
}

/** Runs the command and reports the result in the session. */
export async function executeTune(
  harness: TuneHarness,
  sessionID: string,
): Promise<void> {
  try {
    const outcome = await runTune(harness, sessionID);
    await harness.report(sessionID, outcome.lines.join("\n"));
  } catch (error) {
    harness.logger.debug("tuning failed", error);
    const message = error instanceof Error ? error.message : String(error);
    await harness.report(sessionID, `Effort tuning failed: ${message}`);
  }
}

/** The proposal directory under the cache root. */
export function tuneDirectory(root: string): string {
  return join(root, "tune");
}

export { readLatestProposal };
